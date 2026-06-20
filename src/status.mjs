import os from 'node:os';
import { randomUUID } from 'node:crypto';

// 解析當前 session_id（MCP server 啟動後繼承 parent env）
export function resolveSessionId() {
    return process.env.CLAUDE_CODE_SESSION_ID      // CC
        || process.env.ANTIGRAVITY_CONVERSATION_ID  // AGY
        || process.env.AGENT_SESSION_ID             // 通用
        || `${os.hostname()}-${process.pid}`;       // fallback
}

// 查詢 session 是否已有 registration
// 回傳 { agent_id, role, session_id } | null
export function getRegistration(db, sessionId) {
    return db.prepare(
        'SELECT agent_id, role, session_id FROM agents WHERE session_id = ?'
    ).get(sessionId) || null;
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
// 若 agent_id 衝突（不同 session），呼叫者自行決定是否繼續
// 回傳 { success, agent_id, role, session_id, previous?, orphans_notified? }
export function registerAgent(db, sessionId, agentId, role) {
    const existing = getRegistration(db, sessionId);
    const previousAgentId = existing?.agent_id || null;
    const previousRole = existing?.role || null;

    let orphansNotified = 0;

    // 若 agent_id 有變，處理孤兒訊息
    if (previousAgentId && previousAgentId !== agentId) {
        orphansNotified = handleOrphanedMessages(db, previousAgentId, agentId);
    }

    const now = `datetime('now','localtime')`;

    if (existing) {
        // UPDATE existing session
        db.prepare(
            `UPDATE agents
             SET agent_id = ?, role = ?, updated_at = datetime('now','localtime')
             WHERE session_id = ?`
        ).run(agentId, role || null, sessionId);
    } else {
        // INSERT new registration
        // agents 表以 agent_id 為 PRIMARY KEY，但我們希望以 session_id 為主鍵做 upsert
        // 先嘗試 INSERT，若 agent_id 已存在（同 agent_id 不同 session）則會被 conflict check 擋掉
        // 此函式呼叫前已由 findAgentIdConflict 確認無衝突
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
