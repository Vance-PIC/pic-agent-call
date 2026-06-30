# 💡 pic-agent-call 架構優化解決方案提案 (Solution Proposal)

本提案由 **`pic-SA` (系統分析師)** 建立，針對友人提供的 [`feedback/pic_agent_call_analysis.md`](file:///C:/PIC/AI%20tools/claude-marketplace/pic-agent-call/feedback/pic_agent_call_analysis.md) 分析報告中所指出的四項核心風險，制定具體的架構改進規格。

本提案經人類核准後，將作為後續 `pic-PG` 進行程式重構的唯一真實來源 (SSoT)。

---

## 🎯 1. 優化規格設計

### 🛡️ 方案 A：全面落實交易重試與寫入鎖（解決 SQLITE_BUSY 鎖庫）
*   **調整目標**：消除多個 AI 視窗併發呼叫工具或背景 statusline 指令定期查詢/更新 DB 時發生的 `SQLITE_BUSY` 崩潰。
*   **規格修改**：
    1.  **資料庫連線配置**：確保 `db.mjs` 中的 `sqlite3` 連線啟用 `WAL` (Write-Ahead Logging) 模式與合理的 `busy_timeout`（如 5000ms）。
    2.  **全面包裹 `withRetry`**：
        *   所有包含 `INSERT` / `UPDATE` / `DELETE` 動作的方法，必須使用 `withRetry` 進行包裹。
        *   涉及多步驟的資料庫異動，必須使用 `BEGIN IMMEDIATE` 與 `COMMIT` 包裹為資料庫事務（Transaction），並將整個事務 block 包裹在 `withRetry` 內。
    3.  **覆蓋範圍**：
        *   `src/memory.mjs`：`createEntities`、`addObservations`、`createRelations`、`addObservation`。
        *   `src/tasks.mjs`：`createTask`、`claimTask`、`completeTask`、`failTask`。
        *   `src/channel.mjs`：`channelSend`、`channelClaim`、`channelAck`。

### ⚡ 方案 B：JSON 備份同步 (JSON Graph Sync) 防抖與異步化
*   **調整目標**：避免大體積的 Disk I/O 阻塞 Node.js 主執行緒，並防止併發寫入時的競態覆蓋。
*   **規格修改**：
    1.  **引進防抖 (Debounce) 機制**：
        *   將原本每次寫入 DB 即時同步調用的 `syncDbToJson`，重構為具有防抖特性的版本。
        *   **防抖延遲時間**：設為 **500ms 至 1000ms**（可配置）。在防抖冷卻時間內，若有連續 DB 寫入，則重新計時。
    2.  **非同步寫入**：
        *   廢棄同步的 `writeFileSync`，改為使用 `fs.promises.writeFile` (非同步 I/O)。
        *   利用臨時檔案寫入，再以 `fs.promises.rename` 進行原子覆蓋，確保寫入安全性。
    3.  **記憶體快取與讀取**：
        *   資料庫啟動時，若 SQLite DB 為空，則同步讀取 `memory-graph.json` 載入；若不為空，則直接以 DB 內容為主，減少不必要的 JSON 讀取開銷。

### 🌪️ 方案 C：Session ID 記憶體快取（降低磁碟 I/O 與防止碰撞）
*   **調整目標**：消除 `detectActiveAgyConversationId` 頻繁掃描 `brain` 目錄的磁碟 I/O，並防止多視窗併發時的身份混淆。
*   **規格修改**：
    1.  **環境變數優先**：
        *   優先讀取進程環境變數 `ANTIGRAVITY_CONVERSATION_ID` 或 `GEMINI_CONVERSATION_ID`。
    2.  **快取 (Cache) 掃描結果**：
        *   若無環境變數，第一次執行目錄掃描（讀取 `~/.gemini/antigravity-cli/brain` 目錄下最新 mtime 的會話 ID）後，將該會話 ID 記錄在當前進程記憶體中 (Node.js Process Cache)。
        *   後續呼叫 `resolveSessionId` 時直接返回快取值，不再進行目錄掃描。

### 🔒 方案 D：Channel 安全性與 Sender 自動綁定
*   **調整目標**：防止惡意指令或未授權客戶端偽造 `sender` 向其他 AI Session 發送虛假訊息。
*   **規格修改**：
    1.  **移除 API `sender` 參數**：
        *   修改 `channel_send` 的工具定義（包含 `channel_send.json` schema），移除必填或選填 of `sender` 參數。
    2.  **伺服器端自動解析身份**：
        *   當客戶端呼叫 `channel_send` 時，伺服器端底層自動透過 `resolveSessionId()` 獲取當前連線的 `session_id`。
        *   使用該 `session_id` 向資料庫查詢已註冊的 `agent_id`（從 `registrations` 表中查詢）。
        *   若查無註冊資訊，則回傳 `401 Unauthorized` 錯誤（例如：`此會話尚未登記為 Agent 身份，無法發送訊息，請先呼叫 register_agent`）。
        *   查有註冊資訊時，自動將查得的 `agent_id` 作為 `sender` 寫入資料庫，徹底杜絕身份偽造。
    3.  **系統訊息豁免**：
        *   僅限伺服器內部觸發的背景系統清理（如逾時自動釋放任務），可以使用 `SYSTEM` 作為 `sender` 寫入。

### 🚀 方案 E：任務負載提升與超時主動清理
*   **調整目標**：支持傳遞更大體積的程式碼 diff 或長篇分析報告，並在 Agent 崩潰或非預期斷線時，主動釋放其佔用的任務。
*   **規格修改**：
    1.  **提升 Payload/Result 上限**：
        *   將 `tasks` 資料表中 `payload` 與 `result` 的欄位長度上限，由 `64KB` 提升至 `1MB`。
    2.  **基於心跳的任務釋放 (Task Auto-Release)**：
        *   利用現有的 Agent 心跳更新（每次 `getAgentStatus` 被呼叫時會更新 `last_seen`）。
        *   在任何任務查詢（如 `list_pending_tasks`）或認領（`claim_task`）時，系統底層會自動檢索目前所有狀態為 `claimed` 的任務。
        *   比對認領該任務之 Agent 的 `last_seen` 時間戳記。若超時時間（`last_seen` 距今大於 `agent_timeout_sec`，預設為 120 秒）已過，自動將該任務狀態重設為 `pending`，並清空 `claimed_by` 與 `claimed_at`。

### 📘 方案 F：TypeScript 支援 (index.d.ts)
*   **調整目標**：為協同開發者提供良好的 IDE 自動補全與靜態型別檢查支援。
*   **規格修改**：
    1.  **新增宣告檔**：
        *   在專案根目錄下建立 `index.d.ts` 定義檔，為導出之業務邏輯介面（如 `setup`, `sendMessage`, `getAgentStatus` 等）聲明完整型別。

### 🧹 方案 G：Session 快取檔案自動清理機制
*   **調整目標**：解決 `.memory/agent-sessions/` 目錄下的快取 json 檔案無限制地累積問題。在保障 statusline hook 的 fallback 機制正常運作（能讀到當前平台上最新一筆 active/offline session 身份）的前提下，自動清理過期的 session 檔案。
*   **規格修改**：
    1.  **清理判定規則**：
        *   **保護最新 fallback 快取**：對於當前平台（以 `cc-` 和 `agy-` 為區分，對應 Claude Code 和 Antigravity），必須**各保留一筆 mtime 最新的快取檔案**作為 statusline fallback。即使該 session 在 DB 中已是 `'offline'` 或已被刪除，亦不可清理此最新檔案。
        *   **生命週期清理**：除受保護的最新 fallback 外，其餘檔案若符合以下任一條件即執行清理：
            *   **條件一（極舊檔案）**：檔案修改時間（mtime）超過 7 天（168 小時）者，一律直接刪除。
            *   **條件二（孤兒快取）**：在資料庫 `agents` 表中，完全找不到該 `term_key` 對應的 session 紀錄（代表已被 force 覆寫接管刪除），且 mtime 已超過 5 分鐘（防止剛建立的併發時間差誤殺）。
            *   **條件三（超期離線）**：在資料庫中對應的記錄其 `status` 為 `'offline'`，且其 last_seen（或 mtime）距離當前時間已超過 24 小時。
    2.  **觸發時機**：
        *   在 `register_agent` MCP tool 寫入新的 session 快取檔案時（即 `writeAgentSessionCache` 執行結束前），順便調用 `cleanExpiredAgentSessionCache(db, sessionDir)` 進行清理。以確保在有新 session 產生時主動維持目錄的整潔，且不會對需要極高讀取速度的 `agent-statusline.mjs` 造成額外負擔。

---

## 📖 附錄：動作前訊息稽核門禁 (Pre-action Message Check Gate) 機制說明

*   **運作原理**：
    本專案的「動作前訊息稽核門禁」並非透過 Git Hook 或 Bash 實體腳本等物理硬體層面實作，而是基於 **AI 代理人自我約束的規則 (Rule-based Agent Gate)**。
*   **設定方式**：
    將該門禁的執行條件與規範寫入專案根目錄的 `.agents/AGENTS.md` (或本機全域 `~/.gemini/config/AGENTS.md`) 中。當 AI 代理人（Gemini/Claude Code 等）啟動並載入此專案時，會自動讀取並解析該 Rules 檔，並在執行敏感工具前在代碼思維中優先執行此門禁檢查。
*   **觸發時機與流程**：
    1.  **檢驗時機**：當 AI 代理人要調用任何「寫入/修改檔案工具」（例如 `replace_file_content`、`write_to_file`）或「指令執行工具」（例如 `run_command`）**之前**。
    2.  **稽核動作**：主動調用 `pic-agent-call` 的 `agent_status` MCP 工具。
    3.  **防守手煞車**：若 `unread > 0`，則嚴禁執行後續寫入或指令，必須立刻呼叫 `channel_list_unread` 讀取並優先處理（或回覆），直到 `unread` 降為 0，才可繼續原定的工具調用。
    4.  **批次作業例外**：當 AI 需要連續寫入多個檔案（如批次產生多個提案章節）時，為了節省 Token 與減少回應延遲，會在**批次開始前**呼叫 `agent_status` 一次並在對話中明確宣告；中途每寫入 5 個檔案強制預檢一次；在**批次完成後、向人類回報成果前**再次呼叫 `agent_status` 做最後稽核。但涉及外部發布的敏感指令（如 `git push`、`npm publish`）不在此豁免內，必須強制單次預檢。

---

## 📅 2. 完工標準 (DoD)

1.  **規格一致性**：所有程式實作需與此 Proposal 規格 100% 相符。
2.  **單元測試覆蓋**：
    *   針對 `channel_send` 安全性邏輯，新增單元測試，驗證若無註冊身份發送訊息會失敗，而註冊後發送時 `sender` 會自動被正確帶入。
    *   針對 `register_agent` 清理快取邏輯，新增單元測試，驗證過期快取能被自動清理且最新 fallback 檔案受到保護。
    *   執行 `npm run test`，所有單元測試須 100% Pass。
3.  **物理證據驗收**：
    *   測試報告與證據需寫入 `evidence/`。

---

## 💬 3. 人類決策閘口 (Decision Gate)

請評估本方案是否合適：
- [x] **同意此提案**：我們將此規格更新至 `specs/P2_Design/SDD-Spec.md` 與 `api-spec.md` 中，並通知 `pic-PG` (CC) 認領任務進行重構開發。
- [ ] **需要修改**：請提出您希望調整的規格細節。
