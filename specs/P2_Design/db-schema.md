# DB Schema (L2) — pic-agent-call v1.0.0

沿用 `agent-call` 現有 schema，零遷移成本。
DB 初始化由 `src/db.mjs initDatabase()` 負責。

---

## entities

```sql
CREATE TABLE IF NOT EXISTS entities (
    name             TEXT PRIMARY KEY,
    entityType       TEXT NOT NULL,
    description      TEXT,
    version          INTEGER NOT NULL DEFAULT 1,
    created_at       TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
    updated_at       TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
    last_written_by  TEXT NOT NULL
)
```

## observations

```sql
CREATE TABLE IF NOT EXISTS observations (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    entity_name      TEXT NOT NULL,
    observation      TEXT NOT NULL,
    created_at       TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
    last_written_by  TEXT NOT NULL,
    FOREIGN KEY (entity_name) REFERENCES entities(name) ON DELETE CASCADE
)
```

## relations

```sql
CREATE TABLE IF NOT EXISTS relations (
    from_entity      TEXT NOT NULL,
    to_entity        TEXT NOT NULL,
    relationType     TEXT NOT NULL,
    created_at       TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
    last_written_by  TEXT NOT NULL,
    PRIMARY KEY (from_entity, to_entity, relationType),
    FOREIGN KEY (from_entity) REFERENCES entities(name) ON DELETE CASCADE,
    FOREIGN KEY (to_entity)   REFERENCES entities(name) ON DELETE CASCADE
)
```

## tasks

```sql
CREATE TABLE IF NOT EXISTS tasks (
    task_id       TEXT PRIMARY KEY,
    feature       TEXT NOT NULL,
    assign_to     TEXT NOT NULL,
    payload       TEXT NOT NULL,
    type          TEXT NOT NULL DEFAULT 'task' CHECK(type IN ('task','final')),
    status        TEXT NOT NULL DEFAULT 'pending'
                      CHECK(status IN ('pending','claimed','completed','failed')),
    claimed_by    TEXT,
    claimed_at    TEXT,
    completed_at  TEXT,
    result        TEXT,
    fail_reason   TEXT,
    relay_to      TEXT,
    payload_hash  TEXT NOT NULL,
    created_at    TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
    updated_at    TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
)
CREATE UNIQUE INDEX idx_tasks_payload_hash ON tasks(payload_hash)
CREATE INDEX idx_tasks_status_assign ON tasks(status, assign_to)
```

## agents

```sql
CREATE TABLE IF NOT EXISTS agents (
    agent_id           TEXT PRIMARY KEY,
    last_seen          TEXT,
    status             TEXT NOT NULL DEFAULT 'offline' CHECK(status IN ('active','offline')),
    agent_timeout_sec  INTEGER NOT NULL DEFAULT 120,
    poll_interval_sec  INTEGER NOT NULL DEFAULT 30,
    term_key           TEXT,
    created_at         TEXT NOT NULL DEFAULT (datetime('now','localtime')),
    updated_at         TEXT NOT NULL DEFAULT (datetime('now','localtime'))
)
```

## agent_collaboration_channel

```sql
CREATE TABLE IF NOT EXISTS agent_collaboration_channel (
    message_id  TEXT PRIMARY KEY,
    sender      TEXT NOT NULL,
    receiver    TEXT NOT NULL,
    priority    INTEGER DEFAULT 5,
    status      TEXT DEFAULT 'UNREAD',
    lock_owner  TEXT,
    lock_time   TEXT,
    message     TEXT NOT NULL,
    created_at  TEXT DEFAULT (datetime('now','localtime')),
    updated_at  TEXT DEFAULT (datetime('now','localtime'))
)
CREATE INDEX idx_acc_receiver_status ON agent_collaboration_channel(receiver, status)
```

---

## 自動遷移

`initDatabase()` 啟動時執行（ALTER TABLE，欄位已存在則 ignore）：
- `tasks` 補 `type` 欄位
- `tasks` 補 `relay_to` 欄位
- `agents` 補 `term_key` 欄位
- entities 為空且 JSON 快照存在 → `migrateFromJson()` 自動匯入
