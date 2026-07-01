import { IDENTITY, syncDbToJson, withRetry } from './db.mjs';

export async function addObservation(db, jsonPath, entityName, observationText) {
    if (!entityName || typeof entityName !== 'string' || entityName.length < 1 || entityName.length > 100)
        return { success: false, reason: 'validation_error', field: 'entityName' };
    if (!observationText || typeof observationText !== 'string' || observationText.length < 1 || observationText.length > 2000)
        return { success: false, reason: 'validation_error', field: 'observationText' };

    await withRetry(() => {
        db.exec('BEGIN IMMEDIATE');
        try {
            const existing = db.prepare('SELECT name FROM entities WHERE name = ?').get(entityName);
            if (!existing) {
                db.prepare(
                    `INSERT INTO entities (name, entityType, created_at, updated_at, last_written_by)
                     VALUES (?, 'unknown', datetime('now','localtime'), datetime('now','localtime'), ?)`
                ).run(entityName, IDENTITY);
            } else {
                db.prepare(
                    `UPDATE entities SET version = version + 1, updated_at = datetime('now','localtime'), last_written_by = ? WHERE name = ?`
                ).run(IDENTITY, entityName);
            }
            db.prepare(
                `INSERT INTO observations (entity_name, observation, created_at, last_written_by)
                 VALUES (?, ?, datetime('now','localtime'), ?)`
            ).run(entityName, observationText, IDENTITY);
            db.exec('COMMIT');
        } catch (err) {
            try { db.exec('ROLLBACK'); } catch (_) {}
            throw err;
        }
    });
    await withRetry(() => syncDbToJson(db, jsonPath));
}

export function queryEntity(db, entityName) {
    const entity = db.prepare('SELECT * FROM entities WHERE name = ?').get(entityName);
    if (!entity) return null;
    const observations = db.prepare('SELECT observation FROM observations WHERE entity_name = ? ORDER BY id ASC').all(entityName).map(r => r.observation);
    const relations = db.prepare('SELECT to_entity, relationType FROM relations WHERE from_entity = ?').all(entityName);
    return { ...entity, observations, relations };
}

export function getStats(db, dbPath) {
    return {
        entities:     db.prepare('SELECT COUNT(*) as c FROM entities').get().c,
        relations:    db.prepare('SELECT COUNT(*) as c FROM relations').get().c,
        observations: db.prepare('SELECT COUNT(*) as c FROM observations').get().c,
        dbPath,
    };
}

export async function createEntities(db, jsonPath, entities) {
    await withRetry(() => {
        const insertEntity = db.prepare(`INSERT OR IGNORE INTO entities (name, entityType, last_written_by) VALUES (?, ?, ?)`);
        const insertObs    = db.prepare(`INSERT INTO observations (entity_name, observation, last_written_by) VALUES (?, ?, ?)`);
        db.exec('BEGIN IMMEDIATE');
        try {
            for (const e of entities) {
                if (!e.name || !e.entityType) continue;
                insertEntity.run(e.name, e.entityType, IDENTITY);
                for (const obs of (e.observations ?? [])) insertObs.run(e.name, obs, IDENTITY);
            }
            db.exec('COMMIT');
        } catch (err) {
            try { db.exec('ROLLBACK'); } catch (_) {}
            throw err;
        }
    });
    syncDbToJson(db, jsonPath);
}

export async function addObservations(db, jsonPath, observations) {
    await withRetry(() => {
        const check  = db.prepare('SELECT name FROM entities WHERE name = ?');
        const insert = db.prepare(`INSERT INTO observations (entity_name, observation, last_written_by) VALUES (?, ?, ?)`);
        const update = db.prepare(`UPDATE entities SET version = version + 1, updated_at = datetime('now','localtime'), last_written_by = ? WHERE name = ?`);
        db.exec('BEGIN IMMEDIATE');
        try {
            for (const item of observations) {
                if (!check.get(item.entityName)) throw new Error(`找不到指定的實體：${item.entityName}`);
                for (const obs of item.contents) insert.run(item.entityName, obs, IDENTITY);
                update.run(IDENTITY, item.entityName);
            }
            db.exec('COMMIT');
        } catch (err) {
            try { db.exec('ROLLBACK'); } catch (_) {}
            throw err;
        }
    });
    syncDbToJson(db, jsonPath);
}

export async function createRelations(db, jsonPath, relations) {
    await withRetry(() => {
        const check        = db.prepare('SELECT name FROM entities WHERE name = ?');
        const insertEntity = db.prepare(`INSERT OR IGNORE INTO entities (name, entityType, last_written_by) VALUES (?, 'unknown', ?)`);
        const insertRel    = db.prepare(`INSERT OR IGNORE INTO relations (from_entity, to_entity, relationType, last_written_by) VALUES (?, ?, ?, ?)`);
        db.exec('BEGIN IMMEDIATE');
        try {
            for (const r of relations) {
                if (!r.from || !r.to || !r.relationType) continue;
                if (!check.get(r.from)) insertEntity.run(r.from, IDENTITY);
                if (!check.get(r.to))   insertEntity.run(r.to, IDENTITY);
                insertRel.run(r.from, r.to, r.relationType, IDENTITY);
            }
            db.exec('COMMIT');
        } catch (err) {
            try { db.exec('ROLLBACK'); } catch (_) {}
            throw err;
        }
    });
    syncDbToJson(db, jsonPath);
}

export function readGraph(db) {
    const entities = db.prepare('SELECT name, entityType FROM entities').all();
    const obsRows  = db.prepare('SELECT entity_name, observation FROM observations ORDER BY id ASC').all();
    const relRows  = db.prepare('SELECT from_entity, to_entity, relationType FROM relations').all();

    const obsMap = {};
    for (const r of obsRows) {
        if (!obsMap[r.entity_name]) obsMap[r.entity_name] = [];
        obsMap[r.entity_name].push(r.observation);
    }
    return {
        entities: entities.map(e => ({ name: e.name, entityType: e.entityType, observations: obsMap[e.name] ?? [] })),
        relations: relRows.map(r => ({ from: r.from_entity, to: r.to_entity, relationType: r.relationType })),
    };
}

export function searchNodes(db, query) {
    const q = `%${query}%`;
    const entityRows = db.prepare('SELECT name, entityType FROM entities WHERE name LIKE ? OR entityType LIKE ?').all(q, q);
    const obsRows    = db.prepare('SELECT DISTINCT entity_name FROM observations WHERE observation LIKE ?').all(q);

    const matched = new Set([...entityRows.map(r => r.name), ...obsRows.map(r => r.entity_name)]);
    if (!matched.size) return { entities: [], relations: [] };

    const ph    = Array(matched.size).fill('?').join(',');
    const names = Array.from(matched);
    const matchedEntities = db.prepare(`SELECT name, entityType FROM entities WHERE name IN (${ph})`).all(...names);
    const matchedObs      = db.prepare(`SELECT entity_name, observation FROM observations WHERE entity_name IN (${ph}) ORDER BY id ASC`).all(...names);
    const matchedRels     = db.prepare(`SELECT from_entity, to_entity, relationType FROM relations WHERE from_entity IN (${ph}) OR to_entity IN (${ph})`).all(...names, ...names);

    const obsMap = {};
    for (const r of matchedObs) {
        if (!obsMap[r.entity_name]) obsMap[r.entity_name] = [];
        obsMap[r.entity_name].push(r.observation);
    }
    return {
        entities: matchedEntities.map(e => ({ name: e.name, entityType: e.entityType, observations: obsMap[e.name] ?? [] })),
        relations: matchedRels.map(r => ({ from: r.from_entity, to: r.to_entity, relationType: r.relationType })),
    };
}
