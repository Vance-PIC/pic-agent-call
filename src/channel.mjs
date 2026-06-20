import { randomUUID } from 'node:crypto';

export function sendMessage(db, sender, receiver, message, priority) {
    const msgId = `msg-${randomUUID()}`;
    const p = Number(priority) || 5;
    db.prepare(
        `INSERT INTO agent_collaboration_channel (message_id, sender, receiver, priority, message) VALUES (?, ?, ?, ?, ?)`
    ).run(msgId, sender, receiver, p, message);
    return { message_id: msgId, status: 'UNREAD' };
}

export function listUnread(db, receiver) {
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

    const pool = receiver.endsWith('?') ? receiver.slice(0, -1) : null;
    let rows;
    if (receiver === 'all') {
        rows = db.prepare(`SELECT * FROM agent_collaboration_channel WHERE status='UNREAD' ORDER BY priority DESC, created_at ASC`).all();
    } else if (pool) {
        rows = db.prepare(`SELECT * FROM agent_collaboration_channel WHERE status='UNREAD' AND receiver LIKE ? ORDER BY priority DESC, created_at ASC`).all(`${pool}%`);
    } else {
        rows = db.prepare(`SELECT * FROM agent_collaboration_channel WHERE status='UNREAD' AND receiver=? ORDER BY priority DESC, created_at ASC`).all(receiver);
    }
    return { messages: rows, count: rows.length };
}

export function claimMessage(db, message_id, agent_id) {
    db.exec('BEGIN IMMEDIATE');
    try {
        const row = db.prepare(`SELECT status, lock_owner FROM agent_collaboration_channel WHERE message_id = ?`).get(message_id);
        if (!row) { db.exec('ROLLBACK'); return { success: false, reason: 'message not found' }; }
        if (row.status !== 'UNREAD') { db.exec('ROLLBACK'); return { success: false, reason: `already ${row.status} by ${row.lock_owner || 'unknown'}` }; }
        db.prepare(
            `UPDATE agent_collaboration_channel
             SET status='IN_PROGRESS', lock_owner=?, lock_time=datetime('now','localtime'), updated_at=datetime('now','localtime')
             WHERE message_id=? AND status='UNREAD' AND lock_owner IS NULL`
        ).run(agent_id, message_id);
        const updated = db.prepare(`SELECT lock_owner FROM agent_collaboration_channel WHERE message_id = ?`).get(message_id);
        db.exec('COMMIT');
        if (updated.lock_owner === agent_id) return { success: true, message_id };
        return { success: false, reason: 'race: claimed by another agent' };
    } catch (err) {
        try { db.exec('ROLLBACK'); } catch (_) {}
        return { success: false, reason: err.message };
    }
}

export function ackMessage(db, message_id, agent_id) {
    db.exec('BEGIN IMMEDIATE');
    try {
        const row = db.prepare(`SELECT status, lock_owner FROM agent_collaboration_channel WHERE message_id = ?`).get(message_id);
        if (!row) { db.exec('ROLLBACK'); return { success: false, reason: 'message not found' }; }
        if (row.status !== 'IN_PROGRESS' || row.lock_owner !== agent_id) {
            db.exec('ROLLBACK');
            return { success: false, reason: `not owned: status=${row.status} owner=${row.lock_owner}` };
        }
        db.prepare(`UPDATE agent_collaboration_channel SET status='READ', updated_at=datetime('now','localtime') WHERE message_id=?`).run(message_id);
        db.exec('COMMIT');
        return { success: true, message_id };
    } catch (err) {
        try { db.exec('ROLLBACK'); } catch (_) {}
        return { success: false, reason: err.message };
    }
}
