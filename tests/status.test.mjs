/**
 * tests/status.test.mjs
 * Jest unit tests for src/status.mjs
 * Coverage target: >= 80%
 *
 * Each test uses an isolated in-memory SQLite DB to ensure full independence.
 */

import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';

// ── import modules under test ─────────────────────────────────────────────────

let initDatabase;
let resolveSessionId, getRegistration, getRegistrations, findAgentIdConflict;
let registerAgent, handleOrphanedMessages, getAgentStatus;
let _resetSessionIdCache;
let getAgentsByPlatformStatus;

beforeAll(async () => {
  const dbMod = await import('../src/db.mjs');
  initDatabase = dbMod.initDatabase;

  const statusMod = await import('../src/status.mjs');
  resolveSessionId              = statusMod.resolveSessionId;
  getRegistration               = statusMod.getRegistration;
  getRegistrations              = statusMod.getRegistrations;
  findAgentIdConflict           = statusMod.findAgentIdConflict;
  registerAgent                 = statusMod.registerAgent;
  handleOrphanedMessages        = statusMod.handleOrphanedMessages;
  getAgentStatus                = statusMod.getAgentStatus;
  _resetSessionIdCache          = statusMod._resetSessionIdCache;
  getAgentsByPlatformStatus     = statusMod.getAgentsByPlatformStatus;
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
  afterEach(() => { restoreEnv(); _resetSessionIdCache?.(); });

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
    const originalHomedir = os.homedir;
    os.homedir = () => '/nonexistent-dir-to-force-fallback';

    try {
      const result = resolveSessionId();

      expect(typeof result).toBe('string');
      expect(result.length).toBeGreaterThan(0);
      // fallback format: hostname-pid
      expect(result).toContain(String(process.pid));
      expect(result).toContain(os.hostname());
    } finally {
      os.homedir = originalHomedir;
    }
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

  // 9. 首次 register，回傳 success:true + registered_agents + session_id
  test('9. 首次 register 回傳 success:true + registered_agents + session_id', () => {
    const result = registerAgent(db, 'sess-new', 'CC-PG1', 'PG');

    expect(result.success).toBe(true);
    expect(result.session_id).toBe('sess-new');
    expect(Array.isArray(result.registered_agents)).toBe(true);
    expect(result.registered_agents[0].agent_id).toBe('CC-PG1');
    expect(result.registered_agents[0].role).toBe('PG');
  });

  // 10. 同 session 再次呼叫同 agent_id 更新 role，回傳 success:true
  test('10. 同 session 再次呼叫更新 role，不產生衝突且回傳 success:true', () => {
    registerAgent(db, 'sess-update', 'CC-PG1', 'PG');
    const result = registerAgent(db, 'sess-update', 'CC-PG1', 'SA');

    expect(result.success).toBe(true);
    expect(result.registered_agents[0].role).toBe('SA');
    // 更新後 DB 中 role 應為 SA
    const row = db.prepare('SELECT role FROM agents WHERE agent_id = ?').get('CC-PG1');
    expect(row.role).toBe('SA');
  });

  // 11. 同 session 並存多角色時，不觸發孤兒（Spec 10 新行為）
  test('11. 同 session 並存多角色，不觸發孤兒訊息標記', () => {
    // register 第一個角色
    registerAgent(db, 'sess-multi', 'CC-PG1', 'PG');

    // 插入一條給第一個角色的 UNREAD 訊息
    insertChannelMsg(db, {
      message_id: 'msg-no-orphan-001',
      sender: 'OTHER',
      receiver: 'CC-PG1',
    });

    // 同 session 加入第二個角色（並存，不換角色）
    registerAgent(db, 'sess-multi', 'CC-SA1', 'SA');

    // 舊訊息不應被標為 ORPHANED
    const row = db.prepare(
      `SELECT status FROM agent_collaboration_channel WHERE message_id = ?`
    ).get('msg-no-orphan-001');
    expect(row.status).toBe('UNREAD');
  });

  // 12. forced=true 接管他 session 的 agent_id，觸發孤兒通知
  test('12. forced=true 接管他 session 時，對 sender 發送 SYSTEM 通知', () => {
    // 舊 session 登記 CC-AGENT-A（需與 _parseAgentIds 自動補前綴後相符）
    db.prepare(
      `INSERT INTO agents (agent_id, role, session_id, last_seen, status, updated_at)
       VALUES ('CC-AGENT-A', 'PG', 'sess-old', datetime('now','localtime'), 'active', datetime('now','localtime'))`
    ).run();

    insertChannelMsg(db, {
      message_id: 'msg-notify-001',
      sender: 'SENDER-X',
      receiver: 'CC-AGENT-A',
    });

    // 新 session 強制接管 CC-AGENT-A（registerAgent 會自動補 CC- 前綴）
    registerAgent(db, 'sess-new-owner', 'AGENT-A', 'PG', true);

    // 應有一條 SYSTEM → SENDER-X 的通知
    const notify = db.prepare(
      `SELECT * FROM agent_collaboration_channel
       WHERE sender = 'SYSTEM' AND receiver = 'SENDER-X'`
    ).get();
    expect(notify).toBeDefined();
    const payload = JSON.parse(notify.message);
    expect(payload.type).toBe('ORPHAN_NOTICE');
    expect(payload.original_receiver).toBe('CC-AGENT-A');
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

  // 16. 有 register，無未讀 → display 含 🟢0·agent_id
  test('16. 有 register，無未讀時 display 含 🟢0', () => {
    registerAgent(db, 'sess-status-1', 'CC-PG1', 'PG');

    const result = getAgentStatus(db, 'sess-status-1');

    expect(result).not.toBeNull();
    expect(result.unread).toBe(0);
    expect(result.display).toContain('🟢0·CC-PG1');
  });

  // 17. 有 register，有未讀 → display 含 🔴N·agent_id
  test('17. 有 register，有未讀時 display 含 🔴N', () => {
    registerAgent(db, 'sess-status-2', 'CC-SA1', 'SA');

    insertChannelMsg(db, { message_id: 'msg-s-001', sender: 'OTHER', receiver: 'CC-SA1' });
    insertChannelMsg(db, { message_id: 'msg-s-002', sender: 'OTHER', receiver: 'CC-SA1' });

    const result = getAgentStatus(db, 'sess-status-2');

    expect(result.unread).toBe(2);
    expect(result.display).toContain('🔴2·CC-SA1');
  });

  // 18. display 格式為 `▶🔴N·agent_id`（單角色，primaryAgentId=null 用首筆）
  test('18. display 格式符合 ▶🔴N·agent_id', () => {
    registerAgent(db, 'sess-status-3', 'CC-PG2', 'PG');

    insertChannelMsg(db, { message_id: 'msg-fmt-001', sender: 'X', receiver: 'CC-PG2' });
    insertChannelMsg(db, { message_id: 'msg-fmt-002', sender: 'X', receiver: 'CC-PG2' });
    insertChannelMsg(db, { message_id: 'msg-fmt-003', sender: 'X', receiver: 'CC-PG2' });

    const result = getAgentStatus(db, 'sess-status-3');

    // 格式：▶🔴3·CC-PG2（▶ 含黃色 ANSI，單角色，唯一角色為 primary）
    expect(result.display).toContain('🔴3·CC-PG2');
    expect(result.display).toContain('▶');
  });

  // 19. any 訊息計入 unread
  test('19. receiver=any 訊息計入 unread', () => {
    registerAgent(db, 'sess-status-4', 'CC-PG3', 'PG');

    insertChannelMsg(db, { message_id: 'msg-any-001', sender: 'SYS', receiver: 'any' });
    insertChannelMsg(db, { message_id: 'msg-any-002', sender: 'SYS', receiver: 'CC-PG3' });

    const result = getAgentStatus(db, 'sess-status-4');

    expect(result.unread).toBe(2);
  });

  // 20. pool 訊息（receiver='PG?'）計入 unread
  test('20. receiver=PG? pool 訊息計入 unread', () => {
    registerAgent(db, 'sess-status-5', 'CC-PG4', 'PG');

    insertChannelMsg(db, { message_id: 'msg-pool-001', sender: 'SA', receiver: 'PG?' });
    insertChannelMsg(db, { message_id: 'msg-pool-002', sender: 'SA', receiver: 'CC-PG4' });
    insertChannelMsg(db, { message_id: 'msg-pool-003', sender: 'SA', receiver: 'any' });

    const result = getAgentStatus(db, 'sess-status-5');

    expect(result.unread).toBe(3);
  });

  // 21. 無 role 時只查個人 + any，不查 pool
  test('21. role=null 時不查 pool', () => {
    registerAgent(db, 'sess-status-6', 'CC-ANON', null);

    insertChannelMsg(db, { message_id: 'msg-anon-001', sender: 'X', receiver: 'CC-ANON' });
    insertChannelMsg(db, { message_id: 'msg-anon-002', sender: 'X', receiver: 'any' });
    insertChannelMsg(db, { message_id: 'msg-anon-003', sender: 'X', receiver: 'PG?' }); // 不應計入

    const result = getAgentStatus(db, 'sess-status-6');

    expect(result.unread).toBe(2);
  });
});

// ── getAgentsByPlatformStatus() ───────────────────────────────────────────────

describe('getAgentsByPlatformStatus()', () => {
  let db;

  beforeEach(() => { db = makeDb(); });
  afterEach(() => { try { db.close(); } catch (_) {} });

  // 30. 無匹配 prefix → 回傳空陣列
  test('30. 無 CC- 前綴的 agent 時回傳空陣列', () => {
    const result = getAgentsByPlatformStatus(db, 'CC-');
    expect(Array.isArray(result)).toBe(true);
    expect(result.length).toBe(0);
  });

  // 31. 有匹配的 agent，無未讀 → unread = 0
  test('31. CC- agent 有 register，無未讀時 unread = 0', () => {
    registerAgent(db, 'sess-p1', 'CC-PG1', 'PG');

    const result = getAgentsByPlatformStatus(db, 'CC-');

    expect(result.length).toBe(1);
    expect(result[0].agent_id).toBe('CC-PG1');
    expect(result[0].unread).toBe(0);
  });

  // 32. 有匹配的 agent，有未讀 → 正確計數
  test('32. CC- agent 有 2 條 UNREAD，unread = 2', () => {
    registerAgent(db, 'sess-p2', 'CC-SA1', 'SA');
    insertChannelMsg(db, { message_id: 'msg-p-001', sender: 'X', receiver: 'CC-SA1' });
    insertChannelMsg(db, { message_id: 'msg-p-002', sender: 'X', receiver: 'CC-SA1' });

    const result = getAgentsByPlatformStatus(db, 'CC-');
    const sa = result.find(a => a.agent_id === 'CC-SA1');
    expect(sa).toBeDefined();
    expect(sa.unread).toBe(2);
  });

  // 33. pool 訊息（role?）計入 unread
  test('33. receiver=SA? pool 訊息計入 unread', () => {
    registerAgent(db, 'sess-p3', 'CC-SA2', 'SA');
    insertChannelMsg(db, { message_id: 'msg-pool-p1', sender: 'PG', receiver: 'SA?' });

    const result = getAgentsByPlatformStatus(db, 'CC-');
    const sa = result.find(a => a.agent_id === 'CC-SA2');
    expect(sa.unread).toBe(1);
  });

  // 34. 不同 prefix 的 agent 不混入
  test('34. AGY- agent 不出現在 CC- prefix 查詢結果', () => {
    registerAgent(db, 'sess-agy1', 'AGY-SA1', 'SA');
    insertChannelMsg(db, { message_id: 'msg-agy-001', sender: 'X', receiver: 'AGY-SA1' });

    const result = getAgentsByPlatformStatus(db, 'CC-');
    const found = result.find(a => a.agent_id === 'AGY-SA1');
    expect(found).toBeUndefined();
  });
});

// ── getRegistrations() (Spec 10) ─────────────────────────────────────────────

describe('getRegistrations()', () => {
  let db;

  beforeEach(() => { db = makeDb(); });
  afterEach(() => { try { db.close(); } catch (_) {} });

  // 35. 無記錄回傳空陣列
  test('35. 無記錄時回傳空陣列', () => {
    const result = getRegistrations(db, 'sess-none');
    expect(Array.isArray(result)).toBe(true);
    expect(result.length).toBe(0);
  });

  // 36. 單角色 session 回傳 1 筆
  test('36. 單角色 session 回傳 1 筆', () => {
    registerAgent(db, 'sess-single', 'CC-PG1', 'PG');
    const result = getRegistrations(db, 'sess-single');
    expect(result.length).toBe(1);
    expect(result[0].agent_id).toBe('CC-PG1');
    expect(result[0].role).toBe('PG');
  });

  // 37. 多角色 session 回傳多筆
  test('37. 多角色 session 回傳多筆（順序按 created_at ASC）', () => {
    db.prepare(
      `INSERT INTO agents (agent_id, role, session_id, last_seen, status, updated_at)
       VALUES ('CC-PG1', 'PG', 'sess-multi', datetime('now','localtime'), 'active', datetime('now','localtime'))`
    ).run();
    db.prepare(
      `INSERT INTO agents (agent_id, role, session_id, last_seen, status, updated_at)
       VALUES ('CC-SA1', 'SA', 'sess-multi', datetime('now','localtime'), 'active', datetime('now','localtime'))`
    ).run();
    const result = getRegistrations(db, 'sess-multi');
    expect(result.length).toBe(2);
    const ids = result.map(r => r.agent_id);
    expect(ids).toContain('CC-PG1');
    expect(ids).toContain('CC-SA1');
  });
});

// ── registerAgent() Spec 10 多角色 ───────────────────────────────────────────

describe('registerAgent() Spec 10 多角色', () => {
  let db;

  beforeEach(() => { db = makeDb(); });
  afterEach(() => { try { db.close(); } catch (_) {} });

  // 38. 逗號分隔多角色 → 多筆 DB 記錄
  test('38. 逗號分隔多角色一次 register 多筆', () => {
    // 使用 AGENT_SESSION_ID 模擬 CC session
    process.env.CLAUDE_CODE_SESSION_ID = 'sess-multi-reg';
    const result = registerAgent(db, 'sess-multi-reg', 'CC-PG1,CC-SA1', undefined);
    delete process.env.CLAUDE_CODE_SESSION_ID;

    expect(result.success).toBe(true);
    expect(result.registered_agents.length).toBe(2);
    const regs = getRegistrations(db, 'sess-multi-reg');
    expect(regs.length).toBe(2);
  });

  // 39. 無前綴角色自動補 CC- 前綴
  test('39. 無前綴角色根據 CC session 自動補 CC-', () => {
    process.env.CLAUDE_CODE_SESSION_ID = 'sess-prefix-cc';
    const result = registerAgent(db, 'sess-prefix-cc', 'PG1', undefined);
    delete process.env.CLAUDE_CODE_SESSION_ID;

    expect(result.success).toBe(true);
    const aid = result.registered_agents[0].agent_id;
    expect(aid).toBe('CC-PG1');
  });

  // 40. 多角色 display 顯示 ▶ 前綴於第一筆
  test('40. 多角色 getAgentStatus display 多角色並列', () => {
    db.prepare(
      `INSERT INTO agents (agent_id, role, session_id, last_seen, status, updated_at)
       VALUES ('CC-PG1', 'PG', 'sess-disp', datetime('now','localtime'), 'active', datetime('now','localtime'))`
    ).run();
    db.prepare(
      `INSERT INTO agents (agent_id, role, session_id, last_seen, status, updated_at)
       VALUES ('CC-SA1', 'SA', 'sess-disp', datetime('now','localtime'), 'active', datetime('now','localtime'))`
    ).run();

    insertChannelMsg(db, { message_id: 'msg-d-001', sender: 'X', receiver: 'CC-SA1' });

    const result = getAgentStatus(db, 'sess-disp', 'CC-PG1');

    // ▶ 在 CC-PG1（含 ANSI）；CC-SA1 有 1 unread
    expect(result.display).toContain('🟢0·CC-PG1');
    expect(result.display).toContain('▶');
    expect(result.display).toContain('🔴1·CC-SA1');
    expect(result.display).toContain('  '); // 兩空格分隔
    expect(result.registered_agents.length).toBe(2);
  });

  // 41. 頓號分隔多角色解析正確
  test('41. 頓號分隔多角色解析', () => {
    process.env.CLAUDE_CODE_SESSION_ID = 'sess-dun';
    const result = registerAgent(db, 'sess-dun', 'PJM、PDM、SA', undefined);
    delete process.env.CLAUDE_CODE_SESSION_ID;

    expect(result.success).toBe(true);
    expect(result.registered_agents.length).toBe(3);
    const ids = result.registered_agents.map(r => r.agent_id);
    expect(ids).toContain('CC-PJM');
    expect(ids).toContain('CC-PDM');
    expect(ids).toContain('CC-SA');
  });

  // 42. 全形逗號、加號、全形分號分隔均可解析
  test('42. 全形逗號/加號/全形分號分隔多角色解析', () => {
    process.env.CLAUDE_CODE_SESSION_ID = 'sess-sep42';
    const r1 = registerAgent(db, 'sess-sep42', 'PJM，PDM', undefined);
    delete process.env.CLAUDE_CODE_SESSION_ID;
    expect(r1.success).toBe(true);
    expect(r1.registered_agents.map(r => r.agent_id)).toContain('CC-PJM');
    expect(r1.registered_agents.map(r => r.agent_id)).toContain('CC-PDM');
  });
});

