import { randomUUID } from 'node:crypto';
import { withRetry } from './db.mjs';
import { getRegistrations, getRegistrationsByTermKey } from './status.mjs';

// 內部：直查 DB 確認 agent_id 是否活躍（去 session 化，v1.2.2）
function _isActiveAgent(db, agentId) {
    const row = db.prepare(
        `SELECT 1 FROM agents WHERE agent_id = ? AND status IN ('active','attached') LIMIT 1`
    ).get(agentId);
    return !!row;
}

// 多態解析 target → 活躍角色清單（v1.2.2）；供 server.mjs channel_send 防偽造使用
export function _resolveRegsByTarget(db, target) {
    if (!target) return [];
    // 嘗試 agent_id（含多角色）
    const ids = target.split(/[,，、;；\/\+\s]+/).map(s => s.trim()).filter(Boolean);
    if (ids.length > 0) {
        const placeholders = ids.map(() => '?').join(',');
        const rows = db.prepare(
            `SELECT agent_id, role, session_id, term_key, status FROM agents
             WHERE agent_id IN (${placeholders}) AND status IN ('active','attached')
             ORDER BY created_at ASC`
        ).all(...ids);
        if (rows.length > 0) return rows;
    }
    // 嘗試 term_key
    const byTermKey = getRegistrationsByTermKey(db, target);
    if (byTermKey.length > 0) return byTermKey;
    // 嘗試 session_id
    return getRegistrations(db, target) || [];
}

// v1.1.0 sendMessage / v1.2.2 去 Session 化：直查 DB 驗證 sender 活躍狀態
// receiver === 'all': 廣播，對每個活躍 agent（排除 sender）各寫一筆
// receiver === 'any': 先搶先得，寫單筆 receiver='any'
// 其他: 直接寫指定 receiver
export async function sendMessage(db, receiver, message, sender, priority) {
    // 安全驗證：非 SYSTEM sender 直查 DB 確認活躍狀態
    if (sender !== 'SYSTEM') {
        if (!_isActiveAgent(db, sender)) {
            throw Object.assign(new Error(`401: sender "${sender}" 未登記為活躍 Agent，請先呼叫 register_agent`), { code: 'ERR_UNAUTHORIZED' });
        }
    }

    const p = Number(priority) || 5;
    const insertOne = (recv, msgId) => db.prepare(
        `INSERT INTO agent_collaboration_channel (message_id, sender, receiver, priority, message) VALUES (?, ?, ?, ?, ?)`
    ).run(msgId, sender, recv, p, message);

    if (receiver === 'all') {
        // 廣播：SELECT + INSERT 在同一 transaction，防止 agent 在兩者之間變更
        const ids = [];
        await withRetry(() => {
            db.exec('BEGIN IMMEDIATE');
            try {
                const allAgents = db.prepare(
                    `SELECT agent_id FROM agents WHERE status = 'active' AND agent_id != ?`
                ).all(sender);
                if (allAgents.length === 0) {
                    db.exec('ROLLBACK');
                    return;
                }
                for (const { agent_id } of allAgents) {
                    const msgId = `msg-${randomUUID()}`;
                    insertOne(agent_id, msgId);
                    ids.push(msgId);
                }
                db.exec('COMMIT');
            } catch (err) {
                try { db.exec('ROLLBACK'); } catch (_) {}
                throw err;
            }
        });
        if (ids.length === 0) return { message_id: null, status: 'NO_ACTIVE_RECEIVERS', count: 0 };
        return { message_id: ids[0], status: 'UNREAD', count: ids.length, message_ids: ids };
    }

    // any 或具體 receiver
    const msgId = `msg-${randomUUID()}`;
    await withRetry(() => {
        insertOne(receiver, msgId);
    });
    return { message_id: msgId, status: 'UNREAD' };
}

// v1.1.0 listUnread / v1.2.2：target 必填多態解析，移除 sessionId 依賴
// - 若指定 receiver，需在 target 解析的活躍角色名單中，否則拋出 403
// - 若 receiver null 或 'all'，列出名單所有角色的未讀聯集（含 any）
export function listUnread(db, receiver, target) {
    // 釋放超時的 IN_PROGRESS
    db.exec('BEGIN IMMEDIATE');
    try {
        db.prepare(
            `UPDATE agent_collaboration_channel
             SET status = 'UNREAD', lock_owner = NULL, lock_time = NULL, updated_at = datetime('now','localtime')
             WHERE status = 'IN_PROGRESS' AND lock_time < datetime('now','localtime','-15 minutes')`
        ).run();
        db.exec('COMMIT');
    } catch (_) {
        try { db.exec('ROLLBACK'); } catch (__) {}
    }

    const regs = _resolveRegsByTarget(db, target);

    if (!receiver || receiver === 'all') {
        if (!regs || regs.length === 0) return { messages: [], count: 0 };

        const agentIds = regs.map(r => r.agent_id);
        const roles    = regs.map(r => r.role).filter(Boolean).map(r => `${r}?`);
        const params   = [...agentIds, ...roles, 'any'];
        const inList   = params.map(() => '?').join(',');

        const rows = db.prepare(
            `SELECT * FROM agent_collaboration_channel
             WHERE status = 'UNREAD' AND receiver IN (${inList})
             ORDER BY priority DESC, created_at ASC`
        ).all(...params);
        return { messages: rows, count: rows.length };
    }

    // 指定 receiver：橫向越權檢驗
    // target 解析不到任何活躍角色時直接拒絕，防止空 target 繞過授權
    if (!regs || regs.length === 0) {
        throw Object.assign(
            new Error(`403: target 解析不到任何活躍角色，禁止查詢 receiver "${receiver}"`),
            { code: 'ERR_FORBIDDEN' }
        );
    }
    const agentIds = regs.map(r => r.agent_id);
    const pools    = regs.map(r => r.role).filter(Boolean).map(r => `${r}?`);
    const allowed  = new Set([...agentIds, ...pools]);
    if (!allowed.has(receiver)) {
        throw Object.assign(
            new Error(`403: receiver "${receiver}" 不屬於 target 解析的活躍角色，禁止越權查詢`),
            { code: 'ERR_FORBIDDEN' }
        );
    }

    let rows;
    if (receiver.endsWith('?')) {
        rows = db.prepare(
            `SELECT * FROM agent_collaboration_channel
             WHERE status = 'UNREAD' AND (receiver = ? OR receiver = 'any')
             ORDER BY priority DESC, created_at ASC`
        ).all(receiver);
    } else {
        const reg = regs?.find(r => r.agent_id === receiver);
        const pool = reg?.role ? `${reg.role}?` : null;
        if (pool) {
            rows = db.prepare(
                `SELECT * FROM agent_collaboration_channel
                 WHERE status = 'UNREAD' AND (receiver = ? OR receiver = ? OR receiver = 'any')
                 ORDER BY priority DESC, created_at ASC`
            ).all(receiver, pool);
        } else {
            rows = db.prepare(
                `SELECT * FROM agent_collaboration_channel
                 WHERE status = 'UNREAD' AND (receiver = ? OR receiver = 'any')
                 ORDER BY priority DESC, created_at ASC`
            ).all(receiver);
        }
    }
    return { messages: rows, count: rows.length };
}

// v1.1.0 claimMessage / v1.2.2 去 Session 化：直查 DB 驗證 agent_id 活躍狀態
// - agent_id 直查 DB 確認活躍（不比對 session_id）
// - 訊息 receiver 須為該 agent_id / role? / 'any'
export function claimMessage(db, message_id, agent_id) {
    // 直查 DB 確認 agent_id 活躍
    if (!_isActiveAgent(db, agent_id)) {
        return { success: false, reason: `403: agent_id "${agent_id}" 未登記為活躍 Agent` };
    }

    const agentRow = db.prepare(
        `SELECT role FROM agents WHERE agent_id = ? AND status IN ('active','attached') LIMIT 1`
    ).get(agent_id);
    const regs = agentRow ? [{ agent_id, role: agentRow.role }] : [];

    db.exec('BEGIN IMMEDIATE');
    try {
        const row = db.prepare(
            `SELECT status, lock_owner, receiver FROM agent_collaboration_channel WHERE message_id = ?`
        ).get(message_id);
        if (!row) { db.exec('ROLLBACK'); return { success: false, reason: 'message not found' }; }
        if (row.status !== 'UNREAD') {
            db.exec('ROLLBACK');
            return { success: false, reason: `already ${row.status} by ${row.lock_owner || 'unknown'}` };
        }

        // 訊息接收者須為該 agent_id / role? / 'any'
        const reg = regs?.find(r => r.agent_id === agent_id);
        const pool = reg?.role ? `${reg.role}?` : null;
        const allowed = new Set([agent_id, 'any']);
        if (pool) allowed.add(pool);
        if (!allowed.has(row.receiver)) {
            db.exec('ROLLBACK');
            return { success: false, reason: `403: 訊息 receiver "${row.receiver}" 不屬於 agent_id "${agent_id}" 的授權範圍` };
        }

        db.prepare(
            `UPDATE agent_collaboration_channel
             SET status='IN_PROGRESS', lock_owner=?, lock_time=datetime('now','localtime'), updated_at=datetime('now','localtime')
             WHERE message_id=? AND status='UNREAD' AND lock_owner IS NULL`
        ).run(agent_id, message_id);
        const updated = db.prepare(
            `SELECT lock_owner FROM agent_collaboration_channel WHERE message_id = ?`
        ).get(message_id);
        db.exec('COMMIT');
        if (updated.lock_owner === agent_id) return { success: true, message_id };
        return { success: false, reason: 'race: claimed by another agent' };
    } catch (err) {
        try { db.exec('ROLLBACK'); } catch (_) {}
        return { success: false, reason: err.message };
    }
}

// v1.1.0 ackMessage / v1.2.2 去 Session 化：直查 DB 驗證 agent_id 活躍狀態且為搶鎖者
export function ackMessage(db, message_id, agent_id) {
    if (!_isActiveAgent(db, agent_id)) {
        return { success: false, reason: `403: agent_id "${agent_id}" 未登記為活躍 Agent` };
    }

    db.exec('BEGIN IMMEDIATE');
    try {
        const row = db.prepare(
            `SELECT status, lock_owner FROM agent_collaboration_channel WHERE message_id = ?`
        ).get(message_id);
        if (!row) { db.exec('ROLLBACK'); return { success: false, reason: 'message not found' }; }
        if (row.status !== 'IN_PROGRESS' || row.lock_owner !== agent_id) {
            db.exec('ROLLBACK');
            return { success: false, reason: `not owned: status=${row.status} owner=${row.lock_owner}` };
        }
        db.prepare(
            `UPDATE agent_collaboration_channel SET status='READ', updated_at=datetime('now','localtime') WHERE message_id=?`
        ).run(message_id);
        db.exec('COMMIT');
        return { success: true, message_id };
    } catch (err) {
        try { db.exec('ROLLBACK'); } catch (_) {}
        return { success: false, reason: err.message };
    }
}
