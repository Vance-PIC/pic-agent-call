import { initDatabase } from '../src/db.mjs';
import {
  addObservation,
  queryEntity,
  getStats,
  createEntities,
  addObservations,
  createRelations,
  readGraph,
  searchNodes,
} from '../src/memory.mjs';
import os from 'node:os';
import path from 'node:path';

let _counter = 0;

// Each test gets its own unique jsonPath so _migrateFromJson never
// re-imports rows from a prior test's JSON into a fresh :memory: DB.
function makeDb() {
  const jsonPath = path.join(os.tmpdir(), `mem-test-${process.pid}-${++_counter}.json`);
  const db = initDatabase(':memory:', jsonPath);
  return { db, jsonPath };
}

// ─── 1. addObservation — 新增觀測，實體不存在時自動建立 ────────────────────
test('addObservation: 實體不存在時自動建立並寫入觀測', async () => {
  const { db, jsonPath } = makeDb();
  await addObservation(db, jsonPath, 'EntityA', '第一筆觀測');
  const entity = db.prepare('SELECT * FROM entities WHERE name = ?').get('EntityA');
  expect(entity).toBeTruthy();
  expect(entity.name).toBe('EntityA');
  const obs = db.prepare('SELECT observation FROM observations WHERE entity_name = ?').all('EntityA');
  expect(obs).toHaveLength(1);
  expect(obs[0].observation).toBe('第一筆觀測');
  db.close();
});

// ─── 2. addObservation — 重複觀測同一實體，version 遞增 ────────────────────
test('addObservation: 重複新增觀測，version 應遞增', async () => {
  const { db, jsonPath } = makeDb();
  await addObservation(db, jsonPath, 'EntityB', '觀測一');
  const before = db.prepare('SELECT version FROM entities WHERE name = ?').get('EntityB');
  await addObservation(db, jsonPath, 'EntityB', '觀測二');
  const after = db.prepare('SELECT version FROM entities WHERE name = ?').get('EntityB');
  expect(after.version).toBeGreaterThan(before.version);
  db.close();
});

// ─── 3. queryEntity — 查存在實體，含 observations 陣列 ────────────────────
test('queryEntity: 查詢存在的實體，回傳含 observations 陣列', async () => {
  const { db, jsonPath } = makeDb();
  await addObservation(db, jsonPath, 'EntityC', 'obs-alpha');
  await addObservation(db, jsonPath, 'EntityC', 'obs-beta');
  const result = queryEntity(db, 'EntityC');
  expect(result).not.toBeNull();
  expect(result.name).toBe('EntityC');
  expect(Array.isArray(result.observations)).toBe(true);
  expect(result.observations).toContain('obs-alpha');
  expect(result.observations).toContain('obs-beta');
  db.close();
});

// ─── 4. queryEntity — 查不存在實體，回傳 null ─────────────────────────────
test('queryEntity: 查詢不存在的實體，回傳 null', () => {
  const { db } = makeDb();
  const result = queryEntity(db, 'NoSuchEntity');
  expect(result).toBeNull();
  db.close();
});

// ─── 5. getStats — 回傳正確計數 ──────────────────────────────────────────
test('getStats: 回傳正確 entities/relations/observations 計數', async () => {
  const { db, jsonPath } = makeDb();
  await addObservation(db, jsonPath, 'S1', 'obs1');
  await addObservation(db, jsonPath, 'S1', 'obs2');
  await addObservation(db, jsonPath, 'S2', 'obs3');
  const stats = getStats(db, ':memory:');
  expect(stats.entities).toBe(2);
  expect(stats.observations).toBe(3);
  expect(typeof stats.relations).toBe('number');
  db.close();
});

// ─── 6. createEntities — 批次建立，同名 ignore ────────────────────────────
test('createEntities: 批次建立，同名實體只保留一筆', async () => {
  const { db, jsonPath } = makeDb();
  await createEntities(db, jsonPath, [
    { name: 'CE1', entityType: 'person', observations: ['obs-a'] },
    { name: 'CE2', entityType: 'place' },
    { name: 'CE1', entityType: 'person' }, // 重複，應 ignore
  ]);
  const count = db.prepare('SELECT COUNT(*) as c FROM entities WHERE name IN (?, ?)').get('CE1', 'CE2');
  expect(count.c).toBe(2);
  const obs = db.prepare('SELECT COUNT(*) as c FROM observations WHERE entity_name = ?').get('CE1');
  expect(obs.c).toBe(1);
  db.close();
});

// ─── 7. addObservations — 實體不存在時 throw ─────────────────────────────
test('addObservations: 實體不存在時應拋出錯誤', async () => {
  const { db, jsonPath } = makeDb();
  await expect(
    addObservations(db, jsonPath, [{ entityName: 'GhostEntity', contents: ['obs'] }])
  ).rejects.toThrow();
  db.close();
});

// ─── 8. addObservations — 成功新增 ────────────────────────────────────────
test('addObservations: 實體存在時成功批次新增觀測', async () => {
  const { db, jsonPath } = makeDb();
  await createEntities(db, jsonPath, [{ name: 'AO1', entityType: 'concept' }]);
  await addObservations(db, jsonPath, [{ entityName: 'AO1', contents: ['batch-obs-1', 'batch-obs-2'] }]);
  const obs = db.prepare('SELECT observation FROM observations WHERE entity_name = ?').all('AO1');
  expect(obs).toHaveLength(2);
  expect(obs.map(r => r.observation)).toContain('batch-obs-1');
  expect(obs.map(r => r.observation)).toContain('batch-obs-2');
  db.close();
});

// ─── 9. createRelations — 建立關聯，實體不存在自動建立 ─────────────────────
test('createRelations: 不存在的實體自動建立並建立關聯', async () => {
  const { db, jsonPath } = makeDb();
  await createRelations(db, jsonPath, [
    { from: 'Node1', to: 'Node2', relationType: 'knows' },
  ]);
  const fromEntity = db.prepare('SELECT name FROM entities WHERE name = ?').get('Node1');
  const toEntity = db.prepare('SELECT name FROM entities WHERE name = ?').get('Node2');
  expect(fromEntity).toBeTruthy();
  expect(toEntity).toBeTruthy();
  const rel = db.prepare('SELECT * FROM relations WHERE from_entity = ? AND to_entity = ?').get('Node1', 'Node2');
  expect(rel).toBeTruthy();
  expect(rel.relationType).toBe('knows');
  db.close();
});

// ─── 10. readGraph — 回傳所有 entities + relations ────────────────────────
test('readGraph: 回傳完整圖譜資料', async () => {
  const { db, jsonPath } = makeDb();
  await createEntities(db, jsonPath, [
    { name: 'RG1', entityType: 'thing', observations: ['rg-obs'] },
    { name: 'RG2', entityType: 'thing' },
  ]);
  await createRelations(db, jsonPath, [{ from: 'RG1', to: 'RG2', relationType: 'links' }]);
  const graph = readGraph(db);
  expect(Array.isArray(graph.entities)).toBe(true);
  expect(Array.isArray(graph.relations)).toBe(true);
  const names = graph.entities.map(e => e.name);
  expect(names).toContain('RG1');
  expect(names).toContain('RG2');
  const rg1 = graph.entities.find(e => e.name === 'RG1');
  expect(rg1.observations).toContain('rg-obs');
  expect(graph.relations).toHaveLength(1);
  expect(graph.relations[0].relationType).toBe('links');
  db.close();
});

// ─── 11. searchNodes — 依 name 模糊匹配 ──────────────────────────────────
test('searchNodes: 依 name 模糊匹配回傳正確實體', async () => {
  const { db, jsonPath } = makeDb();
  await createEntities(db, jsonPath, [
    { name: 'Alpha-Service', entityType: 'service' },
    { name: 'Beta-Service', entityType: 'service' },
    { name: 'Gamma-DB', entityType: 'database' },
  ]);
  const result = searchNodes(db, 'Service');
  const names = result.entities.map(e => e.name);
  expect(names).toContain('Alpha-Service');
  expect(names).toContain('Beta-Service');
  expect(names).not.toContain('Gamma-DB');
  db.close();
});

// ─── 12. searchNodes — 依 observation 模糊匹配 ────────────────────────────
test('searchNodes: 依 observation 內容模糊匹配回傳正確實體', async () => {
  const { db, jsonPath } = makeDb();
  await createEntities(db, jsonPath, [
    { name: 'ObsEntity1', entityType: 'thing', observations: ['contains unique-keyword here'] },
    { name: 'ObsEntity2', entityType: 'thing', observations: ['nothing relevant'] },
  ]);
  const result = searchNodes(db, 'unique-keyword');
  const names = result.entities.map(e => e.name);
  expect(names).toContain('ObsEntity1');
  expect(names).not.toContain('ObsEntity2');
  db.close();
});
