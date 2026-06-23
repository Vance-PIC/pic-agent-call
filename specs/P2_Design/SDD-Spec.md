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
| `bin/msg-statusline.mjs` | CC statusbar hook CLI：輸出 `[agent_id\|role] 📨N` 一行後 exit 0 | src/db.mjs, src/status.mjs |
| `bin/msg-statusline-wrapper.mjs` | Gemini/Antigravity 狀態列整合包裝器：拼裝 Quota 狀態與 Agent 訊息狀態，包含 CWD 解析與 timeout 防卡死 | node:child_process, node:fs, node:path, node:os |

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

---

## 6. 架構優化與併發性能規範 (v1.1.0 重構規格)

為了解決併發寫入鎖定、JSON 備份 I/O 阻塞、Session 掃描開銷及通道偽造問題，專案引進以下重構規格：

1.  **全寫入 / 交易 withRetry 包裹**：
    *   所有包含 `INSERT` / `UPDATE` / `DELETE` 動作的資料庫操作，必須全面包裹在 `withRetry` 指數退避重試邏輯中。
    *   涉及多步驟的資料庫異動，必須使用 `BEGIN IMMEDIATE` 與 `COMMIT` 包裹為資料庫事務（Transaction），並將整個事務 block 包裹在 `withRetry` 內。
2.  **JSON 快照同步異步防抖**：
    *   將 `syncDbToJson` 重構為具備 **500ms 至 1000ms** 防抖的異步覆蓋機制。
    *   採用 `promises.writeFile` 寫入臨時檔案，再以 `promises.rename` 原子覆蓋，避免阻塞事件循環。
3.  **Session ID 記憶體快取**：
    *   `resolveSessionId` 優先解析環境變數（如 `ANTIGRAVITY_CONVERSATION_ID` 或 `CLAUDE_CODE_SESSION_ID`），並將動態掃描目錄結果快取在進程記憶體中，防止重複硬碟 I/O。
4.  **Channel 訊息 Sender 安全認證**：
    *   `channel_send` 的 MCP 暴露工具層 schema **移除前端傳入的 `sender` 參數**，以防偽造。
    *   核心 `channel.mjs` 中的 `sendMessage` API 簽名調整為 `sendMessage(db, receiver, message, sender, sessionId, priority?)`。API 內部將執行安全性校驗：若 `sender` 不為 `SYSTEM`，則必須在 DB 中存在以 `sessionId` 登記的 `agent_id` 且必須與 `sender` 完全相符；不吻合或未註冊則拋出安全性錯誤。
    *   單元測試可直接在 DB 註冊測試 agent 或以 `SYSTEM` 作為 sender，維持測試友善度。
    *   MCP Tool Handler 自動透過 `resolveSessionId()` 獲取當前 `sessionId` 與查得之 `agent_id` 當作參數傳給 `sendMessage`。
5.  **Session 快取檔案自動清理機制**：
    *   在 `register_agent` MCP tool 寫入新 cache 時，自動調用 `cleanExpiredAgentSessionCache` 清理舊快取檔，維持目錄整潔。
    *   **保留保護**：對當前平台（以 `cc-` 和 `agy-` 區分，對應 Claude Code 和 Antigravity），各保留一筆 mtime 最新的快取檔案，即使已 offline 亦不可刪除（用作 statusline fallback 顯示）。
    *   **清理標準**：其餘快取 json 檔案若 mtime > 7 天，一律直接刪除；若 DB 中無對應 session 紀錄（孤兒檔案）且 mtime > 5 分鐘，一律刪除；若 DB 中對應 status 欄位為 `'offline'` 且 last_seen (或 mtime) 已超期大於 24 小時，一律刪除。
6.  **動作前訊息稽核門禁 (Pre-action Message Check Gate) 機制**：
    *   規範 AI 代理人於調用任何「寫入/修改檔案」或「執行指令」工具之前，必須強制主動執行 `agent_status` 查詢 unread 訊息。若 `unread > 0`，必須暫停寫入（防守手煞車），直至讀取並處理完畢。批次作業時於頭尾預檢且中途每寫入 5 個檔案強制預檢一次；敏感部署/提交命令無批次豁免權。
7.  **多角色並列指示器與平台聚合狀態列 (Multi-role Statusline Aggregation)**：
    *   `msg-statusline.mjs` 執行時，根據當前 `callerType`（`cc` 或是 `agy`）自動識別所屬平台。
    *   除了讀取當前視窗 `term_key` 的主身份狀態外，必須向 DB 查詢該平台下所有已註冊且活躍/離線的角色（如 `WHERE agent_id LIKE 'AGY-%'` 或 `LIKE 'CC-%'`）與其各自的未讀訊息數。
    *   拼裝成並列格式輸出：當前視窗主身份固定排在首位，其餘有未讀數的角色依序並列顯示，並以 `|` 區隔（例如：`🟢0·SA | 🔴1·PJM | 🔴2·QA`）。確保使用者在單視窗切換或多實例並行時，能即時掌握平台全角色的未讀狀態，消除訊息漏看盲區。
8.  **AI 啟動時自動與互動式引導註冊機制 (Auto & Interactive Registration)**：
    *   規範 AI 代理人於新會話啟動執行 `Session Startup Protocol` 時，若呼叫 `agent_status` 發現當前 session 狀態為 `registered: false`：
        1.  **優先自動註冊**：AI 應根據當前環境變數、進程名稱，或讀取 `task.md` 中被指派且待執行的 WBS 任務，自動推導其應擔任的角色，並自動調用 `register_agent` 註冊（如 `CC-PG1` 或 `AGY-SA`）。
        2.  **互動式引導**：若無法自動推導，AI 必須主動在對話框中提供明確的角色選項（如 SA / PG / QA / PM / DevOps 等）詢問人類；在人類回覆選取後，自動調用 `register_agent` 完成註冊，方可開始後續工作。
