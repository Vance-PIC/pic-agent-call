# SDD-Spec (L1) — pic-agent-call v1.0.0

## 1. 專案概述

`@pic-ai/agent-call` 是跨 AI CLI 平台（CC、AGY、Copilot、Codex）共用的 MCP server。
提供三大功能層：Memory（知識圖譜）、Channel（跨代理人訊息）、Task-Broker（任務派發）。

- **Runtime**: Node.js >= 22.0.0（`node:sqlite` 內建）
- **Protocol**: MCP via `@modelcontextprotocol/sdk`（本地測試掛載名稱為 `pic-agent-call` 以防新舊版混淆）
- **Tools**: 20（18 原有 + register_agent + agent_status）
- **Module format**: 純 ESM（`.mjs`）

---

## 2. 目錄結構

```
pic-agent-call/
├── specs/
│   ├── P1_Setup/
│   │   ├── requirements.md
│   │   └── WBS.md
│   └── P2_Design/
│       ├── SDD-Spec.md     ← 本文件（L1）
│       ├── api-spec.md     ← L2：模組函式簽名
│       ├── db-schema.md    ← L2：DB 表結構
│       └── error-codes.md  ← L2：錯誤碼定義
├── src/
│   ├── db.mjs
│   ├── memory.mjs
│   ├── channel.mjs
│   └── tasks.mjs
├── bin/
│   └── server.mjs
├── tests/
├── evidence/
├── package.json
└── jest.config.js
```

---

## 3. 模組切割

| 模組 | 職責 | 依賴 |
|------|------|------|
| `src/db.mjs` | DB init、路徑解析、JSON 快照、重試機制、`setup()` 便利初始化入口 | node:sqlite, node:fs, node:path, node:os |
| `src/memory.mjs` | entities / observations / relations CRUD | src/db.mjs |
| `src/channel.mjs` | 跨代理人訊息 send/list/claim/ack | src/db.mjs |
| `src/tasks.mjs` | task broker + agents 表 CRUD | src/db.mjs, node:crypto |
| `src/status.mjs` | agent 身份管理：session 解析、register、衝突偵測、孤兒訊息處理、statusline 查詢 | src/db.mjs, node:os, node:crypto |
| `bin/server.mjs` | MCP transport + 20 tools 註冊 | src/*, @modelcontextprotocol/sdk, zod |
| `bin/statusline.mjs` | CC statusbar hook CLI：輸出 `[agent_id\|role] 📨N` 一行後 exit 0 | src/db.mjs, src/status.mjs |

---

## 4. MCP Tools 清單（18 tools）

### Memory（客製化）
| Tool | 對應模組函式 |
|------|-------------|
| add-observation | memory.addObservation |
| query-entity | memory.queryEntity |
| stats | memory.getStats |

### Memory（官方相容）
| Tool | 對應模組函式 |
|------|-------------|
| create_entities | memory.createEntities |
| add_observations | memory.addObservations |
| create_relations | memory.createRelations |
| read_graph | memory.readGraph |
| search_nodes | memory.searchNodes |

### Task-Broker
| Tool | 對應模組函式 |
|------|-------------|
| create_task | tasks.createTask |
| list_pending_tasks | tasks.listPendingTasks |
| claim_task | tasks.claimTask |
| complete_task | tasks.completeTask |
| fail_task | tasks.failTask |
| get_task | tasks.getTask |

### Channel
| Tool | 對應模組函式 |
|------|-------------|
| channel_send | channel.sendMessage |
| channel_list_unread | channel.listUnread |
| channel_claim | channel.claimMessage |
| channel_ack | channel.ackMessage |

### Agent Status
| Tool | 對應模組函式 |
|------|-------------|
| register_agent | status.registerAgent + 本地快取寫入 |
| agent_status | status.getAgentStatus |

#### register_agent MCP 本地快取寫入規範

`register_agent` MCP tool 除更新 SQLite `agents` 表外，**必須同時寫入本地快取檔**：

- **路徑**：`<dbDir>/agent-sessions/<termKey>.json`（dbDir 為 memory-graph.db 所在目錄即 `.memory/`）
- **格式**：`{ "agent_id": string, "term_key": string, "ts": ISOString }`
- **termKey 解析優先序**：
  1. `CLAUDE_CODE_SESSION_ID` → `cc-<sessionId.slice(0, 8)>`
  2. `ANTIGRAVITY_CONVERSATION_ID` → `agy-<conversationId.slice(0, 8)>`
  3. fallback → `ppid-<process.ppid>`
- **目的**：確保 statusline hook 與 preflight-hook 能同步識別身分

---

## 5. 參照文件（L2）

- 詳細函式簽名 → [api-spec.md](./api-spec.md)
- DB 表結構 → [db-schema.md](./db-schema.md)
- 錯誤碼定義 → [error-codes.md](./error-codes.md)
