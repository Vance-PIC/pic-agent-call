import { initDatabase } from '../src/db.mjs';
import { sendMessage, listUnread, claimMessage, ackMessage } from '../src/channel.mjs';
import os from 'node:os';
import path from 'node:path';

const TMP_JSON = path.join(os.tmpdir(), `channel-test-${process.pid}.json`);

function makeDb() {
  return initDatabase(':memory:', TMP_JSON);
}

// NOTE: sendMessage signature: (db, receiver, message, sender, sessionId, priority)
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
  const m1 = await sendMessage(db, 'PG1', 'msg-unread', 'SYSTEM', null, 5);
  const m2 = await sendMessage(db, 'PG1', 'msg-to-claim', 'SYSTEM', null, 5);

  // 搶鎖 m2，使其進入 IN_PROGRESS（不應出現在 listUnread）
  claimMessage(db, m2.message_id, 'PG1');

  const result = listUnread(db, 'PG1');
  const ids = result.messages.map(m => m.message_id);
  expect(ids).toContain(m1.message_id);
  expect(ids).not.toContain(m2.message_id);
  db.close();
});

// ─── 3. listUnread — pool 萬用字元（receiver='CC?'）匹配 ─────────────────
test('listUnread: pool 萬用字元 receiver="CC?" 應匹配所有 CC 前綴接收者', async () => {
  const db = makeDb();
  const m1 = await sendMessage(db, 'CC-PG1', 'for-pg1', 'SYSTEM', null, 5);
  const m2 = await sendMessage(db, 'CC-PG2', 'for-pg2', 'SYSTEM', null, 5);
  const m3 = await sendMessage(db, 'Gemini-PG1', 'for-gemini', 'SYSTEM', null, 5);

  const result = listUnread(db, 'CC?');
  const ids = result.messages.map(m => m.message_id);
  expect(ids).toContain(m1.message_id);
  expect(ids).toContain(m2.message_id);
  expect(ids).not.toContain(m3.message_id);
  db.close();
});

// ─── 4. listUnread — receiver='all' 回傳所有 UNREAD ─────────────────────
test('listUnread: receiver="all" 回傳所有 UNREAD 訊息', async () => {
  const db = makeDb();
  const m1 = await sendMessage(db, 'PG1', 'msg1', 'SYSTEM', null, 5);
  const m2 = await sendMessage(db, 'PG2', 'msg2', 'SYSTEM', null, 5);
  const m3 = await sendMessage(db, 'Gemini', 'msg3', 'SYSTEM', null, 5);

  const result = listUnread(db, 'all');
  const ids = result.messages.map(m => m.message_id);
  expect(ids).toContain(m1.message_id);
  expect(ids).toContain(m2.message_id);
  expect(ids).toContain(m3.message_id);
  expect(result.count).toBeGreaterThanOrEqual(3);
  db.close();
});

// ─── 5. claimMessage — 成功搶鎖，status → IN_PROGRESS ────────────────────
test('claimMessage: 成功搶鎖後 status 應更新為 IN_PROGRESS', async () => {
  const db = makeDb();
  const m = await sendMessage(db, 'PG1', 'claimable', 'SYSTEM', null, 5);
  const result = claimMessage(db, m.message_id, 'PG1');
  expect(result.success).toBe(true);
  expect(result.message_id).toBe(m.message_id);
  const row = db.prepare('SELECT status, lock_owner FROM agent_collaboration_channel WHERE message_id = ?').get(m.message_id);
  expect(row.status).toBe('IN_PROGRESS');
  expect(row.lock_owner).toBe('PG1');
  db.close();
});

// ─── 6. claimMessage — 重複搶鎖回傳 success:false ────────────────────────
test('claimMessage: 已搶鎖訊息再次搶鎖應回傳 success:false', async () => {
  const db = makeDb();
  const m = await sendMessage(db, 'PG1', 'double-claim', 'SYSTEM', null, 5);
  claimMessage(db, m.message_id, 'PG1'); // 第一次搶鎖
  const result = claimMessage(db, m.message_id, 'PG2'); // 第二次搶鎖
  expect(result.success).toBe(false);
  db.close();
});

// ─── 7. claimMessage — 不存在的 message_id 回傳 success:false ────────────
test('claimMessage: 不存在的 message_id 應回傳 success:false', () => {
  const db = makeDb();
  const result = claimMessage(db, 'msg-nonexistent-uuid', 'PG1');
  expect(result.success).toBe(false);
  expect(result.reason).toMatch(/not found/i);
  db.close();
});

// ─── 8. ackMessage — 正確 owner ACK，status → READ ───────────────────────
test('ackMessage: 正確 owner ACK 後 status 應更新為 READ', async () => {
  const db = makeDb();
  const m = await sendMessage(db, 'PG1', 'to-ack', 'SYSTEM', null, 5);
  claimMessage(db, m.message_id, 'PG1');
  const result = ackMessage(db, m.message_id, 'PG1');
  expect(result.success).toBe(true);
  expect(result.message_id).toBe(m.message_id);
  const row = db.prepare('SELECT status FROM agent_collaboration_channel WHERE message_id = ?').get(m.message_id);
  expect(row.status).toBe('READ');
  db.close();
});

// ─── 9. ackMessage — 錯誤 owner ACK 回傳 success:false ──────────────────
test('ackMessage: 非 lock_owner 的 agent ACK 應回傳 success:false', async () => {
  const db = makeDb();
  const m = await sendMessage(db, 'PG1', 'wrong-owner-ack', 'SYSTEM', null, 5);
  claimMessage(db, m.message_id, 'PG1');
  const result = ackMessage(db, m.message_id, 'PG2'); // 錯誤 owner
  expect(result.success).toBe(false);
  expect(result.reason).toBeTruthy();
  db.close();
});
