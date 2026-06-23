import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

// 進程級快取：避免重複掃目錄
let _cachedAgyConvId = undefined;

function detectActiveAgyConversationId() {
    if (_cachedAgyConvId !== undefined) return _cachedAgyConvId;
    try {
        const brainDir = path.join(os.homedir(), '.gemini', 'antigravity-cli', 'brain');
        if (!fs.existsSync(brainDir)) { _cachedAgyConvId = null; return null; }
        const dirs = fs.readdirSync(brainDir);
        let latestDir = null;
        let latestTime = 0;
        for (const d of dirs) {
            if (d.length !== 36) continue;
            const dp = path.join(brainDir, d);
            const stat = fs.statSync(dp);
            if (stat.isDirectory()) {
                if (stat.mtimeMs > latestTime) {
                    latestTime = stat.mtimeMs;
                    latestDir = d;
                }
            }
        }
        _cachedAgyConvId = latestDir;
        return latestDir;
    } catch (_) {
        _cachedAgyConvId = null;
        return null;
    }
}

// 進程級 session ID 快取
let _cachedSessionId = undefined;

export function _resetSessionIdCache() {
    _cachedSessionId = undefined;
    _cachedAgyConvId = undefined;
}

// 解析當前 session_id（MCP server 啟動後繼承 parent env）
// callerType: 'cc' | 'agy' | null — 限制只查對應平台的 env var，避免跨 LLM 污染
export function resolveSessionId(callerType) {
    if (callerType === 'cc') {
        return process.env.CLAUDE_CODE_SESSION_ID
            || process.env.AGENT_SESSION_ID
            || `${os.hostname()}-${process.pid}`;
    }
    if (callerType === 'agy') {
        return process.env.ANTIGRAVITY_CONVERSATION_ID
            || detectActiveAgyConversationId()
            || process.env.AGENT_SESSION_ID
            || `${os.hostname()}-${process.pid}`;
    }
    // MCP server / 通用 context：快取結果避免重複解析
    if (_cachedSessionId !== undefined) return _cachedSessionId;
    _cachedSessionId = process.env.CLAUDE_CODE_SESSION_ID
        || process.env.ANTIGRAVITY_CONVERSATION_ID
        || detectActiveAgyConversationId()
        || process.env.AGENT_SESSION_ID
        || `${os.hostname()}-${process.pid}`;
    return _cachedSessionId;
}

// 查詢 session 是否已有 registration
// 回傳 { agent_id, role, session_id } | null
export function getRegistration(db, sessionId) {
    return db.prepare(
        'SELECT agent_id, role, session_id FROM agents WHERE session_id = ?'
    ).get(sessionId) || null;
}

// 用 agent_id 查詢 registration（給 statusline fallback 用）
export function getRegistrationByAgentId(db, agentId) {
    return db.prepare(
        'SELECT agent_id, role, session_id FROM agents WHERE agent_id = ?'
    ).get(agentId) || null;
}

// 查詢 agent_id 是否被其他 session 占用
// 回傳 { agent_id, session_id, role } | null
export function findAgentIdConflict(db, agentId, sessionId) {
    return db.prepare(
        'SELECT agent_id, session_id, role FROM agents WHERE agent_id = ? AND session_id != ?'
    ).get(agentId, sessionId) || null;
}

// 處理換角色時的孤兒訊息：
// 1. 找舊 agent_id 的所有 UNREAD 訊息
// 2. 對每個 sender 發送 channel 通知
// 3. 把孤兒訊息標記為 ORPHANED
// 回傳 orphan_count
export function handleOrphanedMessages(db, oldAgentId, newAgentId) {
    const orphans = db.prepare(
        `SELECT message_id, sender, message FROM agent_collaboration_channel
         WHERE receiver = ? AND status = 'UNREAD'`
    ).all(oldAgentId);

    if (orphans.length === 0) return 0;

    const insertNotify = db.prepare(
        `INSERT INTO agent_collaboration_channel
             (message_id, sender, receiver, priority, message, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, datetime('now','localtime'), datetime('now','localtime'))`
    );

    const markOrphaned = db.prepare(
        `UPDATE agent_collaboration_channel
         SET status = 'ORPHANED', updated_at = datetime('now','localtime')
         WHERE message_id = ?`
    );

    // 蒐集 sender 集合，每個 sender 只通知一次
    const notifiedSenders = new Set();

    db.exec('BEGIN IMMEDIATE');
    try {
        for (const row of orphans) {
            if (!notifiedSenders.has(row.sender)) {
                notifiedSenders.add(row.sender);
                const notifyMsgId = `msg-${randomUUID()}`;
                const notifyText = JSON.stringify({
                    type: 'ORPHAN_NOTICE',
                    original_receiver: oldAgentId,
                    new_agent_id: newAgentId,
                    message: `[系統] ${oldAgentId} 已重新登記為 ${newAgentId}，您傳送給 ${oldAgentId} 的訊息已成為孤兒訊息（ORPHANED），請重新傳送給 ${newAgentId}。`,
                });
                insertNotify.run(notifyMsgId, 'SYSTEM', row.sender, 8, notifyText);
            }
            markOrphaned.run(row.message_id);
        }
        db.exec('COMMIT');
    } catch (err) {
        try { db.exec('ROLLBACK'); } catch (_) {}
        throw err;
    }

    return orphans.length;
}

// Upsert agent registration
// forced=true 時強制覆寫舊 session 的 agent_id 記錄
// 回傳 { success, agent_id, role, session_id, forced?, previous?, orphans_notified? }
export function registerAgent(db, sessionId, agentId, role, forced = false) {
    const existing = getRegistration(db, sessionId);
    const previousAgentId = existing?.agent_id || null;
    const previousRole = existing?.role || null;

    let orphansNotified = 0;

    // 若 agent_id 有變，處理孤兒訊息
    if (previousAgentId && previousAgentId !== agentId) {
        orphansNotified = handleOrphanedMessages(db, previousAgentId, agentId);
    }

    if (forced) {
        // 強制接管：先刪除舊 session 殘留記錄，再 upsert 當前 session
        db.prepare(
            `DELETE FROM agents WHERE agent_id = ? AND session_id != ?`
        ).run(agentId, sessionId);
    }

    if (existing) {
        // UPDATE existing session
        db.prepare(
            `UPDATE agents
             SET agent_id = ?, role = ?, updated_at = datetime('now','localtime')
             WHERE session_id = ?`
        ).run(agentId, role || null, sessionId);
    } else {
        // INSERT new registration
        db.prepare(
            `INSERT INTO agents (agent_id, role, session_id, last_seen, status, updated_at)
             VALUES (?, ?, ?, datetime('now','localtime'), 'active', datetime('now','localtime'))
             ON CONFLICT(agent_id) DO UPDATE SET
                 role = excluded.role,
                 session_id = excluded.session_id,
                 last_seen = excluded.last_seen,
                 status = 'active',
                 updated_at = excluded.updated_at`
        ).run(agentId, role || null, sessionId);
    }

    const result = {
        success: true,
        agent_id: agentId,
        role: role || null,
        session_id: sessionId,
    };

    if (forced) {
        result.forced = true;
    }

    if (previousAgentId !== null) {
        result.previous = { agent_id: previousAgentId, role: previousRole };
    }

    if (orphansNotified > 0) {
        result.orphans_notified = orphansNotified;
    }

    return result;
}

// 查詢 agent 狀態（給 statusline 用）
// 回傳 { agent_id, role, unread, display }
// display 格式：[CC-PG1|PG] 📨3
export function getAgentStatus(db, sessionId) {
    const reg = getRegistration(db, sessionId);
    if (!reg) return null;

    const { agent_id, role } = reg;

    // heartbeat：更新自己的 last_seen
    db.prepare(
        `UPDATE agents SET last_seen = datetime('now','localtime'), updated_at = datetime('now','localtime') WHERE session_id = ?`
    ).run(sessionId);

    // 把超時的其他 agents 標為 offline
    db.prepare(
        `UPDATE agents SET status = 'offline', updated_at = datetime('now','localtime')
         WHERE session_id != ? AND status = 'active'
           AND last_seen < datetime('now','localtime','-' || agent_timeout_sec || ' seconds')`
    ).run(sessionId);

    let row;
    if (role) {
        const pool = `${role}?`;
        row = db.prepare(
            `SELECT COUNT(*) as count FROM agent_collaboration_channel
             WHERE status = 'UNREAD' AND (receiver = ? OR receiver = 'all' OR receiver = ?)`
        ).get(agent_id, pool);
    } else {
        row = db.prepare(
            `SELECT COUNT(*) as count FROM agent_collaboration_channel
             WHERE status = 'UNREAD' AND (receiver = ? OR receiver = 'all')`
        ).get(agent_id);
    }

    const unread = row?.count || 0;
    const roleLabel = role ? `|${role}` : '';
    const unreadLabel = unread > 0 ? ` 📨${unread}` : '';
    const display = `[${agent_id}${roleLabel}]${unreadLabel}`;

    return { agent_id, role: role || null, unread, display };
}

// 查詢同平台所有已註冊 agent 的未讀數（供多角色並列狀態列用）
// platformPrefix: 'CC-' | 'AGY-'
export function getAgentsByPlatformStatus(db, platformPrefix) {
    const agents = db.prepare(
        `SELECT agent_id, role, status FROM agents WHERE agent_id LIKE ?`
    ).all(`${platformPrefix}%`);

    return agents.map(({ agent_id, role, status }) => {
        const pool = role ? `${role}?` : null;
        let row;
        if (pool) {
            row = db.prepare(
                `SELECT COUNT(*) as count FROM agent_collaboration_channel
                 WHERE status = 'UNREAD' AND (receiver = ? OR receiver = ? OR receiver = 'all')`
            ).get(agent_id, pool);
        } else {
            row = db.prepare(
                `SELECT COUNT(*) as count FROM agent_collaboration_channel
                 WHERE status = 'UNREAD' AND (receiver = ? OR receiver = 'all')`
            ).get(agent_id);
        }
        return { agent_id, role: role || null, status, unread: row?.count || 0 };
    });
}

const PREFIXES = ['cc-', 'agy-'];
const MS_7D   = 7 * 24 * 60 * 60 * 1000;
const MS_24H  = 24 * 60 * 60 * 1000;
const MS_5M   = 5 * 60 * 1000;

// 清理 agent-sessions/ 過期快取檔
// 規則：各 prefix 保留最新一筆（fallback 用），其餘依三條件刪除
export function cleanExpiredAgentSessionCache(db, sessionDir) {
    try {
        if (!fs.existsSync(sessionDir)) return;

        const files = fs.readdirSync(sessionDir).filter(f => f.endsWith('.json'));
        const now = Date.now();

        // 各 prefix 找出最新 mtime（受保護，不刪）
        const newestByPrefix = {};
        for (const prefix of PREFIXES) {
            let newest = null, newestMtime = 0;
            for (const f of files) {
                if (!f.startsWith(prefix)) continue;
                const mt = fs.statSync(path.join(sessionDir, f)).mtimeMs;
                if (mt > newestMtime) { newestMtime = mt; newest = f; }
            }
            if (newest) newestByPrefix[prefix] = newest;
        }

        for (const f of files) {
            const prefix = PREFIXES.find(p => f.startsWith(p));
            if (!prefix) continue;

            // 保護各 prefix 最新一筆
            if (newestByPrefix[prefix] === f) continue;

            const fp = path.join(sessionDir, f);
            const mtime = fs.statSync(fp).mtimeMs;
            const age = now - mtime;

            // 條件一：超過 7 天
            if (age > MS_7D) { fs.unlinkSync(fp); continue; }

            // 取 term_key（檔名去 .json）查 DB
            const termKey = f.slice(0, -5);
            const dbRow = db.prepare(
                `SELECT status, last_seen FROM agents WHERE term_key = ?`
            ).get(termKey);

            // 條件二：DB 無紀錄（孤兒）且超過 5 分鐘
            if (!dbRow && age > MS_5M) { fs.unlinkSync(fp); continue; }

            // 條件三：DB offline 且 last_seen 超過 24 小時
            if (dbRow?.status === 'offline') {
                const lastSeenMs = dbRow.last_seen
                    ? new Date(dbRow.last_seen).getTime()
                    : mtime;
                if (now - lastSeenMs > MS_24H) { fs.unlinkSync(fp); continue; }
            }
        }
    } catch (_) {}
}
