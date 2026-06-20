/**
 * tests/db.test.mjs
 * Jest unit tests for src/db.mjs
 * Coverage target: >= 80%
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { DatabaseSync } from 'node:sqlite';

// ── helpers ───────────────────────────────────────────────────────────────────

/** Create a unique temp dir for each test run */
function makeTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'db-test-'));
}

/** Remove a directory tree, swallow errors */
function rimraf(p) {
  try {
    fs.rmSync(p, { recursive: true, force: true });
  } catch (_) {}
}

// ── import the module under test ──────────────────────────────────────────────

// Dynamic import is needed because the module is ESM
let resolveMemoryPaths, initDatabase, setup, syncDbToJson, withRetry;

beforeAll(async () => {
  const mod = await import('../src/db.mjs');
  resolveMemoryPaths = mod.resolveMemoryPaths;
  initDatabase       = mod.initDatabase;
  setup              = mod.setup;
  syncDbToJson       = mod.syncDbToJson;
  withRetry          = mod.withRetry;
});

// ── 1. resolveMemoryPaths — MEMORY_DB_PATH env var ───────────────────────────

describe('resolveMemoryPaths()', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = makeTmpDir();
  });

  afterEach(() => {
    delete process.env.MEMORY_DB_PATH;
    rimraf(tmpDir);
  });

  test('1. uses MEMORY_DB_PATH env var when set', () => {
    const dbPath = path.join(tmpDir, 'custom.db');
    process.env.MEMORY_DB_PATH = dbPath;

    const result = resolveMemoryPaths();

    expect(result.dbPath).toBe(dbPath);
    expect(result.jsonPath).toBe(path.join(tmpDir, 'memory-graph.json'));
  });

  test('2. falls back to cwd/.memory when env var is not set', () => {
    // Make sure env is clean
    delete process.env.MEMORY_DB_PATH;

    // Temporarily override process.cwd to point to our tmpDir
    // (settings.local.json does not exist there, so it goes to .memory fallback)
    const origCwd = process.cwd;
    process.cwd = () => tmpDir;

    try {
      const result = resolveMemoryPaths();
      const expectedDir = path.join(tmpDir, '.memory');

      expect(result.dbPath).toBe(path.join(expectedDir, 'memory-graph.db'));
      expect(result.jsonPath).toBe(path.join(expectedDir, 'memory-graph.json'));
      // The directory should have been created
      expect(fs.existsSync(expectedDir)).toBe(true);
    } finally {
      process.cwd = origCwd;
    }
  });
});

// ── 2. initDatabase() ─────────────────────────────────────────────────────────

describe('initDatabase()', () => {
  let tmpDir;
  let db;

  beforeEach(() => {
    tmpDir = makeTmpDir();
  });

  afterEach(() => {
    try { db?.close(); } catch (_) {}
    rimraf(tmpDir);
  });

  test('3. creates all 6 required tables', () => {
    const dbPath   = path.join(tmpDir, 'test.db');
    const jsonPath = path.join(tmpDir, 'memory-graph.json');
    db = initDatabase(dbPath, jsonPath);

    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all()
      .map(r => r.name);

    const required = [
      'entities',
      'relations',
      'observations',
      'tasks',
      'agents',
      'agent_collaboration_channel',
    ];

    for (const t of required) {
      expect(tables).toContain(t);
    }
  });

  test('4. WAL journal_mode is enabled', () => {
    const dbPath   = path.join(tmpDir, 'wal-test.db');
    const jsonPath = path.join(tmpDir, 'memory-graph.json');
    db = initDatabase(dbPath, jsonPath);

    const row = db.prepare('PRAGMA journal_mode').get();
    expect(row.journal_mode).toBe('wal');
  });
});

// ── 3. setup() ────────────────────────────────────────────────────────────────

describe('setup()', () => {
  let tmpDir;
  let result;

  afterEach(() => {
    try { result?.db?.close(); } catch (_) {}
    rimraf(tmpDir);
  });

  test('5. returns { db, dbPath, jsonPath }', () => {
    tmpDir = makeTmpDir();
    const dbPath = path.join(tmpDir, 'setup-test.db');

    result = setup({ dbPath });

    expect(result).toHaveProperty('db');
    expect(result).toHaveProperty('dbPath', dbPath);
    expect(result).toHaveProperty('jsonPath');
    expect(result.db).toBeInstanceOf(DatabaseSync);
  });

  test('6. uses the provided dbPath', () => {
    tmpDir = makeTmpDir();
    const dbPath = path.join(tmpDir, 'explicit.db');

    result = setup({ dbPath });

    expect(result.dbPath).toBe(dbPath);
    expect(fs.existsSync(dbPath)).toBe(true);
  });
});

// ── 4. syncDbToJson() ─────────────────────────────────────────────────────────

describe('syncDbToJson()', () => {
  let tmpDir;
  let db;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    const dbPath   = path.join(tmpDir, 'sync-test.db');
    const jsonPath = path.join(tmpDir, 'memory-graph.json');
    db = initDatabase(dbPath, jsonPath);
  });

  afterEach(() => {
    try { db?.close(); } catch (_) {}
    rimraf(tmpDir);
  });

  test('7. writes correct JSON Lines format', () => {
    // Insert one entity with two observations
    db.exec(`
      INSERT INTO entities (name, entityType, last_written_by)
      VALUES ('TestEntity', 'concept', 'test')
    `);
    db.exec(`
      INSERT INTO observations (entity_name, observation, last_written_by)
      VALUES ('TestEntity', 'obs-one', 'test'),
             ('TestEntity', 'obs-two', 'test')
    `);

    const jsonPath = path.join(tmpDir, 'out.json');
    syncDbToJson(db, jsonPath);

    const raw   = fs.readFileSync(jsonPath, 'utf8');
    const lines = raw.trim().split('\n').filter(Boolean);

    expect(lines).toHaveLength(1);

    const parsed = JSON.parse(lines[0]);
    expect(parsed.type).toBe('entity');
    expect(parsed.name).toBe('TestEntity');
    expect(parsed.entityType).toBe('concept');
    expect(parsed.observations).toEqual(['obs-one', 'obs-two']);
  });
});

// ── 5. withRetry() ────────────────────────────────────────────────────────────

describe('withRetry()', () => {
  test('8. returns immediately on first success', async () => {
    const result = await withRetry(() => 42);
    expect(result).toBe(42);
  });

  test('9. retries on SQLITE_BUSY and eventually succeeds', async () => {
    let calls = 0;
    const fn = () => {
      calls++;
      if (calls < 3) {
        const err = new Error('SQLITE_BUSY: database is locked');
        throw err;
      }
      return 'ok';
    };

    const result = await withRetry(fn, 5);
    expect(result).toBe('ok');
    expect(calls).toBe(3);
  }, 15000); // allow time for exponential backoff

  test('10. throws ERR_DATABASE_LOCKED after maxRetries exhausted', async () => {
    const fn = () => {
      const err = new Error('SQLITE_BUSY: database is locked');
      throw err;
    };

    await expect(withRetry(fn, 3)).rejects.toMatchObject({
      message: 'ERR_DATABASE_LOCKED',
      code:    'ERR_DATABASE_LOCKED',
    });
  }, 15000);
});
