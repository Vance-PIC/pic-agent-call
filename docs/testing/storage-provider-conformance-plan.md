# Storage Provider Conformance Test Plan

This document details the test strategy and specifications required to verify that any storage implementation conforms to the **Storage Contract**. 

These tests MUST be executable against any compliant provider (e.g., SQLite, PostgreSQL) without modification.

---

## 1. Test Strategy

```text
                     ┌───────────────────────────────┐
                     │   Conformance Test Suite      │
                     │ (Runs against any Provider)   │
                     └───────────────┬───────────────┘
                                     │
             ┌───────────────────────┴───────────────────────┐
             ▼                                               ▼
┌───────────────────────────────┐               ┌───────────────────────────────┐
│        SQLite Provider        │               │      PostgreSQL Provider      │
│     (Local Conformance)       │               │      (Cloud Conformance)      │
└───────────────────────────────┘               └───────────────────────────────┘
```

The test runner will run a shared test suite, parameterizing the provider instantiation during setup:

```javascript
describe('Storage Provider Conformance Suite', () => {
  let provider;

  beforeEach(async () => {
    provider = await createTestProvider(); // SQLite, Postgres, etc.
    await provider.initialize();
  });

  afterEach(async () => {
    await provider.close();
  });

  // Reusable conformance tests run here...
});
```

---

## 2. Test Specifications

### 2.1 Conformance Tests (Unified Suite)

#### Agent Invariants & Presence
1.  **Unique Active Agent per Context**:
    *   *Setup*: Register `Agent A` as active on `term-1`.
    *   *Action*: Attempt to register `Agent B` as active on `term-1` without `forced=true`.
    *   *Assert*: MUST throw `ClaimConflictError` or `AlreadyExistsError`.
2.  **Takeover Behavior (Forced)**:
    *   *Setup*: Register `Agent A` as active on `term-1`.
    *   *Action*: Register `Agent B` as active on `term-1` with `forced=true`.
    *   *Assert*: Registration succeeds. `Agent A`'s status becomes `offline` or `attached` depending on forced soft-offline rules.
3.  **No Jitter Ordering**:
    *   *Setup*: Register three agents sequentially (`A`, `B`, `C`) under the same session.
    *   *Action*: Deactivate `A`, change active pointer, list status.
    *   *Assert*: The returned list order MUST always remain `A -> B -> C` (created time ascending). Only the active pointer shifts.

#### Task Coordination
1.  **Atomic Task Claiming**:
    *   *Setup*: Create a pending task.
    *   *Action*: Fire 20 parallel `claimTask` requests for the same `task_id` using different `agent_id`s.
    *   *Assert*: Exactly one claim MUST succeed; the remaining 19 claims MUST return `ClaimConflictError` or `already_claimed` status.
2.  **Task Idempotency Protection**:
    *   *Setup*: Create a task with feature `F` and payload `P`.
    *   *Action*: Call `createTask` with identical feature `F` and payload `P`.
    *   *Assert*: MUST return the first task's ID with `idempotent = true`. No second database record is created.
3.  **Validation Constraint Enforcement**:
    *   *Action*: Attempt to create a task with payload size > 65,536 bytes.
    *   *Assert*: MUST fail with validation error.

#### Channel & Messaging
1.  **Atomic Message Claiming**:
    *   *Setup*: Append a message with receiver `any`.
    *   *Action*: Parallel agents attempt to claim the message.
    *   *Assert*: Only one claimant succeeds; the other fails.
2.  **Unauthorized Query Defense**:
    *   *Setup*: Active registration exists for `Agent A` under target `T`.
    *   *Action*: Call `findUnreadMessages` for `Agent B` using target `T` where `Agent B` is not attached.
    *   *Assert*: MUST throw `UnauthorizedError` or `ForbiddenError`.

#### Transaction Integrity
1.  **Rollback on Failure**:
    *   *Action*: Inside a composite operation (like broadcast message append), insert 3 successful records, then trigger a database constraint violation on the 4th record.
    *   *Assert*: Transaction rolls back. No partial messages are written to the database.

#### Lifecycle & Error Handling
1.  **Shutdown safety**:
    *   *Action*: Initialize, run queries, call `close()`, then attempt a read.
    *   *Assert*: Read attempt throws `ProviderUnavailableError`.
2.  **Error translation**:
    *   *Action*: Cause a primary key constraint breach.
    *   *Assert*: Caught error MUST be instance of `AlreadyExistsError`.

---

## 3. Provider-Specific Implementation Tests

### SQLite Provider Specifics
1.  **`withRetry` Backoff Verification**:
    *   *Setup*: Acquire an exclusive transaction lock on the SQLite file externally.
    *   *Action*: Execute a write query via the provider.
    *   *Assert*: The provider retries the specified number of times and waits before throwing `ERR_DATABASE_LOCKED`.
2.  **JSON Sync Debouncing**:
    *   *Action*: Trigger 5 sequential observation appends within 100ms.
    *   *Assert*: The JSON file `memory-graph.json` is written exactly once (debounced) instead of 5 times.
    *   *Action*: Call `close()`, check that the debouncing timer is cleared.
