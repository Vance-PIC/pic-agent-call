import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { DatabaseSync } from 'node:sqlite';

export const IDENTITY = `PID:${process.pid} | USER:${process.env.USERNAME || process.env.USER || 'unknown'}`;

const MAX_RETRIES = 20;
const RETRY_BASE_MS = 5;

export function resolveMemoryPaths() {
    if (process.env.MEMORY_DB_PATH) {
        const dbPath = process.env.MEMORY_DB_PATH;
        return { dbPath, jsonPath: path.join(path.dirname(dbPath), 'memory-graph.json') };
    }

    const settingsPath = path.join(process.cwd(), 'settings.local.json');
    if (fs.existsSync(settingsPath)) {
        try {
            const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
            if (settings.memoryDbPath) {
                const dbPath = settings.memoryDbPath;
                return { dbPath, jsonPath: path.join(path.dirname(dbPath), 'memory-graph.json') };
            }
        } catch (_) {}
    }

    const projectMemoryDir = path.join(process.cwd(), '.memory');
    try {
        if (!fs.existsSync(projectMemoryDir)) fs.mkdirSync(projectMemoryDir, { recursive: true });
        fs.accessSync(projectMemoryDir, fs.constants.W_OK);
        return {
            dbPath: path.join(projectMemoryDir, 'memory-graph.db'),
            jsonPath: path.join(projectMemoryDir, 'memory-graph.json'),
        };
    } catch (_) {}

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
        status            TEXT NOT NULL DEFAULT 'offline' CHECK(status IN ('active','offline')),
        agent_timeout_sec INTEGER NOT NULL DEFAULT 120,
        poll_interval_sec INTEGER NOT NULL DEFAULT 30,
        term_key          TEXT,
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
        try { db.exec(sql); } catch (_) {}
    }
    // v1.1.0 多角色：session_id 改非唯一索引
    try { db.exec(`DROP INDEX IF EXISTS idx_agents_session_id`); } catch (_) {}
    db.exec(`CREATE INDEX IF NOT EXISTS idx_agents_session_id ON agents(session_id)`);

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
        } catch (_) {
            try { await fs.promises.unlink(tmpPath); } catch (__) {}
            await fs.promises.writeFile(jsonPath, jsonLines, 'utf8');
        }
    } catch (_) {}
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
