import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { DatabaseSync } from 'node:sqlite';

export const IDENTITY = `PID:${process.pid} | USER:${process.env.USERNAME || process.env.USER || 'unknown'}`;

const MAX_RETRIES = 20;
const RETRY_BASE_MS = 5;

function _findProjectRoot(startDir) {
    let dir = startDir;
    const root = path.parse(dir).root;
    while (dir !== root) {
        if (fs.existsSync(path.join(dir, '.git')) || fs.existsSync(path.join(dir, 'package.json'))) {
            return dir;
        }
        const parent = path.dirname(dir);
        if (parent === dir) break;
        dir = parent;
    }
    return null;
}

export function readAgentSettings() {
    const defaults = { agentTimeoutMin: 1440, statusLineFreshnessMin: 120, historyPurgeMin: 10080 };
    const projectRoot = _findProjectRoot(process.cwd());
    if (!projectRoot) return defaults;
    const settingsPath = path.join(projectRoot, 'settings.local.json');
    if (!fs.existsSync(settingsPath)) return defaults;
    try {
        const s = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
        return {
            agentTimeoutMin:      Number.isFinite(s.agentTimeoutMin)      ? s.agentTimeoutMin      : defaults.agentTimeoutMin,
            statusLineFreshnessMin: Number.isFinite(s.statusLineFreshnessMin) ? s.statusLineFreshnessMin : defaults.statusLineFreshnessMin,
            historyPurgeMin:      Number.isFinite(s.historyPurgeMin)      ? s.historyPurgeMin      : defaults.historyPurgeMin,
        };
    } catch (_) { return defaults; }
}

export function resolveMemoryPaths() {
    if (process.env.MEMORY_DB_PATH) {
        const dbPath = process.env.MEMORY_DB_PATH;
        return { dbPath, jsonPath: path.join(path.dirname(dbPath), 'memory-graph.json') };
    }

    // 向上遞迴尋找專案根目錄，防止不同 cwd 啟動時讀寫不同 DB（防分裂）
    const projectRoot = _findProjectRoot(process.cwd());

    if (projectRoot) {
        const settingsPath = path.join(projectRoot, 'settings.local.json');
        if (fs.existsSync(settingsPath)) {
            try {
                const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
                if (settings.memoryDbPath) {
                    const dbPath = settings.memoryDbPath;
                    return { dbPath, jsonPath: path.join(path.dirname(dbPath), 'memory-graph.json') };
                }
            } catch (_) {}
        }

        const projectMemoryDir = path.join(projectRoot, '.memory');
        try {
            if (!fs.existsSync(projectMemoryDir)) fs.mkdirSync(projectMemoryDir, { recursive: true });
            fs.accessSync(projectMemoryDir, fs.constants.W_OK);
            return {
                dbPath: path.join(projectMemoryDir, 'memory-graph.db'),
                jsonPath: path.join(projectMemoryDir, 'memory-graph.json'),
            };
        } catch (_) {}
    }

    const homeMemoryDir = path.join(os.homedir(), '.memory');
    if (!fs.existsSync(homeMemoryDir)) fs.mkdirSync(homeMemoryDir, { recursive: true });
    return {
        dbPath: path.join(homeMemoryDir, 'memory-graph.db'),
        jsonPath: path.join(homeMemoryDir, 'memory-graph.json'),
    };
}

export function initDatabase(dbPath, jsonPath) {
    const db = new DatabaseSync(dbPath);

    db.exec('PRAGMA busy_timeout = 30000');
    db.exec('PRAGMA journal_mode = WAL');
    db.exec('PRAGMA foreign_keys = ON');

    db.exec(`CREATE TABLE IF NOT EXISTS entities (
        name TEXT PRIMARY KEY,
        entityType TEXT NOT NULL,
        description TEXT,
        version INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
        last_written_by TEXT NOT NULL
    )`);

    db.exec(`CREATE TABLE IF NOT EXISTS relations (
        from_entity TEXT NOT NULL,
        to_entity TEXT NOT NULL,
        relationType TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
        last_written_by TEXT NOT NULL,
        PRIMARY KEY (from_entity, to_entity, relationType),
        FOREIGN KEY (from_entity) REFERENCES entities(name) ON DELETE CASCADE,
        FOREIGN KEY (to_entity) REFERENCES entities(name) ON DELETE CASCADE
    )`);

    db.exec(`CREATE TABLE IF NOT EXISTS observations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        entity_name TEXT NOT NULL,
        observation TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
        last_written_by TEXT NOT NULL,
        FOREIGN KEY (entity_name) REFERENCES entities(name) ON DELETE CASCADE
    )`);

    db.exec(`CREATE TABLE IF NOT EXISTS tasks (
        task_id      TEXT PRIMARY KEY,
        feature      TEXT NOT NULL,
        assign_to    TEXT NOT NULL,
        payload      TEXT NOT NULL,
        type         TEXT NOT NULL DEFAULT 'task' CHECK(type IN ('task','final')),
        status       TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','claimed','completed','failed')),
        claimed_by   TEXT,
        claimed_at   TEXT,
        completed_at TEXT,
        result       TEXT,
        fail_reason  TEXT,
        relay_to     TEXT,
        payload_hash TEXT NOT NULL,
        created_at   TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
        updated_at   TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
    )`);
    db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_tasks_payload_hash ON tasks(payload_hash)`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_tasks_status_assign ON tasks(status, assign_to)`);

    db.exec(`CREATE TABLE IF NOT EXISTS agents (
        agent_id          TEXT PRIMARY KEY,
        last_seen         TEXT,
        status            TEXT NOT NULL DEFAULT 'offline' CHECK(status IN ('active','attached','offline')),
        agent_timeout_sec INTEGER NOT NULL DEFAULT 86400,
        poll_interval_sec INTEGER NOT NULL DEFAULT 30,
        term_key          TEXT NOT NULL DEFAULT '',
        created_at        TEXT NOT NULL DEFAULT (datetime('now','localtime')),
        updated_at        TEXT NOT NULL DEFAULT (datetime('now','localtime'))
    )`);

    db.exec(`CREATE TABLE IF NOT EXISTS agent_collaboration_channel (
        message_id TEXT PRIMARY KEY,
        sender     TEXT NOT NULL,
        receiver   TEXT NOT NULL,
        priority   INTEGER DEFAULT 5,
        status     TEXT DEFAULT 'UNREAD',
        lock_owner TEXT,
        lock_time  TEXT,
        message    TEXT NOT NULL,
        created_at TEXT DEFAULT (datetime('now','localtime')),
        updated_at TEXT DEFAULT (datetime('now','localtime'))
    )`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_acc_receiver_status ON agent_collaboration_channel(receiver, status)`);

    // 向下相容遷移
    for (const sql of [
        `ALTER TABLE tasks ADD COLUMN type TEXT NOT NULL DEFAULT 'task' CHECK(type IN ('task','final'))`,
        `ALTER TABLE tasks ADD COLUMN relay_to TEXT`,
        `ALTER TABLE agents ADD COLUMN term_key TEXT`,
        `ALTER TABLE agents ADD COLUMN session_id TEXT`,
        `ALTER TABLE agents ADD COLUMN role TEXT`,
    ]) {
        try { db.exec(sql); } catch (err) {
            if (!String(err.message).includes('duplicate column')) throw err;
        }
    }
    // v1.1.0 多角色：session_id 改非唯一索引
    try { db.exec(`DROP INDEX IF EXISTS idx_agents_session_id`); } catch (_) {}
    db.exec(`CREATE INDEX IF NOT EXISTS idx_agents_session_id ON agents(session_id)`);
    // v1.1.3 term_key 索引：statusline 優先以 PIC_TERM_KEY 直查
    db.exec(`CREATE INDEX IF NOT EXISTS idx_agents_term_key ON agents(term_key)`);
    // v1.1.4 廢除 is_primary：移除舊索引
    // 注意：is_primary 欄位本身未物理移除（SQLite DROP COLUMN 有前提限制）
    // 欄位已廢棄不使用，DB 邏輯以 status='active'/'attached' 為準
    try { db.exec(`DROP INDEX IF EXISTS idx_agents_session_primary`); } catch (_) {}
    // v1.1.4 三態：NULL term_key 補空字串
    db.exec(`UPDATE agents SET term_key = '' WHERE term_key IS NULL`);
    // v1.2.2 強制重建 idx_agents_term_active（predicate 從 "... AND term_key != ''" 改為無豁免）
    // IF NOT EXISTS 無法更新 predicate，必須先 DROP 再 CREATE
    try { db.exec(`DROP INDEX IF EXISTS idx_agents_term_active`); } catch (_) {}
    db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_agents_term_active ON agents(term_key) WHERE status = 'active'`);

    const row = db.prepare('SELECT COUNT(*) as count FROM entities').get();
    if (row.count === 0 && fs.existsSync(jsonPath)) {
        _migrateFromJson(db, jsonPath);
    }

    return db;
}

export function setup(options = {}) {
    const paths = options.dbPath
        ? { dbPath: options.dbPath, jsonPath: path.join(path.dirname(options.dbPath), 'memory-graph.json') }
        : resolveMemoryPaths();
    const db = initDatabase(paths.dbPath, paths.jsonPath);
    return { db, dbPath: paths.dbPath, jsonPath: paths.jsonPath };
}

// 防抖計時器 map：jsonPath → timer handle
const _syncTimers = new Map();
const DEBOUNCE_MS = 600;

export function syncDbToJson(db, jsonPath) {
    // 清除前一個計時器，重新計時（防抖）
    if (_syncTimers.has(jsonPath)) clearTimeout(_syncTimers.get(jsonPath));
    const timer = setTimeout(() => {
        _syncTimers.delete(jsonPath);
        _doSyncDbToJson(db, jsonPath);
    }, DEBOUNCE_MS);
    _syncTimers.set(jsonPath, timer);
}

async function _doSyncDbToJson(db, jsonPath) {
    try {
        const rows = db.prepare(`
            SELECT e.name, e.entityType, e.description, o.observation
            FROM entities e
            LEFT JOIN observations o ON e.name = o.entity_name
            ORDER BY e.name, o.id ASC
        `).all();

        const map = {};
        for (const row of rows) {
            if (!map[row.name]) {
                map[row.name] = { type: 'entity', name: row.name, entityType: row.entityType, observations: [] };
            }
            if (row.observation) map[row.name].observations.push(row.observation);
        }

        const jsonLines = Object.values(map).map(o => JSON.stringify(o)).join('\n') + '\n';
        const tmpPath = `${jsonPath}.${process.pid}.tmp`;
        await fs.promises.writeFile(tmpPath, jsonLines, 'utf8');
        try {
            await fs.promises.rename(tmpPath, jsonPath);
        } catch (renameErr) {
            try { await fs.promises.unlink(tmpPath); } catch (_) {}
            try {
                await fs.promises.writeFile(jsonPath, jsonLines, 'utf8');
            } catch (writeErr) {
                console.error('[pic-agent-call] _doSyncDbToJson: fallback write failed', writeErr);
            }
        }
    } catch (err) {
        console.error('[pic-agent-call] _doSyncDbToJson: sync failed', err);
    }
}

export async function withRetry(fn, maxRetries = MAX_RETRIES) {
    for (let i = 0; i < maxRetries; i++) {
        try {
            return fn();
        } catch (err) {
            const busy = String(err.message || '').includes('SQLITE_BUSY') ||
                         String(err.message || '').includes('database is locked') ||
                         err.code === 'ERR_OPTIMISTIC_LOCK_FAILED';
            if (busy && i < maxRetries - 1) {
                const wait = Math.pow(2, i) * RETRY_BASE_MS + Math.random() * 10;
                await new Promise(r => setTimeout(r, wait));
                continue;
            }
            if (busy) {
                const e = new Error('ERR_DATABASE_LOCKED');
                e.code = 'ERR_DATABASE_LOCKED';
                throw e;
            }
            throw err;
        }
    }
}

function _migrateFromJson(db, jsonPath) {
    let raw;
    try {
        raw = fs.readFileSync(jsonPath, 'utf8');
        if (raw.startsWith('﻿')) raw = raw.slice(1);
    } catch (_) { return; }

    const lines = raw.split(/\r?\n/).filter(l => l.trim());
    if (!lines.length) return;

    const insertEntity = db.prepare(
        `INSERT OR IGNORE INTO entities (name, entityType, description, created_at, updated_at, last_written_by)
         VALUES (?, ?, ?, datetime('now','localtime'), datetime('now','localtime'), ?)`
    );
    const insertObs = db.prepare(
        `INSERT INTO observations (entity_name, observation, created_at, last_written_by)
         VALUES (?, ?, datetime('now','localtime'), ?)`
    );

    db.exec('BEGIN IMMEDIATE');
    try {
        for (const line of lines) {
            let entity;
            try { entity = JSON.parse(line); } catch (_) { continue; }
            if (!entity.name || !entity.entityType) continue;
            insertEntity.run(entity.name, entity.entityType, entity.description || null, IDENTITY);
            for (const obs of (entity.observations ?? [])) {
                insertObs.run(entity.name, obs, IDENTITY);
            }
        }
        db.exec('COMMIT');
    } catch (err) {
        db.exec('ROLLBACK');
        throw err;
    }
}
