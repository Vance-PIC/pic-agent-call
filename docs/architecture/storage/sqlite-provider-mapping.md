# SQLite Provider Mapping

This document describes how the existing SQLite implementation mapping coordinates with the proposed **Storage Contract** for `pic-agent-call 2.0`. 

It separates the portable contract requirements from SQLite-specific database mechanics.

---

## 1. Store Mapping & Implementations

Under `pic-agent-call 2.0`, the files in `src/` will be organized under the SQLite Provider context. The current modules map directly to the contract ports:

```text
Abstract Ports (storage-ports.md)        SQLite Provider Implementation (src/)
┌─────────────────────────────────┐      ┌────────────────────────────────────┐
│ StorageProvider                 │ ───► │ SqliteStorageProvider              │
├─────────────────────────────────┤      ├────────────────────────────────────┤
│ AgentStore                      │ ───► │ SqliteAgentStore (status.mjs)      │
│ ChannelStore                    │ ───► │ SqliteChannelStore (channel.mjs)   │
│ TaskStore                       │ ───► │ SqliteTaskStore (tasks.mjs)        │
│ MemoryStore                     │ ───► │ SqliteMemoryStore (memory.mjs)     │
└─────────────────────────────────┘      └────────────────────────────────────┘
```

---

## 2. Invariant Enforcement Mapping

| Contract Requirement (Constraint) | SQLite Implementation Mechanism |
| --- | --- |
| **Only one active agent per term_key** | A partial unique index: `CREATE UNIQUE INDEX idx_agents_term_active ON agents(term_key) WHERE status = 'active'` |
| **No Jitter Statusline Ordering** | Query clause: `ORDER BY created_at ASC` on the `agents` table |
| **Broadcast Delivery (Sender excluded)** | Multi-record transaction: Query all active agents where `agent_id != sender`, then loop-insert individual messages |
| **Task Claiming Exclusivity** | SQLite Row-Locking simulation via `BEGIN IMMEDIATE` transaction + update change check (`changes === 1`) |
| **Task Idempotency Protection** | Unique index `idx_tasks_payload_hash ON tasks(payload_hash)` plus `SELECT` preflight check before inserting |
| **Referential Integrity** | Schema-level foreign keys with `ON DELETE CASCADE` + `PRAGMA foreign_keys = ON` |

---

## 3. Transaction & Locking Mechanics

SQLite uses file-level locking. To prevent concurrent write operations from generating `SQLITE_BUSY` errors:

1.  **Atomic Transactions**: The provider wraps write operations in `BEGIN IMMEDIATE` instead of standard `BEGIN`. This acquires a *Reserved Lock* immediately, preventing other writers from starting transaction blocks until the current transaction commits or rolls back.
2.  **Retry Loop (`withRetry`)**: If a transaction encounters `SQLITE_BUSY` or `database is locked`, the provider catches the exception, waits with exponential backoff plus randomized jitter, and retries the operation up to 20 times.
3.  **Timeout configuration**: `PRAGMA busy_timeout = 30000` is set at bootstrap to allow SQLite to handle short lock durations internally before leaking the error to the provider level.

---

## 4. Timestamps & Timezones

*   **Representation**: SQLite lacks a native DateTime type. The provider represents dates as ISO-like strings using local system time: `datetime('now','localtime')`.
*   **Time comparison**: Timeout queries use SQLite string-modifier logic for temporal comparison, e.g., `last_seen < datetime('now','localtime','-15 minutes')`.
*   **Transition to Contract**: The ports return ISO-8601 string representations. The SQLite provider handles translation between string-formatted rows and normalized Date objects.

---

## 5. Schema Migration & Synchronization

### Migration Ownership
The SQLite Provider owns its initialization and migration script. On bootstrap, the `initialize()` port checks column structure (via `PRAGMA table_info`) and applies sequential scripts (e.g., rebuilding nullable columns, adding index hooks) within a `BEGIN IMMEDIATE` block.

### JSON Snapshot Synchronization (`syncDbToJson`)
The SQLite provider maintains compatibility with the legacy JSON memory format. 
*   **Debounced Write**: After any write modifications to entities or observations, the provider triggers a debounced sync (`DEBOUNCE_MS = 600`) to query the graph and output it to `memory-graph.json`.
*   **Teardown handling**: The `close()` method cancels any pending sync timers to prevent post-close file access exceptions.
