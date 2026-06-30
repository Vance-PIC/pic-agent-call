import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { readAgentSettings } from './db.mjs';

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

// 查詢 session 是否已有 registration（單一，向下相容）
// 回傳 { agent_id, role, session_id } | null
export function getRegistration(db, sessionId) {
    return getRegistrations(db, sessionId)[0] ?? null;
}

// v1.2.0 No Jitter：固定依 created_at ASC 排列，▶ 僅標示 active 位置不移動順序
export function getRegistrations(db, sessionId) {
    return db.prepare(
        `SELECT agent_id, role, session_id, term_key, status, last_seen FROM agents WHERE session_id = ? AND status IN ('active','attached') ORDER BY created_at ASC`
    ).all(sessionId);
}

export function getRegistrationsByTermKey(db, termKey) {
    return db.prepare(
        `SELECT agent_id, role, session_id, term_key, status, last_seen FROM agents WHERE term_key = ? AND status IN ('active','attached') ORDER BY created_at ASC`
    ).all(termKey);
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

// 解析多角色字串 → [{ agentId, role }]
// 輸入：agentId="PJM、PDM、SA" 或 "AGY-PJM,AGY-PDM"
// sessionId 用於決定平台前綴（CC- 或 AGY-）
function _parseAgentIds(rawAgentId, sessionId) {
    const isCc  = sessionId && process.env.CLAUDE_CODE_SESSION_ID === sessionId;
    const isAgy = sessionId && process.env.ANTIGRAVITY_CONVERSATION_ID === sessionId;
    // fallback：isCc/isAgy 均 false（MCP context）時，無 CC session ID 才推 AGY-
    const prefix = isAgy ? 'AGY-' : (isCc ? 'CC-' : (!process.env.CLAUDE_CODE_SESSION_ID ? 'AGY-' : 'CC-'));

    const parts = rawAgentId.split(/[,，、;；\/\+\s]+/).map(s => s.trim()).filter(Boolean);
    return parts.map(part => {
        const upper = part.toUpperCase();
        const hasPrefix = upper.startsWith('CC-') || upper.startsWith('AGY-');
        const fullId = hasPrefix ? part : `${prefix}${part}`;
        const role = hasPrefix ? part.replace(/^(?:CC-|AGY-)/i, '') : part;
        return { agentId: fullId, role };
    });
}

// Upsert agent registration
// v1.1.0：支援多角色解析（逗號/頓號/分須/斜線/空格分隔）
// v1.1.2：加 termKey 參數，寫入 agents.term_key（傳入 WT_SESSION，跨 session 重啟穩定）
// v1.1.3：三道防線 upsert — 一道:resume(換視窗), 二道:同視窗新session, 三道:INSERT或衝突
// v1.1.4：三態模型（active/attached/offline），移除 is_primary
// 回傳 { success, registered_agents, session_id, forced, term_key, orphans_notified? }
export function registerAgent(db, sessionId, agentId, role, forced = false, termKey = null) {
    const parsed = _parseAgentIds(agentId, sessionId);

    let totalOrphans = 0;
    const registeredAgents = [];

    const resolvedTermKey = termKey || '';
    // 視窗轉移：同 term_key 下舊 session 整批設為 offline
    if (resolvedTermKey) {
        db.prepare(
            `UPDATE agents SET status = 'offline', updated_at = datetime('now','localtime')
             WHERE term_key = ? AND session_id != ?`
        ).run(resolvedTermKey, sessionId);
    }
    // forced 模式才釋放 active 鎖，讓新名單第一個搶 active；非 forced 靠 hasActiveInSession 防重複
    if (forced) {
        db.prepare(
            `UPDATE agents SET status = 'attached', updated_at = datetime('now','localtime')
             WHERE session_id = ? AND status = 'active'`
        ).run(sessionId);
    }

    for (const { agentId: aid, role: derivedRole } of parsed) {
        const finalRole = (parsed.length === 1 && role) ? role : derivedRole;
        const newStatus = registeredAgents.length === 0 ? 'active' : 'attached';

        if (forced) {
            // forced：孤兒訊息處理後強制更新（跳過三道防線衝突檢查）
            const oldRows = db.prepare(
                `SELECT agent_id, term_key FROM agents WHERE agent_id = ? AND session_id != ?`
            ).all(aid, sessionId);
            for (const { agent_id: oldId, term_key: oldTermKey } of oldRows) {
                // 只有跨視窗強奪（term_key 不同）才孤兒化；同視窗重啟保留訊息
                if (oldTermKey && termKey && oldTermKey === termKey) continue;
                totalOrphans += handleOrphanedMessages(db, oldId, aid);
            }
            db.prepare(
                `DELETE FROM agents WHERE agent_id = ? AND session_id != ?`
            ).run(aid, sessionId);

            db.prepare(
                `INSERT INTO agents (agent_id, role, session_id, term_key, last_seen, status, created_at, updated_at)
                 VALUES (?, ?, ?, ?, datetime('now','localtime'), ?, datetime('now','localtime'), datetime('now','localtime'))
                 ON CONFLICT(agent_id) DO UPDATE SET
                     role = excluded.role,
                     session_id = excluded.session_id,
                     term_key = excluded.term_key,
                     last_seen = excluded.last_seen,
                     status = excluded.status,
                     updated_at = excluded.updated_at`
            ).run(aid, finalRole || null, sessionId, resolvedTermKey, newStatus);

            registeredAgents.push({ agent_id: aid, role: finalRole || null });
            continue;
        }

        // 一道防線：DB 中已有 agent_id = aid AND session_id = sessionId → resume（換視窗）
        const fence1 = db.prepare(
            `SELECT agent_id FROM agents WHERE agent_id = ? AND session_id = ?`
        ).get(aid, sessionId);
        if (fence1) {
            db.prepare(
                `UPDATE agents SET
                     role = ?,
                     term_key = ?,
                     last_seen = datetime('now','localtime'),
                     status = ?,
                     updated_at = datetime('now','localtime')
                 WHERE agent_id = ? AND session_id = ?`
            ).run(finalRole || null, resolvedTermKey, newStatus, aid, sessionId);
            registeredAgents.push({ agent_id: aid, role: finalRole || null });
            continue;
        }

        // 二道防線：DB 中已有 agent_id = aid AND term_key = termKey（termKey 非 null）→ 同視窗新 session
        if (resolvedTermKey) {
            const fence2 = db.prepare(
                `SELECT agent_id FROM agents WHERE agent_id = ? AND term_key = ?`
            ).get(aid, resolvedTermKey);
            if (fence2) {
                db.prepare(
                    `UPDATE agents SET
                         role = ?,
                         session_id = ?,
                         last_seen = datetime('now','localtime'),
                         status = ?,
                         updated_at = datetime('now','localtime')
                     WHERE agent_id = ? AND term_key = ?`
                ).run(finalRole || null, sessionId, newStatus, aid, resolvedTermKey);
                registeredAgents.push({ agent_id: aid, role: finalRole || null });
                continue;
            }
        }

        // 三道防線：兩者均不命中 → INSERT；若有衝突（其他 session 占用），拋出衝突錯誤
        const conflict = findAgentIdConflict(db, aid, sessionId);
        if (conflict) {
            return {
                success: false,
                reason: `agent_id ${aid} already registered by session ${conflict.session_id}`,
                conflict,
                debug_sessionId: sessionId,
                debug_homedir: process.env.HOME || process.env.USERPROFILE || null,
            };
        }

        // 同 session 已有 active 時，新 INSERT 用 'attached'
        const hasActiveInSession = db.prepare(
            `SELECT 1 FROM agents WHERE session_id = ? AND status = 'active' LIMIT 1`
        ).get(sessionId);
        const insertStatus = hasActiveInSession ? 'attached' : newStatus;

        db.prepare(
            `INSERT INTO agents (agent_id, role, session_id, term_key, last_seen, status, updated_at)
             VALUES (?, ?, ?, ?, datetime('now','localtime'), ?, datetime('now','localtime'))`
        ).run(aid, finalRole || null, sessionId, resolvedTermKey, insertStatus);
        registeredAgents.push({ agent_id: aid, role: finalRole || null });
    }

    // §6.12.7: forced 時，同 session 不在新名單的殘留角色軟離線
    if (forced && parsed.length > 0) {
        const newIds = parsed.map(p => p.agentId);
        const placeholders = newIds.map(() => '?').join(',');
        db.prepare(
            `UPDATE agents SET status = 'offline', updated_at = datetime('now','localtime')
             WHERE session_id = ? AND agent_id NOT IN (${placeholders})`
        ).run(sessionId, ...newIds);
    }

    const result = {
        success: true,
        registered_agents: registeredAgents,
        session_id: sessionId,
        forced: forced,
        term_key: resolvedTermKey,
    };

    if (totalOrphans > 0) result.orphans_notified = totalOrphans;

    return result;
}

// 查詢 agent 狀態（給 statusline 用）
// v1.1.0 多角色：回傳 { agent_id, role, unread, display, registered_agents }
// display 格式：▶🔴1·CC-PG1  🟢0·CC-SA1
// primaryAgentId: 由 server.mjs 從快取讀出，標示 ▶
export function getAgentStatus(db, sessionId, primaryAgentId) {
    const regs = getRegistrations(db, sessionId);
    if (!regs || regs.length === 0) return null;

    const { statusLineFreshnessMin, historyPurgeMin } = readAgentSettings();
    const freshnessSec = statusLineFreshnessMin * 60;

    // 超時掃描與歷史清理：同步執行確保呼叫方立即可見最新狀態
    try {
        db.prepare(
            `UPDATE agents SET status = 'offline', updated_at = datetime('now','localtime')
             WHERE status IN ('active','attached') AND last_seen < datetime('now','localtime','-' || agent_timeout_sec || ' seconds')`
        ).run();
        db.prepare(
            `DELETE FROM agents WHERE status = 'offline' AND last_seen < datetime('now','localtime','-' || ? || ' minutes')`
        ).run(historyPurgeMin);
    } catch (_) {}

    // 心跳降頻：10s 內不重複更新 last_seen（fire-and-forget，不阻塞 statusline 輸出）
    const lastRow = db.prepare(
        `SELECT MAX(last_seen) as last_seen FROM agents WHERE session_id = ? AND status IN ('active','attached')`
    ).get(sessionId);
    const lastSeenMs = lastRow?.last_seen ? new Date(lastRow.last_seen).getTime() : 0;
    const staleSec = (Date.now() - lastSeenMs) / 1000;
    if (staleSec >= 10) {
        setImmediate(() => {
            try {
                db.prepare(
                    `UPDATE agents SET last_seen = datetime('now','localtime') WHERE session_id = ? AND status IN ('active','attached')`
                ).run(sessionId);
            } catch (_) {}
        });
    }

    // primaryAgentId 由外部傳入（server.mjs 讀快取），預設用第一個 active agent
    if (!primaryAgentId) {
        primaryAgentId = regs.find(r => r.status === 'active')?.agent_id ?? regs[0].agent_id;
    }

    // freshness 判定：以 active agent 的 last_seen 為基準
    const activeReg = regs.find(r => r.status === 'active');
    if (activeReg?.last_seen) {
        const ageSec = (Date.now() - new Date(activeReg.last_seen).getTime()) / 1000;
        if (ageSec > freshnessSec) return null;
    }

    const unreadStmt = db.prepare(
        `SELECT COUNT(*) as count FROM agent_collaboration_channel
         WHERE status = 'UNREAD' AND (receiver = ? OR receiver = ? OR receiver = 'any')`
    );
    const unreadNoPoolStmt = db.prepare(
        `SELECT COUNT(*) as count FROM agent_collaboration_channel
         WHERE status = 'UNREAD' AND (receiver = ? OR receiver = 'any')`
    );

    const registeredAgents = [];
    let totalUnread = 0;
    const parts = [];

    // No Jitter：regs 已依 created_at ASC 排列，不重新排序
    for (const { agent_id, role } of regs) {
        let row;
        if (role) {
            row = unreadStmt.get(agent_id, `${role}?`);
        } else {
            row = unreadNoPoolStmt.get(agent_id);
        }
        const unread = row?.count || 0;
        totalUnread += unread;

        const isPrimary = agent_id === primaryAgentId;
        const dot = unread > 0 ? '🔴' : '🟢';
        const prefix = isPrimary ? '\x1b[33m▶\x1b[0m' : '';
        parts.push(`${prefix}${dot}${unread}·${agent_id}`);

        registeredAgents.push({ agent_id, role: role || null, unread });
    }

    const display = parts.join('  ');
    const primary = regs.find(r => r.agent_id === primaryAgentId) ?? regs[0];

    return {
        agent_id: primary.agent_id,
        role: primary.role || null,
        unread: totalUnread,
        display,
        registered_agents: registeredAgents,
    };
}

// 心跳：更新 active/attached 角色的 last_seen，並淘汰超時與歷史殘留
export function heartbeat(db, sessionId) {
    const { historyPurgeMin } = readAgentSettings();
    db.prepare(
        `UPDATE agents SET last_seen = datetime('now','localtime')
         WHERE session_id = ? AND status IN ('active','attached')`
    ).run(sessionId);
    db.prepare(
        `UPDATE agents SET status = 'offline', updated_at = datetime('now','localtime')
         WHERE status IN ('active','attached')
           AND last_seen < datetime('now','localtime','-' || agent_timeout_sec || ' seconds')`
    ).run();
    db.prepare(
        `DELETE FROM agents WHERE status = 'offline'
           AND last_seen < datetime('now','localtime','-' || ? || ' minutes')`
    ).run(historyPurgeMin);
}

// 查詢同平台所有已註冊 agent 的未讀數（供多角色並列狀態列用）
// platformPrefix: 'CC-' | 'AGY-'
export function getAgentsByPlatformStatus(db, platformPrefix) {
    const agents = db.prepare(
        `SELECT agent_id, role, status FROM agents WHERE agent_id LIKE ?`
    ).all(`${platformPrefix}%`);

    const withPoolStmt = db.prepare(
        `SELECT COUNT(*) as count FROM agent_collaboration_channel
         WHERE status = 'UNREAD' AND (receiver = ? OR receiver = ? OR receiver = 'any')`
    );
    const noPoolStmt = db.prepare(
        `SELECT COUNT(*) as count FROM agent_collaboration_channel
         WHERE status = 'UNREAD' AND (receiver = ? OR receiver = 'any')`
    );

    return agents.map(({ agent_id, role, status }) => {
        const pool = role ? `${role}?` : null;
        const row = pool
            ? withPoolStmt.get(agent_id, pool)
            : noPoolStmt.get(agent_id);
        return { agent_id, role: role || null, status, unread: row?.count || 0 };
    });
}
