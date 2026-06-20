/**
 * tests/status.test.mjs
 * Jest unit tests for src/status.mjs
 * Coverage target: >= 80%
 *
 * Each test uses an isolated in-memory SQLite DB to ensure full independence.
 */

import os from 'node:os';

// ── import modules under test ─────────────────────────────────────────────────

let initDatabase;
let resolveSessionId, getRegistration, findAgentIdConflict;
let registerAgent, handleOrphanedMessages, getAgentStatus;

beforeAll(async () => {
  const dbMod = await import('../src/db.mjs');
  initDatabase = dbMod.initDatabase;

  const statusMod = await import('../src/status.mjs');
  resolveSessionId       = statusMod.resolveSessionId;
  getRegistration        = statusMod.getRegistration;
  findAgentIdConflict    = statusMod.findAgentIdConflict;
  registerAgent          = statusMod.registerAgent;
  handleOrphanedMessages = statusMod.handleOrphanedMessages;
  getAgentStatus         = statusMod.getAgentStatus;
});

// ── helpers ───────────────────────────────────────────────────────────────────

let dbCounter = 0;

/** Create a fresh in-memory DB with all tables initialised */
function makeDb() {
  dbCounter += 1;
  return initDatabase(':memory:', `/tmp/status-test-${dbCounter}.json`);
}

/** Insert a message directly into the channel table */
function insertChannelMsg(db, { message_id, sender, receiver, status = 'UNREAD', priority = 5, message = '{}' }) {
  db.prepare(
    `INSERT INTO agent_collaboration_channel
         (message_id, sender, receiver, priority, status, message, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, datetime('now','localtime'), datetime('now','localtime'))`
  ).run(message_id, sender, receiver, priority, status, message);
}

// ── env helpers ───────────────────────────────────────────────────────────────

const ENV_KEYS = ['CLAUDE_CODE_SESSION_ID', 'ANTIGRAVITY_CONVERSATION_ID', 'AGENT_SESSION_ID'];

let savedEnv = {};

function saveEnv() {
  savedEnv = {};
  for (const k of ENV_KEYS) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
}

function restoreEnv() {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) {
      delete process.env[k];
    } else {
      process.env[k] = savedEnv[k];
    }
  }
}

// ── resolveSessionId() ────────────────────────────────────────────────────────

describe('resolveSessionId()', () => {
  beforeEach(saveEnv);
  afterEach(restoreEnv);

  // 1. 讀 CLAUDE_CODE_SESSION_ID
  test('1. 讀 CLAUDE_CODE_SESSION_ID env', () => {
    process.env.CLAUDE_CODE_SESSION_ID = 'cc-session-abc';

    const result = resolveSessionId();

    expect(result).toBe('cc-session-abc');
  });

  // 2. CC env 不存在時讀 ANTIGRAVITY_CONVERSATION_ID
  test('2. CC env 不存在時讀 ANTIGRAVITY_CONVERSATION_ID env', () => {
    // CLAUDE_CODE_SESSION_ID already deleted in beforeEach
    process.env.ANTIGRAVITY_CONVERSATION_ID = 'agy-conv-xyz';

    const result = resolveSessionId();

    expect(result).toBe('agy-conv-xyz');
  });

  // 3. 兩者都無時 fallback 含 hostname-pid
  test('3. 兩者都無時 fallback 包含 hostname-pid，不為空且為字串', () => {
    // All env vars deleted in beforeEach

    const result = resolveSessionId();

    expect(typeof result).toBe('string');
    expect(result.length).toBeGreaterThan(0);
    // fallback format: hostname-pid
    expect(result).toContain(String(process.pid));
    expect(result).toContain(os.hostname());
  });
});

// ── getRegistration() ─────────────────────────────────────────────────────────

describe('getRegistration()', () => {
  let db;

  beforeEach(() => { db = makeDb(); });
  afterEach(() => { try { db.close(); } catch (_) {} });

  // 4. 無記錄回傳 null
  test('4. 無記錄時回傳 null', () => {
    const result = getRegistration(db, 'session-nonexistent');

    expect(result).toBeNull();
  });

  // 5. 有記錄回傳 { agent_id, role, session_id }
  test('5. 有記錄時回傳 { agent_id, role, session_id }', () => {
    db.prepare(
      `INSERT INTO agents (agent_id, role, session_id, last_seen, status, updated_at)
       VALUES ('CC-PG1', 'PG', 'sess-001', datetime('now','localtime'), 'active', datetime('now','localtime'))`
    ).run();

    const result = getRegistration(db, 'sess-001');

    expect(result).not.toBeNull();
    expect(result.agent_id).toBe('CC-PG1');
    expect(result.role).toBe('PG');
    expect(result.session_id).toBe('sess-001');
  });
});

// ── findAgentIdConflict() ─────────────────────────────────────────────────────

describe('findAgentIdConflict()', () => {
  let db;

  beforeEach(() => { db = makeDb(); });
  afterEach(() => { try { db.close(); } catch (_) {} });

  // 6. 同 agent_id 不同 session → 回傳衝突記錄
  test('6. 同 agent_id 不同 session 回傳衝突記錄', () => {
    db.prepare(
      `INSERT INTO agents (agent_id, role, session_id, last_seen, status, updated_at)
       VALUES ('CC-SA1', 'SA', 'sess-other', datetime('now','localtime'), 'active', datetime('now','localtime'))`
    ).run();

    const result = findAgentIdConflict(db, 'CC-SA1', 'sess-mine');

    expect(result).not.toBeNull();
    expect(result.agent_id).toBe('CC-SA1');
    expect(result.session_id).toBe('sess-other');
  });

  // 7. 同 agent_id 同 session → 回傳 null（不算衝突）
  test('7. 同 agent_id 同 session 回傳 null（不算衝突）', () => {
    db.prepare(
      `INSERT INTO agents (agent_id, role, session_id, last_seen, status, updated_at)
       VALUES ('CC-SA1', 'SA', 'sess-mine', datetime('now','localtime'), 'active', datetime('now','localtime'))`
    ).run();

    const result = findAgentIdConflict(db, 'CC-SA1', 'sess-mine');

    expect(result).toBeNull();
  });

  // 8. 無同名 agent → 回傳 null
  test('8. 無同名 agent 回傳 null', () => {
    const result = findAgentIdConflict(db, 'CC-NOBODY', 'sess-any');

    expect(result).toBeNull();
  });
});

// ── registerAgent() ───────────────────────────────────────────────────────────

describe('registerAgent()', () => {
  let db;

  beforeEach(() => { db = makeDb(); });
  afterEach(() => { try { db.close(); } catch (_) {} });

  // 9. 首次 register，回傳 success:true + agent_id + session_id
  test('9. 首次 register 回傳 success:true + agent_id + session_id', () => {
    const result = registerAgent(db, 'sess-new', 'CC-PG1', 'PG');

    expect(result.success).toBe(true);
    expect(result.agent_id).toBe('CC-PG1');
    expect(result.session_id).toBe('sess-new');
    expect(result.role).toBe('PG');
    // 首次不含 previous
    expect(result.previous).toBeUndefined();
  });

  // 10. 同 session 再次呼叫（更新 role），不產生衝突
  test('10. 同 session 再次呼叫更新 role，不產生衝突且回傳 success:true', () => {
    registerAgent(db, 'sess-update', 'CC-PG1', 'PG');
    const result = registerAgent(db, 'sess-update', 'CC-PG1', 'SA');

    expect(result.success).toBe(true);
    expect(result.agent_id).toBe('CC-PG1');
    expect(result.role).toBe('SA');
    // 更新後 DB 中 role 應為 SA
    const row = db.prepare('SELECT role FROM agents WHERE session_id = ?').get('sess-update');
    expect(row.role).toBe('SA');
  });

  // 11. 換 agent_id 時，舊 UNREAD 訊息標記為 ORPHANED
  test('11. 換 agent_id 時，舊 UNREAD 訊息標記為 ORPHANED', () => {
    // 先 register 舊 agent
    registerAgent(db, 'sess-swap', 'OLD-AGENT', 'PG');

    // 插入一條給舊 agent 的 UNREAD 訊息
    insertChannelMsg(db, {
      message_id: 'msg-orphan-001',
      sender: 'OTHER-AGENT',
      receiver: 'OLD-AGENT',
    });

    // 換 agent_id
    registerAgent(db, 'sess-swap', 'NEW-AGENT', 'PG');

    // 驗證舊訊息已標記 ORPHANED
    const row = db.prepare(
      `SELECT status FROM agent_collaboration_channel WHERE message_id = ?`
    ).get('msg-orphan-001');
    expect(row.status).toBe('ORPHANED');
  });

  // 12. 換 agent_id 時，對 sender 發送 SYSTEM 通知
  test('12. 換 agent_id 時，對 sender 發送 SYSTEM 通知', () => {
    registerAgent(db, 'sess-notify', 'AGENT-A', 'PG');

    insertChannelMsg(db, {
      message_id: 'msg-notify-001',
      sender: 'SENDER-X',
      receiver: 'AGENT-A',
    });

    registerAgent(db, 'sess-notify', 'AGENT-B', 'PG');

    // 應有一條 SYSTEM → SENDER-X 的通知
    const notify = db.prepare(
      `SELECT * FROM agent_collaboration_channel
       WHERE sender = 'SYSTEM' AND receiver = 'SENDER-X'`
    ).get();
    expect(notify).toBeDefined();
    const payload = JSON.parse(notify.message);
    expect(payload.type).toBe('ORPHAN_NOTICE');
    expect(payload.original_receiver).toBe('AGENT-A');
    expect(payload.new_agent_id).toBe('AGENT-B');
  });
});

// ── handleOrphanedMessages() ──────────────────────────────────────────────────

describe('handleOrphanedMessages()', () => {
  let db;

  beforeEach(() => { db = makeDb(); });
  afterEach(() => { try { db.close(); } catch (_) {} });

  // 13. 有孤兒訊息時回傳正確 count
  test('13. 有孤兒訊息時回傳正確 count', () => {
    // 先確保 SENDER-A 存在（channel 不需要 FK，直接 insert）
    insertChannelMsg(db, { message_id: 'msg-o-001', sender: 'SENDER-A', receiver: 'OLD-ID' });
    insertChannelMsg(db, { message_id: 'msg-o-002', sender: 'SENDER-A', receiver: 'OLD-ID' });
    insertChannelMsg(db, { message_id: 'msg-o-003', sender: 'SENDER-B', receiver: 'OLD-ID' });

    const count = handleOrphanedMessages(db, 'OLD-ID', 'NEW-ID');

    expect(count).toBe(3);
  });

  // 14. 無孤兒訊息時回傳 0
  test('14. 無孤兒訊息時回傳 0', () => {
    const count = handleOrphanedMessages(db, 'NOBODY', 'NEW-ID');

    expect(count).toBe(0);
  });
});

// ── getAgentStatus() ──────────────────────────────────────────────────────────

describe('getAgentStatus()', () => {
  let db;

  beforeEach(() => { db = makeDb(); });
  afterEach(() => { try { db.close(); } catch (_) {} });

  // 15. 未 register session → 回傳 null
  test('15. 未 register 的 session 回傳 null', () => {
    const result = getAgentStatus(db, 'sess-unknown');

    expect(result).toBeNull();
  });

  // 16. 有 register，無未讀 → display 顯示 📨0（無 emoji）
  test('16. 有 register，無未讀時 display 不含📨', () => {
    registerAgent(db, 'sess-status-1', 'CC-PG1', 'PG');

    const result = getAgentStatus(db, 'sess-status-1');

    expect(result).not.toBeNull();
    expect(result.unread).toBe(0);
    // 無未讀時 display 不含 📨
    expect(result.display).not.toContain('📨');
    expect(result.display).toContain('CC-PG1');
  });

  // 17. 有 register，有未讀 → display 顯示正確數量
  test('17. 有 register，有未讀時 display 顯示正確數量', () => {
    registerAgent(db, 'sess-status-2', 'CC-SA1', 'SA');

    insertChannelMsg(db, { message_id: 'msg-s-001', sender: 'OTHER', receiver: 'CC-SA1' });
    insertChannelMsg(db, { message_id: 'msg-s-002', sender: 'OTHER', receiver: 'CC-SA1' });

    const result = getAgentStatus(db, 'sess-status-2');

    expect(result.unread).toBe(2);
    expect(result.display).toContain('📨2');
  });

  // 18. display 格式為 `[agent_id|role] 📨N`
  test('18. display 格式符合 [agent_id|role] 📨N', () => {
    registerAgent(db, 'sess-status-3', 'CC-PG2', 'PG');

    insertChannelMsg(db, { message_id: 'msg-fmt-001', sender: 'X', receiver: 'CC-PG2' });
    insertChannelMsg(db, { message_id: 'msg-fmt-002', sender: 'X', receiver: 'CC-PG2' });
    insertChannelMsg(db, { message_id: 'msg-fmt-003', sender: 'X', receiver: 'CC-PG2' });

    const result = getAgentStatus(db, 'sess-status-3');

    // 期望格式：[CC-PG2|PG] 📨3
    expect(result.display).toBe('[CC-PG2|PG] 📨3');
  });

  // 19. 廣播訊息（receiver='all'）計入 unread
  test('19. receiver=all 廣播訊息計入 unread', () => {
    registerAgent(db, 'sess-status-4', 'CC-PG3', 'PG');

    insertChannelMsg(db, { message_id: 'msg-all-001', sender: 'SYS', receiver: 'all' });
    insertChannelMsg(db, { message_id: 'msg-all-002', sender: 'SYS', receiver: 'CC-PG3' });

    const result = getAgentStatus(db, 'sess-status-4');

    expect(result.unread).toBe(2);
  });

  // 20. pool 訊息（receiver='PG?'）計入 unread
  test('20. receiver=PG? pool 訊息計入 unread', () => {
    registerAgent(db, 'sess-status-5', 'CC-PG4', 'PG');

    insertChannelMsg(db, { message_id: 'msg-pool-001', sender: 'SA', receiver: 'PG?' });
    insertChannelMsg(db, { message_id: 'msg-pool-002', sender: 'SA', receiver: 'CC-PG4' });
    insertChannelMsg(db, { message_id: 'msg-pool-003', sender: 'SA', receiver: 'all' });

    const result = getAgentStatus(db, 'sess-status-5');

    expect(result.unread).toBe(3);
  });

  // 21. 無 role 時只查個人 + all，不查 pool
  test('21. role=null 時不查 pool', () => {
    registerAgent(db, 'sess-status-6', 'CC-ANON', null);

    insertChannelMsg(db, { message_id: 'msg-anon-001', sender: 'X', receiver: 'CC-ANON' });
    insertChannelMsg(db, { message_id: 'msg-anon-002', sender: 'X', receiver: 'all' });
    insertChannelMsg(db, { message_id: 'msg-anon-003', sender: 'X', receiver: 'PG?' }); // 不應計入

    const result = getAgentStatus(db, 'sess-status-6');

    expect(result.unread).toBe(2);
  });
});
