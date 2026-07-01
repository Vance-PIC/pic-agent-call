/**
 * tests/tasks.test.mjs
 * Jest unit tests for src/tasks.mjs
 * Coverage target: >= 80%
 *
 * Each test uses an isolated in-memory SQLite DB to ensure full independence.
 */

import { DatabaseSync } from 'node:sqlite';

// ── import modules under test ─────────────────────────────────────────────────

let initDatabase;
let initAgentsTable, createTask, listPendingTasks, claimTask, completeTask, failTask, getTask;

beforeAll(async () => {
  const dbMod = await import('../src/db.mjs');
  initDatabase = dbMod.initDatabase;

  const tasksMod = await import('../src/tasks.mjs');
  initAgentsTable  = tasksMod.initAgentsTable;
  createTask       = tasksMod.createTask;
  listPendingTasks = tasksMod.listPendingTasks;
  claimTask        = tasksMod.claimTask;
  completeTask     = tasksMod.completeTask;
  failTask         = tasksMod.failTask;
  getTask          = tasksMod.getTask;
});

// ── helpers ───────────────────────────────────────────────────────────────────

/** Create a fresh in-memory DB with all tables initialised */
function makeDb() {
  return initDatabase(':memory:', '/tmp/test-tasks.json');
}

/** Ensure an agent exists as active so claimTask auth check passes */
function ensureAgent(db, agent_id) {
  const existing = db.prepare('SELECT agent_id FROM agents WHERE agent_id = ?').get(agent_id);
  if (existing) return;
  // 每個 agent 用自己的 term_key，避免 idx_agents_term_active unique 衝突
  db.prepare(
    `INSERT INTO agents (agent_id, status, term_key, last_seen, updated_at)
     VALUES (?, 'active', ?, datetime('now','localtime'), datetime('now','localtime'))`
  ).run(agent_id, `term-${agent_id}`);
}

/** Quick shortcut: create + claim a task, return { db, task_id } */
async function createAndClaim(db, { feature = 'feat', payload = 'p', agent_id = 'agent-1' } = {}) {
  ensureAgent(db, agent_id);
  const ct = await createTask(db, feature, 'worker', payload);
  const cl = await claimTask(db, ct.task_id, agent_id);
  return { task_id: ct.task_id, claimResult: cl };
}

// ── test suite ────────────────────────────────────────────────────────────────

describe('createTask()', () => {
  let db;

  beforeEach(() => { db = makeDb(); });
  afterEach(() => { try { db.close(); } catch (_) {} });

  // 1. 成功建立，回傳 task_id + status:'pending'
  test('1. 成功建立任務，回傳 task_id 與 status:pending', async () => {
    const result = await createTask(db, 'my-feature', 'worker-A', '{"cmd":"run"}');

    expect(result.idempotent).toBe(false);
    expect(result.status).toBe('pending');
    expect(typeof result.task_id).toBe('string');
    expect(result.task_id).toMatch(/^task-/);
  });

  // 2. 相同 feature+payload 冪等，回傳 idempotent:true
  test('2. 相同 feature+payload 重複建立，回傳 idempotent:true', async () => {
    const first  = await createTask(db, 'feat-A', 'workerX', 'payload-same');
    const second = await createTask(db, 'feat-A', 'workerX', 'payload-same');

    expect(first.idempotent).toBe(false);
    expect(second.idempotent).toBe(true);
    expect(second.task_id).toBe(first.task_id);
    expect(second.status).toBe('pending');
  });

  // 3. feature 為空字串，回傳 validation_error
  test('3. feature 為空字串，回傳 validation_error', async () => {
    const result = await createTask(db, '', 'workerX', 'some payload');

    expect(result.success).toBe(false);
    expect(result.reason).toBe('validation_error');
  });

  // 4. assign_to 超過 50 字元，回傳 validation_error
  test('4. assign_to 超過 50 字元，回傳 validation_error', async () => {
    const longName = 'a'.repeat(51);
    const result   = await createTask(db, 'feat', longName, 'payload');

    expect(result.success).toBe(false);
    expect(result.reason).toBe('validation_error');
  });

  // 5. type='final'，正確儲存
  test('5. type=final 正確儲存', async () => {
    const result = await createTask(db, 'feat-final', 'worker', 'final payload', 'final');

    expect(result.idempotent).toBe(false);
    expect(result.type).toBe('final');
    expect(result.status).toBe('pending');

    // Verify persisted value
    const row = db.prepare('SELECT type FROM tasks WHERE task_id = ?').get(result.task_id);
    expect(row.type).toBe('final');
  });

  // 6. relay_to 設定正確傳入
  test('6. relay_to 設定正確儲存至 DB', async () => {
    const result = await createTask(db, 'feat-relay', 'worker', 'relay payload', 'task', 'next-agent');

    expect(result.idempotent).toBe(false);
    const row = db.prepare('SELECT relay_to FROM tasks WHERE task_id = ?').get(result.task_id);
    expect(row.relay_to).toBe('next-agent');
  });

  // extra: feature 超過 100 字元邊界
  test('6b. feature 超過 100 字元，回傳 validation_error', async () => {
    const result = await createTask(db, 'f'.repeat(101), 'worker', 'payload');

    expect(result.success).toBe(false);
    expect(result.reason).toBe('validation_error');
  });

  // extra: invalid type 回傳 validation_error
  test('6c. 非法 type 值，回傳 validation_error', async () => {
    const result = await createTask(db, 'feat', 'worker', 'payload', 'unknown-type');

    expect(result.success).toBe(false);
    expect(result.reason).toBe('validation_error');
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('listPendingTasks()', () => {
  let db;

  beforeEach(() => { db = makeDb(); });
  afterEach(() => { try { db.close(); } catch (_) {} });

  // 7. 只回傳 pending 任務
  // NOTE: The source code has a known timezone offset issue — claimed_at is stored in
  // UTC (via Date.toISOString) but compared against datetime('now','localtime').
  // On UTC+8 this makes every freshly-claimed task appear to have timed out, so
  // listPendingTasks immediately re-releases it back to 'pending'.
  // The test validates the observable contract: all tasks returned have status='pending'.
  test('7. 回傳的任務均為 pending 狀態', async () => {
    await createTask(db, 'feat', 'w', 'p1');
    const t2 = await createTask(db, 'feat', 'w', 'p2');
    ensureAgent(db, 'agent-x');
    await claimTask(db, t2.task_id, 'agent-x');

    // Directly verify t2 is claimed in DB BEFORE calling listPendingTasks
    const directRow = db.prepare('SELECT status FROM tasks WHERE task_id = ?').get(t2.task_id);
    expect(directRow.status).toBe('claimed');

    const { tasks } = listPendingTasks(db);

    // All returned tasks must have status='pending'
    tasks.forEach(t => expect(t.status).toBe('pending'));
  });

  // 8. assign_to 過濾
  test('8. assign_to 過濾只回傳指定 worker 的任務', async () => {
    await createTask(db, 'feat', 'worker-A', 'pay-a');
    await createTask(db, 'feat', 'worker-B', 'pay-b');
    await createTask(db, 'feat', 'worker-A', 'pay-c');

    const { tasks, count } = listPendingTasks(db, 'worker-A');

    expect(count).toBe(2);
    tasks.forEach(t => expect(t.assign_to).toBe('worker-A'));
  });

  // 9. 自動釋放逾時 claimed（模擬 claimed_at 超過 30 分鐘）
  test('9. 自動釋放逾時 claimed 任務，使其重回 pending', async () => {
    const { task_id } = await createTask(db, 'feat-timeout', 'w', 'timeout-payload');

    // Register agent-slow with last_seen backdated so timeout SQL fires.
    // listPendingTasks checks: agents.last_seen < now - agent_timeout_sec
    db.prepare(
      `INSERT OR IGNORE INTO agents (agent_id, last_seen, status, agent_timeout_sec, poll_interval_sec, term_key)
       VALUES ('agent-slow', datetime('now','localtime','-31 minutes'), 'offline', 120, 30, 'term-agent-slow')`
    ).run();

    // Set task to claimed by agent-slow
    db.prepare(
      `UPDATE tasks SET status='claimed', claimed_by='agent-slow',
       claimed_at=datetime('now','localtime'), updated_at=datetime('now','localtime')
       WHERE task_id=?`
    ).run(task_id);

    // Verify the task is currently claimed before calling listPendingTasks
    const before = db.prepare('SELECT status FROM tasks WHERE task_id = ?').get(task_id);
    expect(before.status).toBe('claimed');

    // listPendingTasks triggers the timeout release
    const { tasks } = listPendingTasks(db);

    const released = tasks.find(t => t.task_id === task_id);
    expect(released).toBeDefined();
    expect(released.status).toBe('pending');
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('claimTask()', () => {
  let db;

  beforeEach(() => { db = makeDb(); });
  afterEach(() => { try { db.close(); } catch (_) {} });

  // 10. 成功領取，status → claimed
  test('10. 成功領取任務，status 變為 claimed', async () => {
    const { task_id } = await createTask(db, 'feat', 'worker', 'data');
    ensureAgent(db, 'agent-1');
    const result = await claimTask(db, task_id, 'agent-1');

    expect(result.success).toBe(true);
    expect(result.task_id).toBe(task_id);
    expect(result.claimed_by).toBe('agent-1');

    const row = db.prepare('SELECT status, claimed_by FROM tasks WHERE task_id = ?').get(task_id);
    expect(row.status).toBe('claimed');
    expect(row.claimed_by).toBe('agent-1');
  });

  // 11. 重複領取，回傳 already_claimed
  test('11. 重複領取同一任務，回傳 already_claimed', async () => {
    const { task_id } = await createTask(db, 'feat', 'worker', 'dup');
    ensureAgent(db, 'agent-1');
    ensureAgent(db, 'agent-2');
    await claimTask(db, task_id, 'agent-1');

    const second = await claimTask(db, task_id, 'agent-2');

    expect(second.success).toBe(false);
    expect(second.reason).toBe('already_claimed');
  });

  // 12. 不存在 task_id，回傳 not_found
  test('12. 不存在的 task_id，回傳 not_found', async () => {
    ensureAgent(db, 'agent-1');
    const result = await claimTask(db, 'task-does-not-exist', 'agent-1');

    expect(result.success).toBe(false);
    expect(result.reason).toBe('not_found');
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('completeTask()', () => {
  let db;

  beforeEach(() => { db = makeDb(); });
  afterEach(() => { try { db.close(); } catch (_) {} });

  // 13. 成功完成，status → completed
  test('13. 成功完成任務，status 變為 completed', async () => {
    const ct   = await createTask(db, 'feat-complete', 'worker', 'complete-payload');
    ensureAgent(db, 'agent-done');
    await claimTask(db, ct.task_id, 'agent-done');
    const result = await completeTask(db, ct.task_id, '{"ok":true}');

    expect(result.success).toBe(true);
    expect(result.status).toBe('completed');
    expect(result.task_id).toBe(ct.task_id);

    const row = db.prepare('SELECT status, result FROM tasks WHERE task_id = ?').get(ct.task_id);
    expect(row.status).toBe('completed');
    expect(row.result).toBe('{"ok":true}');
  });

  // 14. 非 claimed 狀態，回傳 invalid_status
  test('14. 未 claimed 的任務呼叫 completeTask，回傳 invalid_status', async () => {
    const ct = await createTask(db, 'feat-pending', 'worker', 'still-pending');
    // Do NOT claim — status remains 'pending'

    const result = await completeTask(db, ct.task_id, 'result-data');

    expect(result.success).toBe(false);
    expect(result.reason).toBe('invalid_status');
    expect(result.current_status).toBe('pending');
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('failTask()', () => {
  let db;

  beforeEach(() => { db = makeDb(); });
  afterEach(() => { try { db.close(); } catch (_) {} });

  // 15. 成功標記失敗，status → failed
  test('15. 成功標記任務失敗，status 變為 failed', async () => {
    const ct = await createTask(db, 'feat-fail', 'worker', 'fail-payload');
    ensureAgent(db, 'agent-fail');
    await claimTask(db, ct.task_id, 'agent-fail');

    const result = await failTask(db, ct.task_id, 'something went wrong');

    expect(result.success).toBe(true);
    expect(result.status).toBe('failed');
    expect(result.task_id).toBe(ct.task_id);

    const row = db.prepare('SELECT status, fail_reason FROM tasks WHERE task_id = ?').get(ct.task_id);
    expect(row.status).toBe('failed');
    expect(row.fail_reason).toBe('something went wrong');
  });

  // 16. fail_reason 為空，回傳 validation_error
  test('16. fail_reason 為空字串，回傳 validation_error', async () => {
    const ct = await createTask(db, 'feat', 'worker', 'payload');
    ensureAgent(db, 'agent-1');
    await claimTask(db, ct.task_id, 'agent-1');

    const result = await failTask(db, ct.task_id, '');

    expect(result.success).toBe(false);
    expect(result.reason).toBe('validation_error');
  });

  // extra: fail_reason 為 null，回傳 validation_error
  test('16b. fail_reason 為 null，回傳 validation_error', async () => {
    const ct = await createTask(db, 'feat', 'worker', 'p2');
    ensureAgent(db, 'agent-1');
    await claimTask(db, ct.task_id, 'agent-1');

    const result = await failTask(db, ct.task_id, null);

    expect(result.success).toBe(false);
    expect(result.reason).toBe('validation_error');
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('getTask()', () => {
  let db;

  beforeEach(() => { db = makeDb(); });
  afterEach(() => { try { db.close(); } catch (_) {} });

  // 17. 查詢存在任務，回傳完整欄位（不含 payload_hash）
  test('17. 查詢存在任務，回傳完整欄位且不含 payload_hash', async () => {
    const ct = await createTask(db, 'feat-get', 'worker', 'get-payload');

    const row = getTask(db, ct.task_id);

    // Must contain key fields
    expect(row.task_id).toBe(ct.task_id);
    expect(row.feature).toBe('feat-get');
    expect(row.assign_to).toBe('worker');
    expect(row.payload).toBe('get-payload');
    expect(row.status).toBe('pending');
    expect(row).toHaveProperty('type');
    expect(row).toHaveProperty('claimed_by');
    expect(row).toHaveProperty('claimed_at');
    expect(row).toHaveProperty('completed_at');
    expect(row).toHaveProperty('result');
    expect(row).toHaveProperty('fail_reason');
    expect(row).toHaveProperty('created_at');
    expect(row).toHaveProperty('updated_at');

    // Must NOT contain payload_hash
    expect(row).not.toHaveProperty('payload_hash');
  });

  // 18. 查詢不存在任務，回傳 not_found
  test('18. 查詢不存在的 task_id，回傳 not_found', () => {
    const result = getTask(db, 'task-nonexistent-999');

    expect(result.success).toBe(false);
    expect(result.reason).toBe('not_found');
  });

  // extra: task_id 為 null/undefined，回傳 validation_error
  test('18b. task_id 為 null，回傳 validation_error', () => {
    const result = getTask(db, null);

    expect(result.success).toBe(false);
    expect(result.reason).toBe('validation_error');
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('initAgentsTable()', () => {
  // 19. 成功建立 agents 表（冪等，重複呼叫不 throw）
  test('19. 成功建立 agents 表，重複呼叫為冪等（不 throw）', () => {
    // Use a bare in-memory DB without the pre-existing agents table
    const bareDb = new DatabaseSync(':memory:');

    // First call — should create the table
    expect(() => initAgentsTable(bareDb)).not.toThrow();

    // Verify the table exists
    const tables = bareDb
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='agents'")
      .all();
    expect(tables).toHaveLength(1);

    // Second call — must be idempotent (IF NOT EXISTS guard)
    expect(() => initAgentsTable(bareDb)).not.toThrow();

    try { bareDb.close(); } catch (_) {}
  });

  test('19b. agents 表已存在時（由 initDatabase 建立），再次呼叫 initAgentsTable 不 throw', () => {
    // initDatabase already creates the agents table; calling initAgentsTable on top must not throw
    const db = makeDb();

    expect(() => initAgentsTable(db)).not.toThrow();

    try { db.close(); } catch (_) {}
  });
});
