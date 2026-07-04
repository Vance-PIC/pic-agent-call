# ADR: Decoupling Coordination from Storage (v2.0)

*   **Status**: Proposed
*   **Decided by**: System Architect (SA)
*   **Date**: 2026-07-03

---

## 1. Context

In `pic-agent-call 1.x`, SQLite-specific APIs (`DatabaseSync`), database constraints, schema migrations, WAL journaling configurations, and direct SQL queries are scattered across all coordination runtime files (`status.mjs`, `channel.mjs`, `tasks.mjs`, `memory.mjs`). 

This coupling presents critical limitations:
1.  **Portability**: It is impossible to deploy `pic-agent-call` on cloud-native or multi-tenant database infrastructures (e.g., PostgreSQL, Redis) without rewriting the entire codebase.
2.  **Concurrency**: SQLite file locking requires aggressive transaction-retry loops (`withRetry`) which are currently hardcoded with SQLite exception matching, creating fragility when porting to other platforms.
3.  **Testability**: Writing unit tests requires spinning up local database files, causing file lock issues and slowing down the test execution.

---

## 2. Decision

We will decouple the Coordination Runtime from the storage mechanism by introducing a strict **Storage Contract** and **Port/Provider abstraction boundary**.

```text
Coordination Runtime (status / channel / tasks / memory)
        │
        ▼ (Port Interfaces)
┌─────────────────────────────────────────┐
│             StorageProvider             │
│  (Agent / Channel / Task / Memory Store)│
└────────────────────┬────────────────────┘
                     │ (Implements)
        ┌────────────┴────────────┐
        ▼                         ▼
┌──────────────┐          ┌──────────────┐
│    SQLite    │          │  Postgres    │
│  (Built-in)  │          │ (Future Ext) │
└──────────────┘          └──────────────┘
```

1.  **Abstract Ports**: Define TypeScript ports (`StorageProvider`, `AgentStore`, `ChannelStore`, `TaskStore`, `MemoryStore`) that represent all semantic operations required by the coordination logic.
2.  **Zero SQL Leakage**: No SQL queries, database connections, row types, or driver exceptions are allowed to escape the Storage Provider layer.
3.  **Error Normalization**: Each provider MUST translate database-specific driver exceptions into a normalized, portable exception taxonomy (e.g., `ClaimConflictError`, `ConcurrentModificationError`).
4.  **Decoupled Migrations**: Database initialization, schema setup, and migration logic are fully owned by the concrete `StorageProvider` implementation. The coordination runtime only invokes `provider.initialize()` at startup.

---

## 3. Alternatives Considered

### Alternative A — Keep direct SQLite coupling
Maintain SQLite direct calls and add conditional branching (`if (isPostgres) runPgSql() else runSqliteSql()`) directly inside coordination modules.
*   *Rejection Reason*: Highly fragile, leads to code clutter, and fails to separate concerns. Testing still requires concrete file connections.

### Alternative B — Introduce a heavy ORM (e.g., Prisma or TypeORM)
Use a third-party object-relational mapper to handle database abstraction automatically.
*   *Rejection Reason*: ORMs increase packaging sizes, slow down cold-start times (critical for MCP stdio startup latency), and fail to model semantic domain operations (such as atomic queue claiming and no-jitter status ordering) which require custom SQL indexes and transaction isolation level control.

---

## 4. Consequences

### Positive
*   **Architecture Decoupling**: Coordination logic becomes database-agnostic. We can introduce PostgreSQL, Redis, or memory-only providers without altering the coordination services.
*   **High-Speed Testing**: We can write unit tests using a memory-only Mock Storage Provider, completely removing file system access and locking issues from unit tests.
*   **SQLite Concurrency Isolation**: Concurrency retry policies (`withRetry`) are contained within the SQLite provider.

### Negative
*   **Abstraction Overhead**: Requires a thin wrapper interface layer. The project structure grows by a few files to house the Ports and DTO definitions.

---

## 5. Risks & Mitigation

### Concurrency & Transaction Modeling
Different databases handle transactions differently (SQLite locking vs. MVCC optimistic concurrency in PostgreSQL). 
*   *Mitigation*: The contract does not expose raw transactions. Transactions are executed *inside* the semantic methods of the provider (e.g., `claimTask` encapsulates the transaction check-and-update internally).

### Migration Execution
*   *Mitigation*: The migration logic is fully owned by the concrete provider. The runtime bootstrapper calls `initialize()` which executes provider-specific migrations.
