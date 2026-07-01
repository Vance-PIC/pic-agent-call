# SDD-Spec (L1) — pic-agent-call v1.1.3

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
│   ├── server.mjs                    ← MCP server 入口
│   ├── agent-statusline.mjs          ← 狀態列主程式（CC + AGY 共用）
│   ├── agent-statusline-wrapper.mjs  ← AGY 狀態列包裝器（拼裝 Quota + Channel 狀態）
│   ├── setup-agy-statusline.mjs     ← AGY 狀態列一鍵安裝腳本
│   ├── setup-cc-statusline.mjs      ← CC 狀態列一鍵安裝腳本
│   └── setup-utils.mjs              ← 安裝腳本共用工具函式
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
| `bin/agent-statusline.mjs` | CC/AGY statusbar hook CLI：優先以 `PIC_TERM_KEY` 查 `agents.term_key`（`getRegistrationsByTermKey`），查無結果才 fallback 至 `session_id`（AGY 或無 `PIC_TERM_KEY` 環境）；DB 無結果則輸出 `NO AGENT` | src/db.mjs, src/status.mjs |
| `bin/agent-statusline-wrapper.mjs` | Gemini/Antigravity 狀態列整合包裝器：拼裝 Quota 狀態與 Agent 訊息狀態。**v1.1.4 重構**：廢棄 `process.stdin.on('end')` 等待觸發模式，改為啟動時以**非阻塞式 readline（50ms timeout）** 讀取 stdin 並同時解析環境變數（`ANTIGRAVITY_CONVERSATION_ID`、`MEMORY_DB_PATH`），解決 AGY CLI 不關閉 stdin 造成的 1500ms 超時 `exit status 1` 問題。50ms 後若無 stdin 輸入則以環境變數降級處理；若環境變數亦未設定則以空值降級。 | node:child_process, node:fs, node:path, node:os, node:readline |
| `~/.gemini/statusline-wrapper.mjs` | **Thin Forwarder（使用者層）**：由 `setup-agy-statusline.mjs` 安裝至使用者家目錄，作為 `settings.json` `statusLine.command` 的進入點。**⚠️ 禁止硬編碼**：forwarder 內的 `target` 路徑嚴禁寫死為固定絕對路徑；必須由 `setup-agy-statusline.mjs` 在安裝執行時動態解析出 `bin/agent-statusline-wrapper.mjs` 的真實絕對路徑，並以字串替換方式注入至 forwarder 的 `target` 變數中後，再寫入使用者家目錄。如此可確保跨使用者、跨安裝路徑皆能正確執行，且命名變更時只需重新執行安裝腳本即可，無需手動修改 forwarder。 | node:child_process, node:fs, node:os |

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
| register_agent | status.registerAgent |
| agent_status | status.getAgentStatus |

#### register_agent 規範（v1.1.3）

`register_agent` MCP tool 更新 SQLite `agents` 表，並將 `PIC_TERM_KEY`（Windows Terminal session GUID）寫入 `agents.term_key` 欄位作為跨 session 識別依據。

> **⚠️ [廢棄 v1.1.3]** 本地快取檔 `agent-sessions/<termKey>.json` 機制已廢棄，不再由 `register_agent` 寫入。跨 session 識別職責改由 DB `agents.term_key` 欄位承擔。

#### register_agent 與 agent_status 隔離優化（v1.2.2）

為了防止在全域單例的 MCP 伺服器環境中，因 `session_id` 誤判碰撞（如 `detectActiveAgyConversationId` 競態）導致不同終端視窗的角色在 `force` 註冊時被標記為離線：

1. **清理條件卡控 (`register_agent`)**：
   在 `registerAgent` 內部的 forced 清理邏輯中，`UPDATE agents SET status = 'offline' ...` 語法必須同時過濾 `session_id` 與 `term_key`（即僅清理當前 Terminal 視窗下的舊角色），防止將相同 `session_id` 但不同 `term_key` 的其他視窗角色踢下線。
2. **精確路由支援 (`agent_status`)**：
   `agent_status` MCP 工具增加可選參數 `wt_session`。若傳入該參數，MCP 伺服器將優先使用 `getRegistrationsByTermKey` 尋找 DB 中對應的 `session_id`，以解決多視窗下 Session ID 被誤判碰撞的問題。

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
5.  **[廢棄 v1.1.3] Session 快取檔案自動清理機制（`cleanExpiredAgentSessionCache`）**：
    *   此機制已於 v1.1.3 移除。跨 session 識別改由 hook 三道防線維護 `term_key` 一致性（詳見 §6.11）。
6.  **動作前訊息稽核門禁 (Pre-action Message Check Gate) 機制**：
    *   規範 AI 代理人於調用 any「寫入/修改檔案」或「執行指令」工具之前，必須強制主動執行 `agent_status` 查詢 unread 訊息。若 `unread > 0`，必須暫停寫入（防守手煞車），直至讀取並處理完畢。批次作業時於頭尾預檢且中途每寫入 5 個檔案強制預檢一次；敏感部署/提交命令無批次豁免權。
7.  **多角色並列指示器與平台聚合狀態列 (Multi-role Statusline Aggregation)**：
    *   `agent-statusline.mjs` 執行時，根據當前 `callerType`（`cc` 或是 `agy`）自動識別所屬平台。
    *   **Session ID 直查規範**：必須以 `CLAUDE_CODE_SESSION_ID`（CC）或 `ANTIGRAVITY_CONVERSATION_ID`（AGY）直接查詢 DB `agents` 表取得當前 session 的所有活躍角色。**禁止**以掃描 `agent-sessions/` 目錄取最新快取檔的方式作為 fallback（此行為會污染跨 terminal 顯示）。DB 查無結果時直接輸出 `NO AGENT`。
    *   除了讀取當前 session 的所有活躍角色外，必須向 DB 查詢該平台下所有已註冊且活躍/離線的角色（如 `WHERE agent_id LIKE 'AGY-%'` 或 `LIKE 'CC-%'`）與其各自的未讀訊息數。
    *   拼裝成並列格式輸出：當前視窗主身份固定排在首位且其前置加上 `▶` 標示，其餘角色依序並列顯示（例如：`▶🔴1·AGY-SA  🟢0·AGY-PG  🔴0·AGY-QA  🔴1·AGY-PJM  🟢0·AGY-PDM`），各角色間以兩個空格區隔，不使用 `|` 符號。確保使用者在單視窗切換或多實例並行時，能即時掌握平台全角色的未讀狀態，消除訊息漏看盲區。
8.  **AI 啟動時自動與互動式引導註冊機制 (Auto & Interactive Registration)**：
    *   規範 AI 代理人於新會話啟動執行 `Session Startup Protocol` 時，若呼叫 `agent_status` 發現當前 session 狀態為 `registered: false`：
        1.  **優先自動註冊**：AI 應根據當前環境變數、進程名稱，或讀取 `task.md` 中被指派且待執行的 WBS 任務，自動推導其應擔任的角色，並自動調用 `register_agent` 註冊（如 `CC-PG1` 或 `AGY-SA`）。
        2.  **互動式引導**：若無法自動推導，AI 必須主動在對話框中提供明確的角色選項詢問人類；在人類回覆選取後，自動調用 `register_agent` 完成註冊，方可開始後續工作。
        3.  **命名與放行規範**：互動式註冊選單的選項，AGY 側必須嚴格採用以 `AGY-` 為前綴的標準 PIC 角色（如 `AGY-SA`、`AGY-PG`、`AGY-QA`、`AGY-PJM`、`AGY-PDM`）；CC 側則為 `CC-` 前綴。此外，AGY 側與 CC 側的 `UserPromptSubmit` hook 腳本（`autoreg-gate`）必須內含關鍵字放行邏輯，當 prompt 含有 `register_agent` 或 `register agent` 時豁免 session 登記檢查，避免雞生蛋閉鎖。
        4.  **Hook 強制等級**：`autoreg-gate` hook 採 **`block`**（v1.1.3 已升級，從 warn 改為 block）。block 訊息含診斷資訊（session prefix、PIC_TERM_KEY prefix）與 `register_agent` 呼叫範例，協助 AI 快速定位並完成登記。AI 自律（Session Startup Protocol）為主要執行保障，hook 為強制防線。
9.  **Channel 訊息 Receiver 與操作安全防護 (橫向越權防護)**：
    *   `channel_list_unread`、`channel_claim`、`channel_ack` 等核心 API 及對應 Tool Handlers，在執行時必須傳入當前連線的 `sessionId`。
    *   API 內部執行安全性校驗與接收信箱判定：
        *   **當前活躍角色定位**：由 DB 查詢 `agents.term_key = PIC_TERM_KEY`（若 `PIC_TERM_KEY` 環境變數存在）取得角色列表，其第一筆即為當前活躍角色（主身份）；若無 `PIC_TERM_KEY` 或查無資料，則 fallback 使用 `sessionId` 查詢 `agents` 表之第一筆作為活躍角色。本地快取檔 `agent-sessions/<termKey>.json` 已於 v1.1.3 廢棄，不再作為角色識別依據。
        *   `channel_list_unread`：若傳入特定的 `receiver` 參數，該 receiver 必須為當前活躍角色（或其對應之 role 郵箱），否則拋出 403 越權錯誤。返回結果應包含發送給該活躍角色、其 role 郵箱（格式為 `role?`）、以及發送給 `'any'` 且狀態為 `'UNREAD'` 的訊息。若 `receiver` 未指定或為 `'all'`，則系統自動拉取該 `sessionId` 綁定之所有活躍角色各自未讀訊息的聯集。
        *   `channel_claim` 與 `channel_ack`：嚴格限制只能操作當前活躍角色有權處理的訊息。操作者傳入之 `agent_id` 必須與當前活躍角色（主身份）完全相符，且訊息接收者（`receiver`）必須為該當前活躍角色（或其 `role?` 郵箱，或為 `'any'` 且狀態為 `'UNREAD'`），禁止越權搶鎖或確認非本活躍角色的訊息。若傳入之 `agent_id` 與定位出的當前活躍角色不符，API 必須拒絕並回傳 403 錯誤。
10. **一會話多角色並存與接管規範 (One-Session Multi-Identities & Takeover)**：
    *   **資料庫約束調整**：物理刪除 `agents` 表上對 `session_id` 的唯一索引 (`idx_agents_session_id`)。允許一個會話 (`session_id`) 同時登記多個不同的 `agent_id`（如 `AGY-SA`、`AGY-PG`、`AGY-QA`、`AGY-PJM`、`AGY-PDM` 同時綁定同一個 `session_id`），第一個為 `active` (主角色)，其餘為 `attached` (掛載角色)。
    *   **多角色分隔解析**：`register_agent` 支援在 `agent_id` 與 `role` 參數中傳入以逗號（半形 `,` 或全形 `，`）、頓號（`、`）、斜線（`/`）、加號（`+`）、分號（`;` 或 `；`）或空格等分隔的多個字串（例如 `agent_id` 填入 `"SA/PG/QA/PJM/PDM"` 或是 `"AGY-SA+AGY-PG+AGY-QA+AGY-PJM+AGY-PDM"`）。系統在執行 `register_agent` 時**必須使用正規表達式（如 `/[,\/\\+，、；;\s]+/`）進行 Token 分割**，將其拆解成多個獨立的角色分別呼叫註冊流程，嚴禁將整串含有分隔符號的字串直接當作單一 `agent_id` 寫入資料庫。
    *   **平台前綴補全與角色自動推導**：若拆分後的子角色識別碼（例如 `SA`）不包含平台前綴（`AGY-` 或 `CC-`）：
        *   系統應根據當前 `sessionId` 的類型自動補齊前綴。若為 Antigravity 連線（前綴 `agy-`）則補上 `AGY-` 前綴變成 `AGY-SA`；若為 Claude Code 連線（前綴 `cc-`）則補上 `CC-SA`。
        *   系統應自動將該無前綴的角色名（如 `SA`、`PG`、`QA`、`PJM`、`PDM`）填入其對應 SQL 的 `role` 欄位中，除非 `role` 參數有額外指定對應的角色。
    *   **[廢棄 v1.1.3] 快取檔案擴充與同步**：本地快取檔 `agent-sessions/<termKey>.json` 的格式規範（含 `agent_id`、`agent_ids`、`term_key`、`ts` 欄位）已全段移除。快取機制廢棄，改由 DB `agents.term_key` 欄位與 hook 三道防線（§6.11）承擔跨 session 識別職責。
    *   **心跳與狀態列同步更新（讀寫分離與心跳降頻）**：
        *   狀態列（`getAgentStatus`）輪詢因頻率極高（每秒執行），為了徹底防止 SQLite 寫鎖定造成的 `ETIMEDOUT` 阻塞超時，必須實施**讀寫分離**與**心跳降頻**：
            1.  **心跳降頻**：系統在查詢當前 session 狀態時，必須先對比 DB 中已存的 `last_seen` 與當前時間。若時間差小於 **10 秒**，則**直接跳過 DB UPDATE 心跳操作**，只執行唯讀查詢（SELECT）。因為 WAL 模式下 SELECT 絕對不會被寫鎖阻塞，這能將 90% 以上的輪詢轉為無鎖唯讀。
            2.  **非同步/重試保護**：若時間差大於等於 10 秒需要執行 `UPDATE agents` 心跳更新，此 Update 操作必須被 `withRetry` 包裹，或以**非同步（async/Promise）背景 fire-and-forget** 方式非阻塞執行。`getAgentStatus` 本身應立即返回未讀數結果，不應被心跳寫入鎖定所阻塞。當前 Session 的心跳更新時，會同時將綁定在此 `session_id` 下的所有 `active` 角色的 `last_seen` 統一更新為當前時間，並且一併確保這些角色的 `status` 被重設/保持為 `'active'`（防止 session 本身活躍但旗下某些未操作的角色因超時被 offline）。
    *   **孤兒訊息處理限制**：只有當舊角色 `previousAgentId` 徹底被註銷或被其他 session 接管，且**不再屬於當前 `sessionId` 的活躍角色名單**時，才可觸發孤兒訊息（ORPHANED）的標記與通知。若舊主身份仍然屬於當前會話的並存活躍角色，則絕對禁止觸發孤兒標記，以防止切換主角色時誤殺並存角色的未讀訊息。
    *   **資料庫約束調整**：物理刪除 `agents` 表上對 `session_id` 的唯一索引 (`idx_agents_session_id`)。
    *   **多角色分隔解析**：`register_agent` 支援使用正規表達式 `/[,\/\\+，、；;\s]+/` 對 `agent_id` 進行 Token 分割，拆解為多個獨立角色寫入資料庫。
    *   **心跳與狀態列同步更新**：實施**讀寫分離**與**心跳降頻**（10 秒閾值），並以非同步背景執行更新。
    *   **狀態列資訊聚合 (getAgentStatus)**：
        *   `getAgentStatus` 回傳的 `unread` 為該 `sessionId` 綁定之所有活躍角色未讀數之總和。
        *   其 `display` 格式改為各角色個別並列顯示，以兩個空格區隔（不使用 `|` 符號）：所有活躍角色在狀態列中固定依註冊創建時間 (created_at ASC) 排列，不再將主角色移至首位；主身份僅在其角色名稱前置加上 `▶` 標示，其位置隨 active 角色狀態動態跳動以維持順序穩定 (No Jitter)（例如：`▶🔴1·AGY-SA  🟢0·AGY-PG  🔴0·AGY-QA  🔴1·AGY-PJM  🟢0·AGY-PDM`）。未讀數 >= 1 顯示為紅色 `🔴N·`，未讀數為 0 顯示為綠色 `🟢0·`。
    *   **通道 `all` 與 `any` 訊息機制**：
        *   **`any` 信箱**：若訊息的 `receiver === 'any'`，該 sessionId 的當前活躍角色 in `listUnread` 時可讀取到此訊息。當任一 agent 成功搶鎖（`claimMessage`）後，訊息狀態變為 `IN_PROGRESS` 且 `lock_owner` 設為該 agent_id，其他人在 `listUnread` 中便無法再看見此訊息（先搶先得）。
        *   **`all` 信箱 (廣播)**：當發送端調用 `channel_send` 且指定 `receiver === 'all'` 時，`sendMessage` 內部應自動查詢 DB 中所有註冊且狀態為 `'active'` 的活躍角色（排除發送者 sender 本身），並為名單中的每個活躍 `agent_id` 各自寫入一筆獨立的未讀訊息紀錄，其 `receiver` 設為該 `agent_id`。
    *   **強制接管與孤兒訊息限制**（v1.1.4 強化）：
        *   `force: true` 的強行接管行為僅限於「相同 `agent_id` 被另一個不同 `session_id` 再次註冊」的衝突場景。此時只允許從資料庫中更新該特定 `agent_id` 的 `session_id` 與 `term_key` 綁定，嚴禁波及當前 DB 中該舊 Session 綁定的其他角色紀錄。
        *   **精準孤兒判定**：當執行強制接管時，只有當該 `agent_id` 原本綁定的 `term_key`（舊視窗）與新傳入的 `termKey`（當前視窗）**不同（跨 Terminal 視窗奪取）**時，才將其 UNREAD 訊息孤兒化（ORPHANED）並通知發送者；若兩者 `term_key` 相同（同物理視窗重啟會話 Resume 移轉），則必須保留所有未讀訊息不予孤兒化。
        *   **主角色指定與 displays**：強制接管成功後，該被 force 的角色之 `status` 被設定為 `'active'`，同會話其他角色的 `status` 均重設為 `'attached'`，以確保其穩定排在首位成為主角色（`▶` 標示）。
        *   **[廢棄 v1.1.3] 被接管舊端快取檔案同步**：此機制已移除（快取檔已廢棄）。接管後的一致性由 DB `agents.term_key` 欄位與 `status` 直接反映，無需同步快取檔。

---

## 6.11 PIC_TERM_KEY / term_key 三道防線 (v1.1.3)

詳細文件：[docs/wt-session-term-key.md](../../docs/wt-session-term-key.md)

`register_agent` 與 `getRegistrationsByTermKey` 透過以下三道防線維護 `agents.term_key` 與 session 的一致性：

| 防線 | 觸發條件 | 行為 |
|------|---------|------|
| **一道** | `session_id` 命中 DB | `UPDATE agents SET term_key = PIC_TERM_KEY`（resume 換視窗場景）|
| **二道** | `term_key`（`PIC_TERM_KEY`）命中 DB | `UPDATE agents SET session_id = <new_session_id>`（同視窗新 session）|
| **三道** | 兩者均不命中 | 若無 `force`，block 並顯示診斷資訊（session prefix、PIC_TERM_KEY prefix）與 `register_agent` 呼叫範例 |
| **四道 (v1.1.4)** | `PIC_TERM_KEY` 存在且與 DB `term_key` 不同 | 無條件直接覆寫該 `session_id` 下所有角色的 `term_key`，達成即時視窗 Resume 轉移 |

---

## 6.12 v1.1.4 Code Review 安全與併發防禦規格

針對 P3 階段 Code Review 所發現的併發、時區、錯誤吞噬與授權漏洞，本專案實施以下安全防線與設計規範：

1. **TOCTOU Race 併發防護防線 (C1, I3, I5)**：
   * **任務狀態變更 (C1)**：`completeTask` 與 `failTask` 核心 API 在執行「狀態預檢」與「UPDATE 狀態更新」時，**必須**使用 `BEGIN IMMEDIATE` 與 `COMMIT` 資料庫事務（Transaction）包裹。且在 UPDATE 執行後，必須嚴格檢查資料庫受影響列數（`changes`），唯有 `changes > 0` 且無 error 時方可回傳 `{ success: true }`；若已被搶先完成或狀態不符，應 Rollback 並回傳 `{ success: false, reason: 'Task status changed' }`。
   * **廣播對象鎖定 (I3)**：在 `sendMessage` 進行 `all` (廣播) 訊息發送時，查詢所有活躍 agent 的 `SELECT` 語句**必須**移入 `BEGIN IMMEDIATE` 事務內部執行，避免在查詢與寫入訊息的空隙中，活躍角色狀態發生變更而導致幽靈接收者。
   * **訊息領取與確認 (I5)**：`claimMessage` 與 `ackMessage` 中的主角色解析與權限校驗，**必須**包含在資料庫事務內部，或實施 best-effort 讀寫一致性防護，防止在讀取角色到搶鎖/確認訊息之間發生主角色越權或奪占。

2. **時區與時間格式統一 SSoT 規格 (I1, I2)**：
   * 全模組（含 `src/tasks.mjs`、`src/memory.mjs` 等）寫入或更新時間欄位（如 `completed_at`、`updated_at`、`created_at` 等）時，**禁止在 JavaScript 端使用 `getTimezoneOffset` 等手動 offset 運算**，以防 DST 邊界或非整小時時區計算被截斷。
   * 資料庫內所有時間寫入，**統一、強制使用 SQLite 的 `datetime('now','localtime')` 函式**，確保全系統時間事實的唯一來源與排序一致。

3. **健壯的錯誤處理與防護規格 (C2, I4)**：
   * **JSON 快照同步例外處理 (C2)**：`db.mjs` 中的 `_doSyncDbToJson` 防抖同步，**禁止完全吃掉 exception**。在寫入或 rename 失敗時，必須使用 `console.error` 完整記錄錯誤堆疊，且應提供健康狀態旗標以防 `memory-graph.json` 靜默損壞而使 Swarm Swarm 記憶斷鏈。
   * **Schema 遷移容錯判定 (I4)**：在 `db.mjs` schema migration 執行 `ALTER TABLE` 時，**禁止盲目吞噬所有 exception**。必須實施條件判斷：僅允許 swallow 包含 `duplicate column` 類型的重複新增錯誤，其餘所有結構錯誤（如 table 缺失、DB 損壞）必須主動 rethrow 或記錄嚴重日誌，確保遷移安全性。

4. **測試覆蓋防線規格 (I6)**：
   * 為了驗證協作通道（Channel）的安全領取與確認邏輯，必須在 `tests/channel.test.mjs` 中，**新增 `channel_claim` 與 `channel_ack` 的專利整合測試**，特別是模擬併發操作與越權操作的測試場景，以達成 DoDs 測試覆蓋門禁。

5. **多角色三態狀態模型 (Three-State Model) 與轉移規格 (v1.1.4 補正)**：
   * **欄位結構重整**：徹底廢止原 \`is_primary\` 欄位。在 \`agents\` 表的 DDL 中將 \`status\` 限制為三態，且 **\`term_key\` 欄位明確設為 \`NOT NULL\`**（強制推動 \`PIC_TERM_KEY\` 大一統）：
     \`\`\`sql
     term_key TEXT NOT NULL,
     status   TEXT NOT NULL DEFAULT 'offline' CHECK(status IN ('active', 'attached', 'offline'))
     \`\`\`
   * **三態定義**：
     * **\`active\`**：主角色 (Primary)。同一 \`term_key\` 物理視窗在同時間僅能有一個 \`active\` 角色，獨佔對話框讀信與 Claim/Ack 特權。
     * **\`attached\`**：掛載角色 (Attached)。可多個共存於同視窗下，僅限讀取未讀訊息數，禁止詳細讀信與 Claim。
     * **`active`**：主角色 (Primary)。同一 `term_key` 物理視窗在同時間僅能有一個 `active` 角色，獨佔對話框讀信與 Claim/Ack 特權。
     * **`attached`**：掛載角色 (Attached)。可多個共存於同視窗下，僅限讀取未讀訊息數，禁止詳細讀信與 Claim。
     * **`offline`**：離線/超時角色。不顯示於狀態列中。
   * **唯一活躍約束**：在 DB 層面建立部分唯一索引，確保同一視窗同一時間僅能有一個 `active` 角色：
     ```sql
     CREATE UNIQUE INDEX idx_agents_term_active ON agents(term_key) WHERE status = 'active'
     ```
   * **視窗移轉 (A/B 情境整批轉移與主角色重設防衝突)**：
     * 當新會話在當前視窗啟動時，先斷開舊會話的活躍狀態，再整批繫結：
       ```sql
       -- 1. 斷開此視窗下其他舊會話的活躍狀態（設為 offline）
       UPDATE agents SET status = 'offline' WHERE term_key = ? AND session_id != ?
       ```
     * **防 Active 鎖定衝突**：當同一個會話（session_id）重新登記並調整角色主從順序時，為了防止在 `for` 迴圈處理第一個角色設為 `'active'` 時，與資料庫中殘留的舊 active 角色發生唯一索引衝突，`registerAgent` **必須在執行註冊迴圈前，先將當前會話（session_id）下的所有角色狀態全部降級/重設為 `'attached'` 以釋放 active 鎖定**：
       ```sql
       UPDATE agents SET status = 'attached', updated_at = datetime('now','localtime') WHERE session_id = ?
       ```
   * **防 NULL 抹除**：若 API 傳入的 `termKey` 為空，程式**強制沿用並保留 DB 中已有的 `term_key` 值，禁止覆寫為空**。

6. **SQLite 資料庫路徑解析防分裂規格 (v1.1.4 補正)**：
   * **防分裂解析防線**：`src/db.mjs` 中的 `resolveMemoryPaths` 函式在解析專案目錄 `.memory` 時，**必須**從當前目錄向上尋找直到發現 `.git` 或者是 `package.json` 以定位出專案根目錄，並以此根目錄下的 `.memory/memory-graph.db` 作為讀寫路徑，不得盲目依賴 `process.cwd()`，以此確保全進程 SSoT 資料庫一致。

7. **多角色生命週期防護與雙重超時規格 (v1.1.4 補正)**：
    * **心跳防連坐與 Attached 豁免（含 10 秒降頻與讀寫分離）**：
      * `getAgentStatus` 內部的 Heartbeat 更新，**僅限更新 `status IN ('active', 'attached')` 的在線角色**，更新其 `last_seen` 以維持其掛載狀態，嚴禁喚醒已 `offline` 的離線角色。
      * **心跳降頻（10 秒限制）**：在執行任何 DB 寫入更新前，必須先 SELECT 查詢當前 session 角色的 `last_seen`。如果其與當前時間差小於 **10 秒**，則**直接跳過所有心跳寫入操作（UPDATE）**，僅執行唯讀查詢（SELECT）。
      * **非同步背景更新**：如果時間差大於等於 10 秒需要執行 `UPDATE agents`，此 Update 操作必須以**背景非同步（fire-and-forget）**非阻塞方式執行，確保狀態列輪詢（`getAgentStatus`）能立即返回未讀數結果，絕不被任何 SQLite 寫鎖定所阻塞。
      ```sql
      UPDATE agents SET last_seen = datetime('now','localtime')
      WHERE session_id = ? AND status IN ('active', 'attached')
      ```
   * **動態超時參數配置（settings.json 可自訂參數化）**：
     * `register_agent` API 新增可選參數 `timeout`（分鐘數），寫入 DB 時自動乘以 60 換算為秒數寫入 `agents.agent_timeout_sec` 欄位以向下相容。
     * **可配置參數清單 (settings.json)**：
       1. **`"agentTimeoutMin"`**：Session 存活超時時間，預設值為 **1440** (分鐘 / 即 24 小時)。
       2. **`"statusLineFreshnessMin"`**：狀態列即時在線黃燈新鮮度判定閾值，預設值為 **120** (分鐘 / 即 2 小時)。
       3. **`"historyPurgeMin"`**：歷史離線角色資料庫徹底 DELETE 清除之存活期閾值，預設值為 **10080** (分鐘 / 即 7 天)。
       * 系統內部在讀取配置時，若 `settings.json` 內未顯式配置該屬性鍵，一律自動 fallback 採用上述官方定義之預設值。
   * **雙重超時閾值定義**：
     * **Session Timeout (會話存活超時: 1440 分鐘)**：凡全系統中任何活躍角色的 `last_seen` 超過其 `agent_timeout_sec`（由 `agentTimeoutMin` 或 API 傳入值換算）時，一律自動更新標記為 `status = 'offline'`。這是為了控制資料庫資料存活期。
     * **Statusline Freshness Threshold (狀態列即時在線新鮮度: 120 分鐘)**：此閾值不寫入 DB，僅由狀態列渲染腳本（`agent-statusline.mjs`）在讀取時，讀取配置的 `statusLineFreshnessMin`，用於判定角色是否為黃燈 🟡（例如 `last_seen` 超過該設定分鐘數未更新，狀態列顯示其為黃燈），不修改其 DB 存活狀態。
   * **歷史離線自動清理防線**：為了避免離線註冊無限累積導致資料冗餘，`getAgentStatus` 每次執行超時判定時，**必須自動執行過期刪除**：凡 `status = 'offline'` 且其最後活躍時間（`last_seen`）已超過 `historyPurgeMin` 設定值（預設 **10080 分鐘 / 7天**）的歷史紀錄，一律自資料庫中徹底執行 `DELETE` 清除。
     ```sql
     DELETE FROM agents WHERE status = 'offline' AND last_seen < datetime('now','localtime','-' || historyPurgeMin || ' minutes')
     ```

8. **狀態列安裝與環境變數自動注入規格 (v1.1.4 補正)**：
   * **腳本範疇**：本專案包含 `bin/setup-statusline.mjs` (Gemini 側) 與 `bin/setup-cc-statusline.mjs` (Claude 側) 一鍵安裝與引導環境設定腳本。
   * **自動注入行為**：當此安裝或引導腳本執行時，必須在使用者當前的 Shell 環境中檢測並自動注入非空視窗識別碼：
     * 若發現當前視窗環境變數 `$env:PIC_TERM_KEY`（或舊的 `WT_SESSION`）不存在：
       * 腳本**必須自動產生一組全新的 UUID 碼**。
       * 在 Windows (PowerShell/Cmd) 環境下，腳本必須將此 UUID 自動寫入當前活動視窗的環境變數：`$env:PIC_TERM_KEY = "UUID"`。
       * 在 Unix/Linux/macOS (Bash/Zsh) 環境下，腳本必須將此 UUID 自動執行 `export PIC_TERM_KEY="UUID"` 寫入該 Shell 視窗。
     * 這保證了後續從該視窗啟動的任何對話框與狀態列定時重新整理進程，都能 100% 自然繼承並共享完全相同的 `PIC_TERM_KEY`。
