# Code Review Fixes (v1.1.4) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement robust fixes for C1-C2 (Critical) and I1-I6 (Important) concurrency, timezone, and error handling issues identified in the P3 Code Review.

**Architecture:** Use SQLite `BEGIN IMMEDIATE` transactions to prevent TOCTOU race conditions in tasks and channel messaging. Standardize all DB timestamp insertions using `datetime('now','localtime')` and establish healthy error logging/propagation.

**Tech Stack:** Node.js, node:sqlite, Jest for testing.

---

### Task 1: tasks.mjs completeTask & failTask Concurrency Fix (C1, I1)

**Files:**
- Modify: `src/tasks.mjs`
- Test: `tests/tasks.test.mjs`

- [ ] **Step 1: Write a concurrent race condition unit test for completeTask & failTask**
  Create a test simulating simultaneous status updates to verify that only one update succeeds (returns `changes > 0`) and the other fails or is rejected gracefully.
- [ ] **Step 2: Run test to verify it fails**
  Run: `npx jest tests/tasks.test.mjs`
  Expected: FAIL (or race conditions result in silent overwrite without success failure indication).
- [ ] **Step 3: Implement minimal transaction and change checking code in tasks.mjs**
  Wrap the state check and `UPDATE tasks` inside a `BEGIN IMMEDIATE` and `COMMIT` transaction. Verify `changes > 0`. Replace JS timezone logic with SQL `datetime('now','localtime')`.
- [ ] **Step 4: Run test to verify it passes**
  Run: `npx jest tests/tasks.test.mjs`
  Expected: PASS
- [ ] **Step 5: Commit**
  Run: `git add src/tasks.mjs tests/tasks.test.mjs; git commit -m "fix(tasks): prevent completeTask/failTask TOCTOU race and unify timezone"`

### Task 2: db.mjs JSON Sync Error Logging & Migration Error (C2, I4)

**Files:**
- Modify: `src/db.mjs`
- Test: `tests/db.test.mjs`

- [ ] **Step 1: Write tests for database synchronization failure**
  Mock write failures to verify that errors in `_doSyncDbToJson` are not silently swallowed.
- [ ] **Step 2: Run test to verify it fails**
  Expected: FAIL (currently errors are silently caught and swallowed).
- [ ] **Step 3: Fix db.mjs to propagate or log synchronization and migration exceptions**
  Update `_doSyncDbToJson` to `console.error` on write/rename errors. In `db.mjs` migrations, only swallow `duplicate column` ALTER TABLE errors; rethrow or log other critical errors.
- [ ] **Step 4: Run test to verify it passes**
  Expected: PASS
- [ ] **Step 5: Commit**
  Run: `git add src/db.mjs tests/db.test.mjs; git commit -m "fix(db): bubble critical migration errors and log JSON sync failures"`

### Task 3: channel.mjs Broadcast & Claim/Ack Concurrency & Helper (I2, I3, I5)

**Files:**
- Modify: `src/channel.mjs`
- Test: `tests/channel.test.mjs`

- [ ] **Step 1: Write concurrency tests for claimMessage & ackMessage**
  Simulate concurrent claims on the same message to verify only one agent locks it.
- [ ] **Step 2: Run test to verify it fails**
  Expected: FAIL
- [ ] **Step 3: Implement helper and transactional controls in channel.mjs**
  Unify timestamp using `datetime('now','localtime')`. Extract `_resolvePrimaryAgentId` helper and run message checks and state changes inside `BEGIN IMMEDIATE` transactions.
- [ ] **Step 4: Run test to verify it passes**
  Expected: PASS
- [ ] **Step 5: Commit**
  Run: `git add src/channel.mjs tests/channel.test.mjs; git commit -m "fix(channel): wrap broadcast and claim/ack in transactions and fix UTC mismatch"`

### Task 4: Add Comprehensive Channel Claim/Ack Tests (I6)

**Files:**
- Create/Modify: `tests/channel.test.mjs`

- [ ] **Step 1: Write integration tests for claim/ack flow**
  Add test cases verifying correct claim locking, authorization (403 on role mismatch), and status updates.
- [ ] **Step 2: Run test to verify it passes**
  Run: `npx jest tests/channel.test.mjs`
  Expected: PASS
- [ ] **Step 3: Commit**
  Run: `git add tests/channel.test.mjs; git commit -m "test(channel): add comprehensive integration tests for claim and ack"`
