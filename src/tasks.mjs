import { createHash, randomUUID } from 'node:crypto';

const TIMEOUT_MINUTES = 30;

function _now() {
    const d = new Date();
    const offset = d.getTimezoneOffset() * 60000;
    return new Date(d - offset).toISOString().replace('T', ' ').slice(0, 19);
}

export function initAgentsTable(db) {
    db.exec(`CREATE TABLE IF NOT EXISTS agents (
        agent_id          TEXT PRIMARY KEY,
        last_seen         TEXT,
        status            TEXT NOT NULL DEFAULT 'offline' CHECK(status IN ('active','offline')),
        agent_timeout_sec INTEGER NOT NULL DEFAULT 120,
        poll_interval_sec INTEGER NOT NULL DEFAULT 30,
        term_key          TEXT,
        created_at        TEXT NOT NULL DEFAULT (datetime('now','localtime')),
        updated_at        TEXT NOT NULL DEFAULT (datetime('now','localtime'))
    )`);
    try { db.exec(`ALTER TABLE agents ADD COLUMN term_key TEXT`); } catch (_) {}
}

export function createTask(db, feature, assign_to, payload, type, relay_to) {
    if (!feature || typeof feature !== 'string' || !feature.trim() || feature.length > 100)
        return { success: false, reason: 'validation_error' };
    if (!assign_to || typeof assign_to !== 'string' || !assign_to.trim() || assign_to.length > 50)
        return { success: false, reason: 'validation_error' };
    if (!payload || typeof payload !== 'string' || !payload.trim())
        return { success: false, reason: 'validation_error' };
    if (Buffer.byteLength(payload, 'utf8') > 65536)
        return { success: false, reason: 'payload_too_large' };

    const validTypes = ['task', 'final'];
    if (type !== undefined && type !== null && !validTypes.includes(type))
        return { success: false, reason: 'validation_error' };
    const resolvedType = (type && validTypes.includes(type)) ? type : 'task';

    const resolvedRelayTo = (relay_to && typeof relay_to === 'string' && relay_to.trim())
        ? relay_to.trim() : null;
    if (resolvedRelayTo !== null && resolvedRelayTo.length > 50)
        return { success: false, reason: 'validation_error' };

    const hash = createHash('sha256').update(feature + '|' + payload).digest('hex');
    const existing = db.prepare('SELECT task_id, status, type FROM tasks WHERE payload_hash = ?').get(hash);
    if (existing) return { task_id: existing.task_id, status: existing.status, type: existing.type, idempotent: true };

    const taskId = 'task-' + randomUUID();
    db.prepare('INSERT INTO tasks (task_id, feature, assign_to, payload, type, relay_to, payload_hash) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(taskId, feature.trim(), assign_to.trim(), payload, resolvedType, resolvedRelayTo, hash);
    return { task_id: taskId, status: 'pending', type: resolvedType, idempotent: false };
}

export function listPendingTasks(db, assign_to) {
    const assignTo = (assign_to && typeof assign_to === 'string') ? assign_to.trim() : null;
    db.prepare(
        `UPDATE tasks SET status='pending', claimed_by=NULL, claimed_at=NULL, updated_at=datetime('now','localtime')
         WHERE status='claimed' AND claimed_at < datetime('now','localtime',? || ' minutes')`
    ).run(`-${TIMEOUT_MINUTES}`);

    const rows = assignTo
        ? db.prepare(`SELECT task_id, feature, assign_to, payload, type, relay_to, status, created_at FROM tasks WHERE status='pending' AND assign_to=? ORDER BY created_at ASC`).all(assignTo)
        : db.prepare(`SELECT task_id, feature, assign_to, payload, type, relay_to, status, created_at FROM tasks WHERE status='pending' ORDER BY created_at ASC`).all();
    return { tasks: rows, count: rows.length };
}

export function claimTask(db, task_id, agent_id) {
    if (!task_id || !agent_id || typeof agent_id !== 'string' || !agent_id.trim() || agent_id.length > 100)
        return { success: false, reason: 'validation_error' };

    const now = _now();
    db.exec('BEGIN IMMEDIATE');
    try {
        const row = db.prepare('SELECT status, claimed_by FROM tasks WHERE task_id = ?').get(task_id);
        if (!row) { db.exec('ROLLBACK'); return { success: false, reason: 'not_found', current_status: null, claimed_by: null }; }
        if (row.status !== 'pending') { db.exec('ROLLBACK'); return { success: false, reason: 'already_claimed', current_status: row.status, claimed_by: row.claimed_by }; }
        const changes = db.prepare(
            `UPDATE tasks SET status='claimed', claimed_by=?, claimed_at=?, updated_at=? WHERE task_id=? AND status='pending'`
        ).run(agent_id.trim(), now, now, task_id).changes;
        if (changes === 0) { db.exec('ROLLBACK'); return { success: false, reason: 'already_claimed', current_status: 'claimed', claimed_by: null }; }
        db.exec('COMMIT');
        return { success: true, task_id, claimed_by: agent_id.trim(), claimed_at: now };
    } catch (err) {
        try { db.exec('ROLLBACK'); } catch (_) {}
        throw err;
    }
}

export function completeTask(db, task_id, result) {
    if (!task_id || result === undefined || result === null)
        return { success: false, reason: 'validation_error' };
    const resultStr = typeof result === 'string' ? result : JSON.stringify(result);
    if (Buffer.byteLength(resultStr, 'utf8') > 65536)
        return { success: false, reason: 'payload_too_large' };

    const row = db.prepare('SELECT status FROM tasks WHERE task_id = ?').get(task_id);
    if (!row) return { success: false, task_id, reason: 'not_found' };
    if (row.status !== 'claimed') return { success: false, task_id, reason: 'invalid_status', current_status: row.status };

    const now = _now();
    db.prepare(`UPDATE tasks SET status='completed', result=?, completed_at=?, updated_at=? WHERE task_id=? AND status='claimed'`)
      .run(resultStr, now, now, task_id);
    return { success: true, task_id, status: 'completed', completed_at: now };
}

export function failTask(db, task_id, fail_reason) {
    if (!task_id || !fail_reason || typeof fail_reason !== 'string' || !fail_reason.trim())
        return { success: false, reason: 'validation_error' };
    if (Buffer.byteLength(fail_reason, 'utf8') > 1000)
        return { success: false, reason: 'payload_too_large' };

    const row = db.prepare('SELECT status FROM tasks WHERE task_id = ?').get(task_id);
    if (!row) return { success: false, task_id, reason: 'not_found' };
    if (row.status !== 'claimed') return { success: false, task_id, reason: 'invalid_status', current_status: row.status };

    const now = _now();
    db.prepare(`UPDATE tasks SET status='failed', fail_reason=?, updated_at=? WHERE task_id=? AND status='claimed'`)
      .run(fail_reason.trim(), now, task_id);
    return { success: true, task_id, status: 'failed' };
}

export function getTask(db, task_id) {
    if (!task_id) return { success: false, reason: 'validation_error' };
    const row = db.prepare(
        'SELECT task_id, feature, assign_to, payload, type, status, claimed_by, claimed_at, completed_at, result, fail_reason, created_at, updated_at FROM tasks WHERE task_id = ?'
    ).get(task_id);
    if (!row) return { success: false, reason: 'not_found' };
    return row;
}
