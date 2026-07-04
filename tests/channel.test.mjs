import { initDatabase } from '../src/db.mjs';
import { sendMessage, listUnread, claimMessage, ackMessage, resolveRegsByTarget } from '../src/channel.mjs';
import os from 'node:os';
import path from 'node:path';

const TMP_JSON = path.join(os.tmpdir(), `channel-test-${process.pid}.json`);

function makeDb() {
  return initDatabase(':memory:', TMP_JSON);
}

// 直接 INSERT agents（跳過 registerAgent 的 env prefix 邏輯，保持測試確定性）
// 每個 agent 使用 agent_id 作為唯一 term_key，符合 idx_agents_term_active 唯一性要求
function insertAgent(db, agentId, sessionId, role = 'PG') {
  db.prepare(
    `INSERT INTO agents (agent_id, role, session_id, term_key, last_seen, status, updated_at)
     VALUES (?, ?, ?, ?, datetime('now','localtime'), 'active', datetime('now','localtime'))`
  ).run(agentId, role, sessionId, `term-${agentId}`);
}

// NOTE: sendMessage(db, receiver, message, sender, sessionId, priority)
// Tests use sender='SYSTEM' to bypass session auth validation.

// ─── 1. sendMessage — 回傳 message_id，status='UNREAD' ────────────────────
test('sendMessage: 回傳 message_id 且初始 status 為 UNREAD', async () => {
  const db = makeDb();
  const result = await sendMessage(db, 'CC-PG1', 'hello', 'SYSTEM', null, 5);
  expect(result).toHaveProperty('message_id');
  expect(result.message_id).toMatch(/^msg-/);
  expect(result.status).toBe('UNREAD');
  const row = db.prepare('SELECT status FROM agent_collaboration_channel WHERE message_id = ?').get(result.message_id);
  expect(row.status).toBe('UNREAD');
  db.close();
});

// ─── 2. listUnread — 只回傳 UNREAD 訊息 ──────────────────────────────────
test('listUnread: 只回傳 UNREAD 訊息，已讀訊息不應出現', async () => {
  const db = makeDb();
  insertAgent(db, 'CC-PG1', 'sess-t2');
  const m1 = await sendMessage(db, 'CC-PG1', 'msg-unread', 'SYSTEM', null, 5);
  const m2 = await sendMessage(db, 'CC-PG1', 'msg-to-claim', 'SYSTEM', null, 5);

  await claimMessage(db, m2.message_id, 'CC-PG1');

  const result = await listUnread(db, 'CC-PG1', 'sess-t2');
  const ids = result.messages.map(m => m.message_id);
  expect(ids).toContain(m1.message_id);
  expect(ids).not.toContain(m2.message_id);
  db.close();
});

// ─── 3. listUnread — receiver=null 列出 session 所有角色未讀 ─────────────
test('listUnread: receiver=null 列出 session 所有角色聯集（含 any）', async () => {
  const db = makeDb();
  insertAgent(db, 'CC-PG1', 'sess-t3');
  const m1 = await sendMessage(db, 'CC-PG1', 'for-pg1', 'SYSTEM', null, 5);
  const m2 = await sendMessage(db, 'any', 'for-any', 'SYSTEM', null, 5);

  const result = await listUnread(db, null, 'sess-t3');
  const ids = result.messages.map(m => m.message_id);
  expect(ids).toContain(m1.message_id);
  expect(ids).toContain(m2.message_id);
  db.close();
});

// ─── 4. listUnread — receiver='all' 等同 null ────────────────────────────
test('listUnread: receiver="all" 等同 null，列出 session 聯集', async () => {
  const db = makeDb();
  insertAgent(db, 'CC-PG2', 'sess-t4');
  const m1 = await sendMessage(db, 'CC-PG2', 'msg1', 'SYSTEM', null, 5);
  const m2 = await sendMessage(db, 'any', 'msg2', 'SYSTEM', null, 5);

  const result = await listUnread(db, 'all', 'sess-t4');
  const ids = result.messages.map(m => m.message_id);
  expect(ids).toContain(m1.message_id);
  expect(ids).toContain(m2.message_id);
  db.close();
});

// ─── 5. claimMessage — 成功搶鎖，status → IN_PROGRESS ────────────────────
test('claimMessage: 成功搶鎖後 status 應更新為 IN_PROGRESS', async () => {
  const db = makeDb();
  insertAgent(db, 'CC-PG1', 'sess-t5');
  const m = await sendMessage(db, 'CC-PG1', 'claimable', 'SYSTEM', null, 5);
  const result = await claimMessage(db, m.message_id, 'CC-PG1');
  expect(result.success).toBe(true);
  expect(result.message_id).toBe(m.message_id);
  const row = db.prepare('SELECT status, lock_owner FROM agent_collaboration_channel WHERE message_id = ?').get(m.message_id);
  expect(row.status).toBe('IN_PROGRESS');
  expect(row.lock_owner).toBe('CC-PG1');
  db.close();
});

// ─── 6. claimMessage — 重複搶鎖回傳 success:false ────────────────────────
test('claimMessage: 已搶鎖訊息再次搶鎖應回傳 success:false', async () => {
  const db = makeDb();
  insertAgent(db, 'CC-PG1', 'sess-t6a');
  insertAgent(db, 'CC-PG2', 'sess-t6b');
  const m = await sendMessage(db, 'CC-PG1', 'double-claim', 'SYSTEM', null, 5);
  await claimMessage(db, m.message_id, 'CC-PG1');
  const result = await claimMessage(db, m.message_id, 'CC-PG2');
  expect(result.success).toBe(false);
  db.close();
});

// ─── 7. claimMessage — 不存在的 message_id 回傳 success:false ────────────
test('claimMessage: 不存在的 message_id 應回傳 success:false', async () => {
  const db = makeDb();
  insertAgent(db, 'CC-PG1', 'sess-t7');
  const result = await claimMessage(db, 'msg-nonexistent-uuid', 'CC-PG1');
  expect(result.success).toBe(false);
  expect(result.reason).toMatch(/not found/i);
  db.close();
});

// ─── 8. ackMessage — 正確 owner ACK，status → READ ───────────────────────
test('ackMessage: 正確 owner ACK 後 status 應更新為 READ', async () => {
  const db = makeDb();
  insertAgent(db, 'CC-PG1', 'sess-t8');
  const m = await sendMessage(db, 'CC-PG1', 'to-ack', 'SYSTEM', null, 5);
  await claimMessage(db, m.message_id, 'CC-PG1');
  const result = await ackMessage(db, m.message_id, 'CC-PG1');
  expect(result.success).toBe(true);
  expect(result.message_id).toBe(m.message_id);
  const row = db.prepare('SELECT status FROM agent_collaboration_channel WHERE message_id = ?').get(m.message_id);
  expect(row.status).toBe('READ');
  db.close();
});

// ─── 9. ackMessage — 錯誤 owner ACK 回傳 success:false ──────────────────
test('ackMessage: 非 lock_owner 的 agent ACK 應回傳 success:false', async () => {
  const db = makeDb();
  insertAgent(db, 'CC-PG1', 'sess-t9a');
  insertAgent(db, 'CC-PG2', 'sess-t9b');
  const m = await sendMessage(db, 'CC-PG1', 'wrong-owner-ack', 'SYSTEM', null, 5);
  await claimMessage(db, m.message_id, 'CC-PG1');
  const result = await ackMessage(db, m.message_id, 'CC-PG2');
  expect(result.success).toBe(false);
  expect(result.reason).toBeTruthy();
  db.close();
});

// ─── Spec 9: sendMessage all 廣播 ────────────────────────────────────────
test('sendMessage: receiver=all 廣播給所有 active agents（排除 sender）', async () => {
  const db = makeDb();
  insertAgent(db, 'AGT-B', 'sess-all-b', 'SA');
  insertAgent(db, 'AGT-C', 'sess-all-c', 'QA');
  const result = await sendMessage(db, 'all', 'broadcast!', 'SYSTEM', null, 5);
  expect(result.count).toBeGreaterThanOrEqual(2);
  expect(Array.isArray(result.message_ids)).toBe(true);
  db.close();
});

// ─── Spec 9: sendMessage any 寫入單筆 receiver=any ───────────────────────
test('sendMessage: receiver=any 寫入單筆 receiver=any 記錄', async () => {
  const db = makeDb();
  const result = await sendMessage(db, 'any', 'first-come', 'SYSTEM', null, 5);
  expect(result.status).toBe('UNREAD');
  const row = db.prepare('SELECT receiver FROM agent_collaboration_channel WHERE message_id = ?').get(result.message_id);
  expect(row.receiver).toBe('any');
  db.close();
});

// ─── Spec 9: listUnread any 訊息對有效角色可見 ───────────────────────────
test('listUnread: receiver=any 的訊息在 session 聯集查詢中可見', async () => {
  const db = makeDb();
  insertAgent(db, 'CC-PG1', 'sess-any-vis');
  const m = await sendMessage(db, 'any', 'any-msg', 'SYSTEM', null, 5);

  const result = await listUnread(db, null, 'sess-any-vis');
  const ids = result.messages.map(x => x.message_id);
  expect(ids).toContain(m.message_id);
  db.close();
});

// ─── Spec 9: claimMessage 越權拒絕（非本 session 角色）─────────────────
test('claimMessage: 非 session 活躍角色嘗試搶鎖應回傳 403', async () => {
  const db = makeDb();
  insertAgent(db, 'CC-SA1', 'sess-sec-a', 'SA');
  const m = await sendMessage(db, 'CC-SA1', 'sa-only', 'SYSTEM', null, 5);

  const result = await claimMessage(db, m.message_id, 'CC-PG1');
  expect(result.success).toBe(false);
  expect(result.reason).toMatch(/403/);
  db.close();
});

// ─── Spec 9: ackMessage 越權拒絕 ─────────────────────────────────────────
test('ackMessage: 非活躍角色不可 ACK 他人訊息', async () => {
  const db = makeDb();
  insertAgent(db, 'CC-PG1', 'sess-sec-b');
  const m = await sendMessage(db, 'CC-PG1', 'pg-msg', 'SYSTEM', null, 5);
  await claimMessage(db, m.message_id, 'CC-PG1');

  const result = await ackMessage(db, m.message_id, 'CC-SA1');
  expect(result.success).toBe(false);
  db.close();
});

// ─── Spec 9: listUnread 越權拒絕 ─────────────────────────────────────────
test('listUnread: 指定不屬於 session 的 receiver 拋出 403', async () => {
  const db = makeDb();
  insertAgent(db, 'CC-PG1', 'sess-sec-c');

  await expect(listUnread(db, 'CC-SA1', 'sess-sec-c')).rejects.toThrow('403');
  db.close();
});

// ─── Spec 10: channel_send 無 active 主角色時拒絕（Medium 1 guard）────────
test('resolveRegsByTarget: attached-only target 不含 active 角色', () => {
  const db = makeDb();
  // 插入一個 attached（非 active）agent
  db.prepare(
    `INSERT INTO agents (agent_id, role, session_id, term_key, last_seen, status, updated_at)
     VALUES ('CC-PG1', 'PG', 'sess-att', 'term-CC-PG1', datetime('now','localtime'), 'attached', datetime('now','localtime'))`
  ).run();

  const regs = resolveRegsByTarget(db, 'CC-PG1');
  // target 可被解析（回傳非空），但無 active 主角色
  expect(regs.length).toBeGreaterThan(0);
  expect(regs.find(r => r.status === 'active')).toBeUndefined();
  db.close();
});

// ─── v1.3.1: Platform Pool — CC? 訊息對 CC-* agent 可見 ─────────────────
test('listUnread v1.3.1: receiver=CC? 的訊息對 CC-PG1 活躍的 session 可見', async () => {
  const db = makeDb();
  insertAgent(db, 'CC-PG1', 'sess-plat1');
  const m = await sendMessage(db, 'CC?', 'platform-pool-msg', 'SYSTEM', null, 5);

  const result = await listUnread(db, null, 'sess-plat1');
  const ids = result.messages.map(x => x.message_id);
  expect(ids).toContain(m.message_id);
  db.close();
});

// ─── v1.3.1: Sender Self-Exclusion — 自發 any 訊息不出現在自己的 listUnread ─
test('listUnread v1.3.1: 自己發給 any 的訊息不應出現在自己的 listUnread 結果中', async () => {
  const db = makeDb();
  insertAgent(db, 'CC-PG1', 'sess-selfexcl');
  // CC-PG1 是活躍 agent，直接以 agent_id 繞過 SYSTEM guard 發送（需在 agents 中）
  const m = await sendMessage(db, 'any', 'self-sent-msg', 'CC-PG1', null, 5);

  const result = await listUnread(db, null, 'sess-selfexcl');
  const ids = result.messages.map(x => x.message_id);
  expect(ids).not.toContain(m.message_id);
  db.close();
});
