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
| `bin/msg-statusline.mjs` | CC statusbar hook CLI：以 `CLAUDE_CODE_SESSION_ID` 直接查 DB 取得當前 session 的所有活躍角色與未讀數，輸出並列格式一行後 exit 0；**禁止**掃描 agent-sessions/ 快取檔作 fallback，DB 無結果則輸出 `NO AGENT` | src/db.mjs, src/status.mjs |
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
    *   **保留保護**：對當前平台（以 `cc-` 和 `agy-` 區分，對應 Claude Code 和 Antigravity），各保留一筆 mtime 最新的快取檔案，即使已 offline 亦不可刪除（保留供 channel 安全認證與 force 接管快取同步使用；statusline 已改為直查 DB，不依賴此檔案）。
    *   **清理標準**：其餘快取 json 檔案若 mtime > 7 天，一律直接刪除。對與 DB 狀態的對照改採**聚合對比**：
        *   **孤兒檔案**：若該快取檔 `term_key` 在 DB 的 `agents` 表中**查無任何關聯的角色**（例如被別的 session 強行接管走全部角色），且 mtime > 5 分鐘，一律刪除。
        *   **Offline 判定**：只有當該 `term_key` 在 DB 中關聯的**所有角色之 `status` 皆為 `'offline'`** 時，此快取檔才被判定為已 offline。此時若其 last_seen (或 mtime) 已超期大於 24 小時，一律刪除。若該快取檔在 DB 中仍有任一角色為 `'active'`，則絕對禁止刪除。
6.  **動作前訊息稽核門禁 (Pre-action Message Check Gate) 機制**：
    *   規範 AI 代理人於調用 any「寫入/修改檔案」或「執行指令」工具之前，必須強制主動執行 `agent_status` 查詢 unread 訊息。若 `unread > 0`，必須暫停寫入（防守手煞車），直至讀取並處理完畢。批次作業時於頭尾預檢且中途每寫入 5 個檔案強制預檢一次；敏感部署/提交命令無批次豁免權。
7.  **多角色並列指示器與平台聚合狀態列 (Multi-role Statusline Aggregation)**：
    *   `msg-statusline.mjs` 執行時，根據當前 `callerType`（`cc` 或是 `agy`）自動識別所屬平台。
    *   **Session ID 直查規範**：必須以 `CLAUDE_CODE_SESSION_ID`（CC）或 `ANTIGRAVITY_CONVERSATION_ID`（AGY）直接查詢 DB `agents` 表取得當前 session 的所有活躍角色。**禁止**以掃描 `agent-sessions/` 目錄取最新快取檔的方式作為 fallback（此行為會污染跨 terminal 顯示）。DB 查無結果時直接輸出 `NO AGENT`。
    *   除了讀取當前 session 的所有活躍角色外，必須向 DB 查詢該平台下所有已註冊且活躍/離線的角色（如 `WHERE agent_id LIKE 'AGY-%'` 或 `LIKE 'CC-%'`）與其各自的未讀訊息數。
    *   拼裝成並列格式輸出：當前視窗主身份固定排在首位且其前置加上 `▶` 標示，其餘角色依序並列顯示（例如：`▶🔴1·AGY-SA  🟢0·AGY-PG  🔴0·AGY-QA  🔴1·AGY-PJM  🟢0·AGY-PDM`），各角色間以兩個空格區隔，不使用 `|` 符號。確保使用者在單視窗切換或多實例並行時，能即時掌握平台全角色的未讀狀態，消除訊息漏看盲區。
8.  **AI 啟動時自動與互動式引導註冊機制 (Auto & Interactive Registration)**：
    *   規範 AI 代理人於新會話啟動執行 `Session Startup Protocol` 時，若呼叫 `agent_status` 發現當前 session 狀態為 `registered: false`：
        1.  **優先自動註冊**：AI 應根據當前環境變數、進程名稱，或讀取 `task.md` 中被指派且待執行的 WBS 任務，自動推導其應擔任的角色，並自動調用 `register_agent` 註冊（如 `CC-PG1` 或 `AGY-SA`）。
        2.  **互動式引導**：若無法自動推導，AI 必須主動在對話框中提供明確的角色選項詢問人類；在人類回覆選取後，自動調用 `register_agent` 完成註冊，方可開始後續工作。
        3.  **命名與放行規範**：互動式註冊選單的選項，AGY 側必須嚴格採用以 `AGY-` 為前綴的標準 PIC 角色（如 `AGY-SA`、`AGY-PG`、`AGY-QA`、`AGY-PJM`、`AGY-PDM`）；CC 側則為 `CC-` 前綴。此外，AGY 側與 CC 側的 `UserPromptSubmit` hook 腳本（`autoreg-gate`）必須內含關鍵字放行邏輯，當 prompt 含有 `register_agent` 或 `register agent` 時豁免 session 登記檢查，避免雞生蛋閉鎖。
        4.  **Hook 強制等級**：`autoreg-gate` hook 採 `warn`（而非 `block`）作為輔助提醒機制，不強制中斷操作。AI 自律（Session Startup Protocol）為主要執行保障，hook 僅在 session 未登記時發出警告提示 AI 補行 `register_agent`。
9.  **Channel 訊息 Receiver 與操作安全防護 (橫向越權防護)**：
    *   `channel_list_unread`、`channel_claim`、`channel_ack` 等核心 API 及對應 Tool Handlers，在執行時必須傳入當前連線的 `sessionId`。
    *   API 內部執行安全性校驗與接收信箱判定：
        *   **當前活躍角色定位**：由當前連線本地快取檔案（即 `<dbDir>/agent-sessions/<termKey>.json`）中的 `"agent_id"` 欄位值定義「當前活躍角色（主身份）」。
        *   `channel_list_unread`：若傳入特定的 `receiver` 參數，該 receiver 必須為當前活躍角色（或其對應之 role 郵箱），否則拋出 403 越權錯誤。返回結果應包含發送給該活躍角色、其 role 郵箱（格式為 `role?`）、以及發送給 `'any'` 且狀態為 `'UNREAD'` 的訊息。若 `receiver` 未指定或為 `'all'`，則系統自動拉取該 `sessionId` 綁定之所有活躍角色各自未讀訊息的聯集。
        *   `channel_claim` 與 `channel_ack`：嚴格限制只能操作當前活躍角色有權處理的訊息。操作者傳入之 `agent_id` 必須與快取檔案中的當前活躍角色完全相符，且訊息接收者（`receiver`）必須為該當前活躍角色（或其 `role?` 郵箱，或為 `'any'` 且狀態為 `'UNREAD'`），禁止越權搶鎖或確認非本活躍角色的訊息。
10. **一會話多角色並存與接管規範 (One-Session Multi-Identities & Takeover)**：
    *   **資料庫約束調整**：物理刪除 `agents` 表上對 `session_id` 的唯一索引 (`idx_agents_session_id`)。允許一個會話 (`session_id`) 同時登記多個不同的 `agent_id`（如 `AGY-SA`、`AGY-PG`、`AGY-QA`、`AGY-PJM`、`AGY-PDM` 同時綁定同一個 `session_id`），並均處於 `active` 狀態。
    *   **多角色分隔解析**：`register_agent` 支援在 `agent_id` 與 `role` 參數中傳入以逗號（半形 `,` 或全形 `，`）、頓號（`、`）、斜線（`/`）、加號（`+`）、分號（`;` 或 `；`）或空格等分隔的多個字串（例如 `agent_id` 填入 `"SA/PG/QA/PJM/PDM"` 或是 `"AGY-SA+AGY-PG+AGY-QA+AGY-PJM+AGY-PDM"`）。系統在執行 `register_agent` 時**必須使用正規表達式（如 `/[,\/\\+，、；;\s]+/`）進行 Token 分割**，將其拆解成多個獨立的角色分別呼叫註冊流程，嚴禁將整串含有分隔符號的字串直接當作單一 `agent_id` 寫入資料庫。
    *   **平台前綴補全與角色自動推導**：若拆分後的子角色識別碼（例如 `SA`）不包含平台前綴（`AGY-` 或 `CC-`）：
        *   系統應根據當前 `sessionId` 的類型自動補齊前綴。若為 Antigravity 連線（前綴 `agy-`）則補上 `AGY-` 前綴變成 `AGY-SA`；若為 Claude Code 連線（前綴 `cc-`）則補上 `CC-SA`。
        *   系統應自動將該無前綴的角色名（如 `SA`、`PG`、`QA`、`PJM`、`PDM`）填入其對應 SQL 的 `role` 欄位中，除非 `role` 參數有額外指定對應的角色。
    *   **快取檔案擴充與同步**：
        *   本地快取檔 `<dbDir>/agent-sessions/<termKey>.json` 擴充 JSON 格式為 `{ "agent_id": string, "agent_ids": string[], "term_key": string, "ts": ISOString }`，其中 `agent_id` 為當前活躍角色（主身份，預設為此次註冊字串中解析出的首位角色，若重複註冊則為最後登記的角色）。
        *   `agent_ids` 為當前 Session 綁定的所有活躍角色 ID 陣列（例如 `["AGY-SA", "AGY-PG", "AGY-QA", "AGY-PJM", "AGY-PDM"]`）。寫入快取前，必須先從 DB 查詢該 `sessionId` 關聯且狀態為 `active` 的角色聯集，確保快取檔案與實體 DB 一致。
        *   當前活躍角色切換時，僅需重新註冊（或呼叫 register_agent）該單一角色，快取檔將自動將該角色更新為 `"agent_id"` 主身份，而不清空 DB 關聯的其他角色。
    *   **心跳與狀態列同步更新（讀寫分離與心跳降頻）**：
        *   狀態列（`getAgentStatus`）輪詢因頻率極高（每秒執行），為了徹底防止 SQLite 寫鎖定造成的 `ETIMEDOUT` 阻塞超時，必須實施**讀寫分離**與**心跳降頻**：
            1.  **心跳降頻**：系統在查詢當前 session 狀態時，必須先對比 DB 中已存的 `last_seen` 與當前時間。若時間差小於 **10 秒**，則**直接跳過 DB UPDATE 心跳操作**，只執行唯讀查詢（SELECT）。因為 WAL 模式下 SELECT 絕對不會被寫鎖阻塞，這能將 90% 以上的輪詢轉為無鎖唯讀。
            2.  **非同步/重試保護**：若時間差大於等於 10 秒需要執行 `UPDATE agents` 心跳更新，此 Update 操作必須被 `withRetry` 包裹，或以**非同步（async/Promise）背景 fire-and-forget** 方式非阻塞執行。`getAgentStatus` 本身應立即返回未讀數結果，不應被心跳寫入鎖定所阻塞。當前 Session 的心跳更新時，會同時將綁定在此 `session_id` 下的所有 `active` 角色的 `last_seen` 統一更新為當前時間，並且一併確保這些角色的 `status` 被重設/保持為 `'active'`（防止 session 本身活躍但旗下某些未操作的角色因超時被 offline）。
    *   **孤兒訊息處理限制**：只有當舊角色 `previousAgentId` 徹底被註銷或被其他 session 接管，且**不再屬於當前 `sessionId` 的活躍角色名單**時，才可觸發孤兒訊息（ORPHANED）的標記與通知。若舊主身份仍然屬於當前會話的並存活躍角色，則絕對禁止觸發孤兒標記，以防止切換主角色時誤殺並存角色的未讀訊息。
    *   **狀態列資訊聚合 (getAgentStatus)**：
        *   `getAgentStatus` 回傳的 `unread` 為該 `sessionId` 綁定之所有活躍角色未讀數之總和。
        *   其 `display` 格式改為各角色個別並列顯示，以兩個空格區隔（不使用 `|` 符號）：主身份（快取中定義之當前活躍角色）固定排在首位且其前置加上 `▶` 標示，其餘角色依序並列顯示（例如：`▶🔴1·AGY-SA  🟢0·AGY-PG  🔴0·AGY-QA  🔴1·AGY-PJM  🟢0·AGY-PDM`）。未讀數 >= 1 顯示為紅色 `🔴N·`，未讀數為 0 顯示為綠色 `🟢0·`。
    *   **通道 `all` 與 `any` 訊息機制**：
        *   **`any` 信箱**：若訊息的 `receiver === 'any'`，該 sessionId 的當前活躍角色 in `listUnread` 時可讀取到此訊息。當任一 agent 成功搶鎖（`claimMessage`）後，訊息狀態變為 `IN_PROGRESS` 且 `lock_owner` 設為該 agent_id，其他人在 `listUnread` 中便無法再看見此訊息（先搶先得）。
        *   **`all` 信箱 (廣播)**：當發送端調用 `channel_send` 且指定 `receiver === 'all'` 時，`sendMessage` 內部應自動查詢 DB 中所有註冊且狀態為 `'active'` 的活躍角色（排除發送者 sender 本身），並為名單中的每個活躍 `agent_id` 各自寫入一筆獨立的未讀訊息紀錄，其 `receiver` 設為該 `agent_id`。
    *   **強制接管限制與被接管端快取同步**：
        *   `force: true` 的強行接管行為僅限於「相同 `agent_id` 被另一個不同 `session_id` 再次註冊」的衝突場景。此時只允許從資料庫中更新該特定 `agent_id` 的 `session_id` 綁定，嚴禁波及當前 DB 中該舊 Session 綁定的其他角色紀錄。
        *   **被接管舊端快取檔案同步**：在 DB 更新後，系統必須主動找出被搶角色原本所屬的舊 `session_id`（如 `Session A`）與其對應的快取檔案 `<dbDir>/agent-sessions/<termKey_A>.json`。
            1. 從該舊快取檔的 `agent_ids` 列表中物理移除已被接管的 `agent_id`。
            2. 若舊快取檔的主身份 `"agent_id"` 剛好為被接管的角色，則應重新在剩下活躍角色中推導一個新主身份更新（例如選取首位或 mtime 最新者）；若被接管後，該舊 session 已無任何活躍角色（`agent_ids` 為空），則直接物理刪除該舊快取檔，確保兩端快取狀態與實體 DB 100% 一致。
