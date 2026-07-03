# Specification Index — pic-agent-call v1.2.2

## Specification Levels

| Level | Document | Authority | Purpose |
|---|---|---|---|
| L1 | `SDD-Spec.md` | Architecture and behavior Source of Truth | Defines runtime architecture, domain behavior, security invariants, concurrency rules, and accepted design decisions. |
| L2 | `api-spec.md` | API surface detail | Defines module-level function signatures, parameters, return shapes, and caller obligations. |
| L2 | `db-schema.md` | SQLite provider detail | Defines current SQLite physical schema, indexes, migrations, and compatibility notes. |
| L2 | `error-codes.md` | Error taxonomy detail | Defines normalized error reasons, throw behavior, and tool/CLI error mapping. |

## Precedence Rules

1. L1 defines the intended architecture and behavioral contract.
2. L2 documents MUST conform to L1.
3. When L1 and L2 conflict, L1 prevails and a Spec Fix MUST be opened to update the affected L2 document.
4. Implementation MUST NOT introduce behavior that is absent from both L1 and L2.
5. SQLite schema details in `db-schema.md` are implementation mechanisms, not portable architecture contracts.
6. Deprecated behavior MUST be explicitly marked as deprecated and MUST NOT be treated as current implementation guidance.

## Active Architecture Decisions

- `PIC_TERM_KEY` / `term_key` is the primary terminal/window identity.
- `session_id` is platform-specific conversation metadata and MUST NOT be treated as terminal identity.
- Agent lifecycle uses the three-state model: `active`, `attached`, `offline`.
- One physical terminal scope (`term_key`) may have at most one `active` agent at a time.
- Local JSON session cache has been deprecated.
- Option D Lite v2 is the initial foreground registration approach.
- `bin/register.mjs` is a foreground Registration Adapter and MUST NOT write SQLite directly.
- Hooks and statusline are read/query adapters and MUST NOT mutate registration state except through approved application services.
- Storage-provider replacement is a future architecture direction; current SQLite behavior SHOULD be described as provider implementation detail.

## Current Tool Count

Current L1/L2 documentation enumerates **21 MCP tools**:

| Domain | Count |
|---|---:|
| Memory | 8 |
| Task-Broker | 6 |
| Channel | 4 |
| Agent Status | 3 |
| **Total** | **21** |

