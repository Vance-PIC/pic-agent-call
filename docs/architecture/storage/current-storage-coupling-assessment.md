# Current-State Storage Coupling Assessment

## 1. Executive Summary

The current implementation of `pic-agent-call 1.x` has storage logic deeply intertwined with domain and coordination use cases. Specifically, `node:sqlite` APIs, SQL query syntax, SQLite-specific migration logic, and database constraints are leaked across all coordination modules (`status.mjs`, `channel.mjs`, `tasks.mjs`, and `memory.mjs`). 

Decoupling coordination from storage requires identifying and isolating these leakage points into a clear **Storage Contract**.

---

## 2. Storage Dependency Map

The current dependency structure exhibits tight coupling to SQLite, violating the Dependency Inversion Principle (DIP):

```text
MCP Server Interface (bin/server.mjs)
       │
       ├─► status.mjs  ──► [node:sqlite DatabaseSync] ──► SQLite DB File
       ├─► channel.mjs ──► [node:sqlite DatabaseSync] ──► SQLite DB File
       ├─► tasks.mjs   ──► [node:sqlite DatabaseSync] ──► SQLite DB File
       └─► memory.mjs  ──► [node:sqlite DatabaseSync] ──► SQLite DB File
```

In the target architecture, all domain and coordination modules must depend only on abstract interfaces, and the SQLite provider must implement these interfaces.

---

## 3. Storage Coupling Inventory

### 3.1 Direct SQL Usage & Table-Name Dependencies
Every coordination module writes raw SQL queries and prepares statements directly:
*   **Leakage Points**: `status.mjs`, `channel.mjs`, `tasks.mjs`, and `memory.mjs` all directly prepare SQL statements against tables: `agents`, `agent_collaboration_channel`, `tasks`, `entities`, `observations`, `relations`.
*   **Classification**: *Storage Contract Rule / Technical Debt*.

### 3.2 Database Driver Leakage (`node:sqlite` APIs)
The application expects database connections to be instances of SQLite's `DatabaseSync` class.
*   **Leakage**: Preparation of statements (`db.prepare(...)`), transactional execution (`db.exec(...)`), and execution operations (`stmt.get()`, `stmt.run()`, `stmt.all()`).
*   **Returned Types**: Coordination logic directly handles raw database rows (untyped JSON objects matching SQL schemas) and expects row update counts via `.changes`.
*   **Classification**: *SQLite Provider Implementation Detail*.

### 3.3 SQLite Pragmas
Storage connection configurations are defined directly in the initialization lifecycle:
*   **Leakage**: `PRAGMA busy_timeout = 30000`, `PRAGMA journal_mode = WAL`, and `PRAGMA foreign_keys = ON` in `db.mjs`.
*   **Classification**: *SQLite Provider Implementation Detail*.

### 3.4 SQLite-Specific Conflict Handling & Unique Constraints
The codebase relies on database-level constraints and syntax to enforce business logic:
*   **Leakage**:
    *   `INSERT OR IGNORE` in `db.mjs`, `memory.mjs`.
    *   `ON CONFLICT(agent_id) DO UPDATE` in `status.mjs` to implement forced agent takeover.
    *   Unique index `idx_agents_term_active` (`term_key` where `status = 'active'`) to enforce that only one agent is active per terminal context.
*   **Classification**: *Domain Rules currently enforced only through database constraints*.

### 3.5 Implicit Transaction Assumptions
Coordination services directly handle database transaction statements:
*   **Leakage**: Explicit calls to `db.exec('BEGIN IMMEDIATE')`, `db.exec('COMMIT')`, and `db.exec('ROLLBACK')` are scattered throughout the codebase.
*   **Classification**: *Technical Debt / Transaction Concern*.

### 3.6 Migration Logic Mixed with Runtime Logic
Schema definition and version migration are executed as part of the bootstrap phase in `db.mjs`:
*   **Leakage**: `initDatabase` executes schema migration (`ALTER TABLE ... ADD COLUMN`, `DROP INDEX`, rebuilding the `agents` table).
*   **Classification**: *Migration Concern*.

### 3.7 Heartbeat and Timeout Side-Effects in Read Operations
The read operation `getAgentStatus` performs write operations inside its execution body:
*   **Leakage**: `getAgentStatus` calls `UPDATE agents SET status = 'offline' ...` to sweep expired agents, and `DELETE FROM agents ...` to purge old history. It also schedules a `setImmediate` callback to update the active agent's `last_seen` timestamp.
*   **Classification**: *Application Coordination Rule*.

---

## 4. Risks & Technical Debt

1.  **Vendor Lock-in**: Porting the project to another database provider (e.g., PostgreSQL for multi-tenant cloud deployment) requires rewriting 100% of the coordination files.
2.  **Concurrency Vulnerabilities**: While `withRetry` in `db.mjs` retries lock acquisition on `SQLITE_BUSY`, this retry logic is tightly coupled to SQLite error strings. A different database provider will throw different concurrency exceptions, bypassing error checking.
3.  **Untestability**: Test suites mock files and parameters but are forced to spin up actual SQLite files. There is no mock storage provider, making tests slower and prone to file system locks.
4.  **Implicit Schema Leaks**: SQLite does not support native `Date` types; timestamps are formatted as local string representations (`datetime('now','localtime')`). This limits portability to systems with standard timestamp representations.

---

## 5. Unresolved Questions

1.  *Should SQLite's WAL mode and journaling constraints be modeled as part of the health-check interface, or kept private to the provider?* (Answer: Private to the provider).
2.  *How will transaction-retry logic behave on non-locking databases (e.g., MVCC databases like PostgreSQL)?* (Answer: Handled by provider-level optimistic locking or native transaction retries).
