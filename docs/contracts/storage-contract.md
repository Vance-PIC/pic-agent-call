# Storage Contract Specification (v2.0)

## 1. Purpose

This document defines the formal, provider-independent **Storage Contract** for `pic-agent-call 2.0`. The goal is to decouple the coordination runtime from the persistence implementation. 

All storage operations MUST be accessed through semantic ports rather than raw database drivers or SQL interfaces. SQLite, PostgreSQL, and other future storage systems MUST implement this contract.

---

## 2. Terminology & Principles

*   **Coordination Runtime**: The application logic coordinating agent identities, channels, tasks, and memory.
*   **Storage Port**: The abstract interface layer defining capabilities, inputs, outputs, and behaviors.
*   **Storage Provider**: A concrete database implementation (e.g., SQLite, PostgreSQL) conforming to the ports.
*   **Active Agent**: The primary executing agent for a given terminal context (`term_key`).
*   **Attached Agent**: A secondary, connected agent in the same context.
*   **Offline Agent**: A previously registered agent that has timed out or been explicitly replaced.

### Core Principles
1.  **Dependency Inversion**: Use cases MUST NOT depend on database-specific types, exceptions, or connection classes.
2.  **Semantic Operations**: Repositories MUST expose semantic API methods (e.g., `claimTask`) rather than generic CRUD wrappers (`insert`, `update`, `query`).
3.  **Encapsulated Transactions**: Transaction boundaries MUST be defined by coordination use cases and executed atomically.
4.  **Error Normalization**: Database-specific driver errors MUST be caught, parsed, and thrown as normalized domain errors.

---

## 3. Capability Contract

The Storage Contract defines six abstract store categories that MUST be implemented by any Storage Provider.

```text
┌────────────────────────────────────────────────────────┐
│                    StorageProvider                     │
├───────────┬────────────┬───────────┬───────────┬───────┤
│  agents   │  channels  │   tasks   │ memories  │ sys   │
└───────────┴────────────┴───────────┴───────────┴───────┘
```

### 3.1 Agent Store (`AgentStore`)
*   `findAgentById(agentId)`: Return the agent state or `null`.
*   `findActiveAgentByTermKey(termKey)`: Return the active agent or `null`.
*   `findRegistrationsBySession(sessionId)`: Return active and attached agents for a session, ordered by registration time (`created_at ASC`).
*   `findRegistrationsByTermKey(termKey)`: Return active and attached agents for a term_key context, ordered by registration time (`created_at ASC`).
*   `saveRegistration(agent, options)`: Create or update an agent registration.
*   `deactivateSessionAgentsExcept(sessionId, termKey, excludedAgentIds)`: Mark other agents belonging to this session and terminal as `offline`.
*   `sweepTimedOutAgents()`: Mark active/attached agents as `offline` if they have exceeded their defined timeout period.
*   `purgeOfflineAgentsHistory(purgeThresholdMin)`: Physically delete offline agent records older than the threshold.

### 3.2 Channel Store (`ChannelStore`)
*   `appendMessage(message)`: Add a message to the channel. Supports multi-receiver fan-out for broadcasts.
*   `findUnreadMessages(receivers)`: Retrieve unread messages for a list of receivers, sorted by `priority DESC, created_at ASC`.
*   `claimMessage(messageId, agentId)`: Atomically transition a message from `UNREAD` to `IN_PROGRESS` and assign `lock_owner`.
*   `ackMessage(messageId, agentId)`: Atomically transition a message from `IN_PROGRESS` to `READ` if the claiming agent matches the `lock_owner`.
*   `releaseExpiredClaims(timeoutMin)`: Revert message claims from `IN_PROGRESS` to `UNREAD` if lock duration exceeds the timeout.

### 3.3 Task Store (`TaskStore`)
*   `createTask(task)`: Persist a new task. Enforce idempotency check on `payload_hash`.
*   `findPendingTasks(assignTo)`: Retrieve pending tasks, optionally filtered by assignee.
*   `claimTask(taskId, agentId)`: Atomically claim a pending task, setting status to `claimed` and `claimed_by`.
*   `completeTask(taskId, result)`: Mark a claimed task as `completed` and write the result.
*   `failTask(taskId, failReason)`: Mark a claimed task as `failed` and record the reason.
*   `findTaskById(taskId)`: Get task details.
*   `releaseExpiredTaskClaims()`: Revert expired claimed tasks to `pending` if the owning agent is detected as offline or timed out.

### 3.4 Memory Store (`MemoryStore`)
*   `saveEntity(entity)`: Upsert a knowledge entity.
*   `saveObservation(entityName, observationText)`: Record a new observation for an entity, incrementing the entity version.
*   `findEntityByName(entityName)`: Get an entity, its observations, and relations.
*   `saveRelations(relations)`: Create directed relations between entities.
*   `readGraph()`: Export the full graph of entities, observations, and relations.
*   `searchNodes(query)`: Search entities and observations by keyword.
*   `getStats()`: Return counts of entities, observations, and relations.

---

## 4. Behavioral & Consistency Contract

### 4.1 Agent Presence Invariants
*   **Single Active Agent per Context**: Within a defined `term_key` context, at most one agent registration MUST have `status = 'active'`.
*   **No Jitter Ordering**: Multi-agent status lists MUST be ordered strictly by `created_at ASC` to prevent terminal UI jitter when active roles shift.
*   **Heartbeat Frequency**: Agent heartbeats SHOULD NOT perform blocking database write transactions more than once every 10 seconds.

### 4.2 Task Claiming Consistency
*   **Exclusivity**: A task MUST NOT be claimed by more than one agent. Any attempt to claim a non-pending task MUST fail with a `ClaimConflictError`.
*   **Authorization Check**: The claiming `agent_id` MUST be active or attached. Unregistered or offline agents MUST be blocked from claiming tasks.

### 4.3 Message Delivery & Idempotency
*   **Atomic Claiming**: `claimMessage` MUST be executed atomically. If two agents attempt to claim the same message, only one MUST succeed; the other MUST receive a `ClaimConflictError`.
*   **Task Idempotency**: Creating a task with a duplicate `payload_hash` (feature + payload SHA-256) MUST return the existing task ID and state without inserting a duplicate record.

---

## 5. Lifecycle & Management Contract

Each Storage Provider MUST implement the following system capabilities:
1.  **Configuration**: Initialize using configuration settings (`settings.local.json` or environment variables).
2.  **Initialization**: Setup storage connections, connection pools, and database optimizations.
3.  **Migration**: Verify schema version and perform upgrades automatically on startup.
4.  **Health Check**: Return current storage availability status, file path, and performance metrics (e.g., latency, pool usage).
5.  **Shutdown**: Close connections gracefully, flushing any write queues.

---

## 6. Error Normalization Contract

Storage Providers MUST catch database-specific exceptions and throw them as normalized errors defined by the contract:

| Driver Error (SQLite/PostgreSQL) | Normalized Contract Error |
| --- | --- |
| `SQLITE_CONSTRAINT_PRIMARYKEY` / duplicate key | `AlreadyExistsError` |
| Foreign key constraint violation | `NotFoundError` (Reference target missing) |
| SQLITE_LOCKED / SQLITE_BUSY / Serialization failure | `ConcurrentModificationError` (Transaction conflict) |
| CHECK constraint fail on transition | `InvalidStateTransitionError` |
| Attempt to claim claimed task/message | `ClaimConflictError` |
| Dead connection / TCP timeout | `ProviderUnavailableError` |
| Broken database file | `StorageCorruptedException` |

---

## 7. Transaction & Atomicity Contract

All transaction boundaries are defined by semantic operations in coordination use cases. 

The Storage Contract does **not** expose raw SQL transaction blocks (`BEGIN`, `COMMIT`). Instead, it mandates that the Storage Provider execute specific semantic operations inside atomic transactions.

### Key Atomic Operations
*   **Agent Registration Takeover**:
    ```text
    Deactivate old registrations on term_key
    +
    Update/Insert new registrations (1 active, rest attached)
    =
    Atomic Transaction
    ```
*   **Task Claiming**:
    ```text
    Verify claiming agent is active/attached
    +
    Select pending task for update
    +
    Update status to 'claimed' and assign owner
    =
    Atomic Transaction
    ```
*   **Message Broadcast**:
    ```text
    Query active receivers excluding sender
    +
    Insert unique channel messages for each receiver
    =
    Atomic Transaction
    ```
