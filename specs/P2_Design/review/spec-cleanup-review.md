# Spec Cleanup Review — pic-agent-call v1.2.2

## Review Scope

Reviewed uploaded L1/L2 specs:

- `SDD-Spec.md` — L1 architecture / behavior spec
- `api-spec.md` — L2 module API spec
- `db-schema.md` — L2 SQLite schema spec
- `error-codes.md` — L2 error taxonomy

## Verdict

The L1/L2 split is directionally correct:

```text
SDD-Spec.md     = L1 architecture and behavior Source of Truth
api-spec.md     = L2 module signatures and API details
db-schema.md    = L2 SQLite provider schema details
error-codes.md  = L2 normalized error taxonomy
```

However, the current files need cleanup before PG implementation because L1 mixes active behavior, deprecated behavior, migration notes, and old session-based rules. Several L2 details also lag behind v1.2.2.

## Blocking Issues

### 1. Tool count is inconsistent

The spec currently contains conflicting counts: 18, 19, 20, and an actual enumerated total of 21.

Recommended current count:

| Domain | Count |
|---|---:|
| Memory | 8 |
| Task-Broker | 6 |
| Channel | 4 |
| Agent Status | 3 |
| **Total** | **21** |

### 2. Missing specification precedence

Add a spec hierarchy / precedence section:

- L1 controls architecture, behavior, invariants, security, and concurrency.
- L2 must conform to L1.
- If L1 and L2 conflict, L1 wins and a Spec Fix must update L2.
- SQLite schema is an implementation mechanism, not the future Storage Contract.

### 3. Option D Lite v2 is buried too deeply

Foreground registration is now a major architectural decision. It should be promoted into a formal L1 section, not left as a nested paragraph inside auto-registration.

### 4. `is_primary` residue conflicts with the three-state model

`api-spec.md` still references `is_primary`, but `db-schema.md` and current L1 behavior use `active / attached / offline`.

Fix API wording to use `status = active` as the primary marker and `created_at ASC` for stable No-Jitter ordering.

### 5. `db-schema.md` version is stale

The file title says v1.1.3 but contains v1.1.4 / v1.2.2 behavior. Update title and clarify that this is the current SQLite Provider schema.

### 6. `error-codes.md` is incomplete

It still describes v1.0.0-level errors only. Add v1.2.2 registration, target, authorization, migration, and foreground CLI errors.

### 7. SDD directory/module map misses `bin/register.mjs`

`api-spec.md` defines `bin/register.mjs`, but SDD directory and module tables do not include it. Add it as a formal deliverable.

### 8. `src/status.mjs` is overloaded

Acceptable for now, but SDD should acknowledge that it currently acts as the shared registration/status application module and may later split into:

- `registration-service.mjs`
- `agent-status-service.mjs`
- `agent-lifecycle-service.mjs`

## Recommended Files Created

This review produced the following RC cleanup files:

- `spec-index.md`
- `SDD-Spec.RC-cleanup.md`
- `api-spec.RC-cleanup.md`
- `db-schema.RC-cleanup.md`
- `error-codes.RC-cleanup.md`

## Recommended Next Step

Ask SA to review the RC cleanup set and approve it as the new baseline before handing tasks to PG.

Suggested SA instruction:

```text
Review the RC cleanup specs. Confirm that L1/L2 precedence, tool count, Option D Lite v2, three-state agent model, error taxonomy, and SQLite schema version are now internally consistent. Do not begin implementation until blocking conflicts are resolved.
```
