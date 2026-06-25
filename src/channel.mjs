import { randomUUID } from 'node:crypto';
import { withRetry } from './db.mjs';
import { getRegistrations, getRegistrationsByTermKey, resolveSessionId } from './status.mjs';

// v1.1.0 sendMessage
// receiver === 'all': 廣播，對每個活躍 agent（排除 sender）各寫一筆
// receiver === 'any': 先搶先得，寫單筆 receiver='any'
// 其他: 直接寫指定 receiver
export async function sendMessage(db, receiver, message, sender, sessionId, priority) {
    // 安全驗證：非 SYSTEM sender 必須與 sessionId 的已登記角色之一吻合
    if (sender !== 'SYSTEM') {
        const sid = sessionId || resolveSessionId();
        const regs = getRegistrations(db, sid);
        if (!regs || regs.length === 0) {
            throw Object.assign(new Error('401: 此會話尚未登記為 Agent 身份，請先呼叫 register_agent'), { code: 'ERR_UNAUTHORIZED' });
        }
        const match = regs.find(r => r.agent_id === sender);
        if (!match) {
            throw Object.assign(new Error(`401: sender 不符，登記身份為 ${regs.map(r => r.agent_id).join('/')}`), { code: 'ERR_UNAUTHORIZED' });
        }
    }

    const p = Number(priority) || 5;
    const insertOne = (recv, msgId) => db.prepare(
        `INSERT INTO agent_collaboration_channel (message_id, sender, receiver, priority, message) VALUES (?, ?, ?, ?, ?)`
    ).run(msgId, sender, recv, p, message);

    if (receiver === 'all') {
        // 廣播：對所有 active agents（排除 sender）各寫一筆
        const allAgents = db.prepare(
            `SELECT agent_id FROM agents WHERE status = 'active' AND agent_id != ?`
        ).all(sender);

        if (allAgents.length === 0) {
            return { message_id: null, status: 'NO_ACTIVE_RECEIVERS', count: 0 };
        }

        const ids = [];
        await withRetry(() => {
            db.exec('BEGIN IMMEDIATE');
            try {
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
        return { message_id: ids[0], status: 'UNREAD', count: ids.length, message_ids: ids };
    }

    // any 或具體 receiver
    const msgId = `msg-${randomUUID()}`;
    await withRetry(() => {
        insertOne(receiver, msgId);
    });
    return { message_id: msgId, status: 'UNREAD' };
}

// v1.1.0 listUnread
// - 若指定 receiver，需與 sessionId 活躍角色（或其 role?）吻合
// - 若 receiver null 或 'all'，列出該 session 所有角色的未讀聯集（含 any）
export function listUnread(db, receiver, sessionId) {
    const sid = sessionId || resolveSessionId();

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

    const regs = getRegistrations(db, sid);

    if (!receiver || receiver === 'all') {
        // 列出該 session 所有角色未讀聯集（含 any）
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
    if (regs && regs.length > 0) {
        const agentIds = regs.map(r => r.agent_id);
        const pools    = regs.map(r => r.role).filter(Boolean).map(r => `${r}?`);
        const allowed  = new Set([...agentIds, ...pools]);
        if (!allowed.has(receiver)) {
            throw Object.assign(
                new Error(`403: receiver "${receiver}" 不屬於當前 session 的活躍角色，禁止越權查詢`),
                { code: 'ERR_FORBIDDEN' }
            );
        }
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

// v1.1.0 claimMessage
// - agent_id 必須與 sessionId 當前活躍角色吻合
// - 訊息 receiver 須為該 agent_id / role? / 'any'
export function claimMessage(db, message_id, agent_id, sessionId) {
    // 取得當前活躍主身份（DB term_key 查詢，fallback 至 sessionId）
    const wtSession = process.env.WT_SESSION;
    let primaryAgentId = null;
    if (wtSession) {
        const termRegs = getRegistrationsByTermKey(db, wtSession);
        if (termRegs && termRegs.length > 0) primaryAgentId = termRegs[0].agent_id;
    }
    if (!primaryAgentId) {
        const sid = sessionId || resolveSessionId();
        const regs = getRegistrations(db, sid);
        if (regs && regs.length > 0) primaryAgentId = regs[0].agent_id;
    }
    // 若有活躍主身份，agent_id 必須吻合
    if (primaryAgentId && agent_id !== primaryAgentId) {
        return { success: false, reason: `403: agent_id "${agent_id}" 與當前活躍角色 "${primaryAgentId}" 不符` };
    }

    const sid = sessionId || resolveSessionId();
    const regs = getRegistrations(db, sid);

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

// v1.1.0 ackMessage
// - agent_id 必須與 sessionId 當前活躍角色吻合且為原始搶鎖者
export function ackMessage(db, message_id, agent_id, sessionId) {
    // 取得當前活躍主身份（DB term_key 查詢，fallback 至 sessionId）
    const wtSession = process.env.WT_SESSION;
    let primaryAgentId = null;
    if (wtSession) {
        const termRegs = getRegistrationsByTermKey(db, wtSession);
        if (termRegs && termRegs.length > 0) primaryAgentId = termRegs[0].agent_id;
    }
    if (!primaryAgentId) {
        const sid = sessionId || resolveSessionId();
        const regs = getRegistrations(db, sid);
        if (regs && regs.length > 0) primaryAgentId = regs[0].agent_id;
    }
    // 若有活躍主身份，agent_id 必須吻合
    if (primaryAgentId && agent_id !== primaryAgentId) {
        return { success: false, reason: `403: agent_id "${agent_id}" 與當前活躍角色 "${primaryAgentId}" 不符` };
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
