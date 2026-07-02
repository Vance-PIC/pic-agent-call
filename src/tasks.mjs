import { createHash, randomUUID } from 'node:crypto';
import { withRetry } from './db.mjs';

const TIMEOUT_MINUTES = 30;
const TIMEOUT_SECONDS = TIMEOUT_MINUTES * 60;


// 僅供測試隔離使用（初始化 agents 表）；正式初始化請使用 src/db.mjs setup()
export function initAgentsTable(db) {
    db.exec(`CREATE TABLE IF NOT EXISTS agents (
        agent_id          TEXT PRIMARY KEY,
        last_seen         TEXT,
        status            TEXT NOT NULL DEFAULT 'offline' CHECK(status IN ('active','attached','offline')),
        agent_timeout_sec INTEGER NOT NULL DEFAULT 86400,
        poll_interval_sec INTEGER NOT NULL DEFAULT 30,
        term_key          TEXT NOT NULL,
        session_id        TEXT,
        role              TEXT,
        created_at        TEXT NOT NULL DEFAULT (datetime('now','localtime')),
        updated_at        TEXT NOT NULL DEFAULT (datetime('now','localtime'))
    )`);
}

export async function createTask(db, feature, assign_to, payload, type, relay_to) {
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
    const taskId = 'task-' + randomUUID();
    const result = await withRetry(() => {
        db.exec('BEGIN IMMEDIATE');
        try {
            const existing = db.prepare('SELECT task_id, status, type FROM tasks WHERE payload_hash = ?').get(hash);
            if (existing) { db.exec('ROLLBACK'); return { task_id: existing.task_id, status: existing.status, type: existing.type, idempotent: true }; }
            db.prepare('INSERT INTO tasks (task_id, feature, assign_to, payload, type, relay_to, payload_hash) VALUES (?, ?, ?, ?, ?, ?, ?)')
              .run(taskId, feature.trim(), assign_to.trim(), payload, resolvedType, resolvedRelayTo, hash);
            db.exec('COMMIT');
            return null;
        } catch (err) {
            try { db.exec('ROLLBACK'); } catch (_) {}
            throw err;
        }
    });
    if (result) return result;
    return { task_id: taskId, status: 'pending', type: resolvedType, idempotent: false };
}

export async function listPendingTasks(db, assign_to) {
    const assignTo = (assign_to && typeof assign_to === 'string') ? assign_to.trim() : null;
    // 超時釋放：withRetry 防 SQLITE_BUSY；BEGIN IMMEDIATE 確保原子性
    await withRetry(() => {
        db.exec('BEGIN IMMEDIATE');
        try {
            db.prepare(
                `UPDATE tasks SET status='pending', claimed_by=NULL, claimed_at=NULL, updated_at=datetime('now','localtime')
                 WHERE status='claimed' AND claimed_by IS NOT NULL AND (
                     SELECT last_seen FROM agents WHERE agent_id = tasks.claimed_by
                 ) < datetime('now','localtime','-' || COALESCE(
                     (SELECT agent_timeout_sec FROM agents WHERE agent_id = tasks.claimed_by),
                     ${TIMEOUT_SECONDS}
                 ) || ' seconds')`
            ).run();
            db.exec('COMMIT');
        } catch (err) {
            try { db.exec('ROLLBACK'); } catch (_) {}
            throw err;
        }
    });

    const rows = assignTo
        ? db.prepare(`SELECT task_id, feature, assign_to, payload, type, relay_to, status, created_at FROM tasks WHERE status='pending' AND assign_to=? ORDER BY created_at ASC`).all(assignTo)
        : db.prepare(`SELECT task_id, feature, assign_to, payload, type, relay_to, status, created_at FROM tasks WHERE status='pending' ORDER BY created_at ASC`).all();
    return { tasks: rows, count: rows.length };
}

export async function claimTask(db, task_id, agent_id) {
    if (!task_id || !agent_id || typeof agent_id !== 'string' || !agent_id.trim() || agent_id.length > 100)
        return { success: false, reason: 'validation_error' };

    return withRetry(() => {
        db.exec('BEGIN IMMEDIATE');
        try {
            const agentRow = db.prepare(
                `SELECT 1 FROM agents WHERE agent_id = ? AND status IN ('active','attached')`
            ).get(agent_id.trim());
            if (!agentRow) {
                db.exec('ROLLBACK');
                return { success: false, reason: '403: agent_id 未登記為活躍狀態，禁止領取任務' };
            }

            const row = db.prepare('SELECT status, claimed_by FROM tasks WHERE task_id = ?').get(task_id);
            if (!row) { db.exec('ROLLBACK'); return { success: false, reason: 'not_found', current_status: null, claimed_by: null }; }
            if (row.status !== 'pending') { db.exec('ROLLBACK'); return { success: false, reason: 'already_claimed', current_status: row.status, claimed_by: row.claimed_by }; }
            const changes = db.prepare(
                `UPDATE tasks SET status='claimed', claimed_by=?, claimed_at=datetime('now','localtime'), updated_at=datetime('now','localtime') WHERE task_id=? AND status='pending'`
            ).run(agent_id.trim(), task_id).changes;
            if (changes === 0) { db.exec('ROLLBACK'); return { success: false, reason: 'already_claimed', current_status: 'claimed', claimed_by: null }; }
            db.exec('COMMIT');
            const claimed = db.prepare('SELECT claimed_at FROM tasks WHERE task_id = ?').get(task_id);
            return { success: true, task_id, claimed_by: agent_id.trim(), claimed_at: claimed.claimed_at };
        } catch (err) {
            try { db.exec('ROLLBACK'); } catch (_) {}
            throw err;
        }
    });
}

export async function completeTask(db, task_id, result) {
    if (!task_id || result === undefined || result === null)
        return { success: false, reason: 'validation_error' };
    const resultStr = typeof result === 'string' ? result : JSON.stringify(result);
    if (Buffer.byteLength(resultStr, 'utf8') > 65536)
        return { success: false, reason: 'payload_too_large' };

    let completedAt = null;
    const success = await withRetry(() => {
        db.exec('BEGIN IMMEDIATE');
        try {
            const row = db.prepare('SELECT status FROM tasks WHERE task_id = ?').get(task_id);
            if (!row) { db.exec('ROLLBACK'); return 'not_found'; }
            if (row.status !== 'claimed') { db.exec('ROLLBACK'); return row.status; }
            const changes = db.prepare(
                `UPDATE tasks SET status='completed', result=?, completed_at=datetime('now','localtime'), updated_at=datetime('now','localtime') WHERE task_id=? AND status='claimed'`
            ).run(resultStr, task_id).changes;
            if (changes === 0) { db.exec('ROLLBACK'); return 'race'; }
            // COMMIT 前讀取 completed_at，避免 COMMIT 後獨立 SELECT 有 race window
            const saved = db.prepare('SELECT completed_at FROM tasks WHERE task_id = ?').get(task_id);
            db.exec('COMMIT');
            completedAt = saved?.completed_at ?? null;
            return 'ok';
        } catch (err) {
            try { db.exec('ROLLBACK'); } catch (_) {}
            throw err;
        }
    });
    if (success === 'not_found') return { success: false, task_id, reason: 'not_found' };
    if (success !== 'ok') return { success: false, task_id, reason: 'invalid_status', current_status: success };
    return { success: true, task_id, status: 'completed', completed_at: completedAt };
}

export async function failTask(db, task_id, fail_reason) {
    if (!task_id || !fail_reason || typeof fail_reason !== 'string' || !fail_reason.trim())
        return { success: false, reason: 'validation_error' };
    if (Buffer.byteLength(fail_reason, 'utf8') > 1000)
        return { success: false, reason: 'payload_too_large' };

    const failResult = await withRetry(() => {
        db.exec('BEGIN IMMEDIATE');
        try {
            const row = db.prepare('SELECT status FROM tasks WHERE task_id = ?').get(task_id);
            if (!row) { db.exec('ROLLBACK'); return 'not_found'; }
            if (row.status !== 'claimed') { db.exec('ROLLBACK'); return row.status; }
            const changes = db.prepare(
                `UPDATE tasks SET status='failed', fail_reason=?, updated_at=datetime('now','localtime') WHERE task_id=? AND status='claimed'`
            ).run(fail_reason.trim(), task_id).changes;
            if (changes === 0) { db.exec('ROLLBACK'); return 'race'; }
            db.exec('COMMIT');
            return 'ok';
        } catch (err) {
            try { db.exec('ROLLBACK'); } catch (_) {}
            throw err;
        }
    });
    if (failResult === 'not_found') return { success: false, task_id, reason: 'not_found' };
    if (failResult !== 'ok') return { success: false, task_id, reason: 'invalid_status', current_status: failResult };
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
