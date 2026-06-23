# UAT Verification Checklist: pic-agent-call v1.1.0 重構與清理機制

本文件為 **`pic-QA` (品質保證工程師)** 針對 v1.1.0 重構方案（方案 A 到方案 G）所制定的 UAT 驗收清單。
測試案例與證據需最終寫入 `evidence/` 資料夾下，並於本文件中標註結果。

---

## 1. 基礎環境與介面驗證 (Infrastructure)
- [ ] **TSK-QA-001：TypeScript 宣告檔驗證**
  - **步驟**：確認 `index.d.ts` 定義檔正確生成，且語法無編譯警告。
  - **期望**：`tsc --noEmit` 或是 TypeScript IDE 語法檢查無 errors。
- [ ] **TSK-QA-002：資料庫架構與向下相容驗證**
  - **步驟**：啟動資料庫並讀取 schema，驗證 `agents` 表具備 `session_id`, `role`, `term_key` 欄位與對應的 `idx_agents_session_id` 唯一索引。
  - **期望**：遷移 SQL 自動執行無誤，表結構與索引完整建立。

## 2. 核心功能驗證 (Functional)
- [ ] **TSK-QA-003：SQLITE_BUSY 重試與事務安全性 (方案 A)**
  - **步驟**：模擬併發場景下多個 session 同時調用 DB 寫入 API（如 `createEntities`, `channelSend`, `claimTask`）。
  - **期望**：重試機制（`withRetry`）與 `WAL` 模式有效運作，不發生資料丟失或 SQLite Database Lock 崩潰。
- [ ] **TSK-QA-004：JSON 快照防抖與異步原子寫入 (方案 B)**
  - **步驟**：在防抖延遲內（如 800ms）連續對 DB 進行 10 次寫入。
  - **期望**：實際的 `memory-graph.json` 物理寫入次數顯著降低（被防抖過濾至僅寫入 1~2 次），且使用臨時檔進行非同步 `rename` 原子覆蓋，主執行緒無卡頓。
- [ ] **TSK-QA-005：Session ID 解析進程快取 (方案 C)**
  - **步驟**：多次呼叫 `resolveSessionId`。
  - **期望**：除首次載入外，後續調用不重複掃描 `brain` 目錄（不引發 Disk I/O），直接讀取 Memory 快取。
- [ ] **TSK-QA-006：Channel 訊息自動安全認證與防止偽造 (方案 D)**
  - **步驟**：
    1. 使用未在 DB 註冊的 Session 呼叫 `channel_send`。
    2. 使用已註冊身分 (如 `AGY-QA`) 的 Session 呼叫 `channel_send`（且請求參數不帶 `sender`）。
  - **期望**：
    1. 未註冊會話發送訊息失敗，並回傳 `401 Unauthorized` 錯誤。
    2. 已註冊會話成功發送，且資料庫中該訊息的 `sender` 自動綁定為 `AGY-QA`。
- [ ] **TSK-QA-007：大 Payload 任務與逾時自動釋放 (方案 E)**
  - **步驟**：
    1. 建立一個包含大體積 (例如 500KB) Payload 的任務。
    2. 建立一筆 `claimed` 任務，並手動修改認領 Agent 的 `last_seen` 模擬離線超時。呼叫 `list_pending_tasks` 或認領新任務。
  - **期望**：
    1. 大任務成功儲存至 SQLite，沒有 `64KB` 欄位溢出報錯。
    2. 離線超時 Agent 認領的任務會自動被重置為 `pending` 狀態，且其認領欄位被清空。
- [ ] **TSK-QA-008：Session 快取檔案自動清理與保護 (方案 G)**
  - **步驟**：在 `.memory/agent-sessions/` 下建立多個模擬快取 json 檔案：
    1. 平台最新的 `cc-` 和 `agy-` 檔案（其 mtime 最新）。
    2. 修改時間超過 7 天的極舊檔案。
    3. DB 中無 session 紀錄 of 孤兒檔案（建立時間大於 5 分鐘與小於 5 分鐘者各一）。
    4. DB 中 session 狀態為 offline 且 last_seen 已離線大於 24 小時的檔案。
    - 呼叫 `register_agent` 觸發清理。
  - **期望**：
    1. 最新 `cc-` 和 `agy-` 快取檔案完好保留（受保護）。
    2. 超過 7 天的快取、DB 孤兒（且 >5分鐘者）以及離線 >24小時的快取被物理刪除。
    3. 剛建立未滿 5 分鐘 of DB 孤兒快取庫存保留（防範併發時間差誤殺）。
- [ ] **TSK-QA-009：Channel 訊息橫向越權防禦驗收 (方案 D/I)**
  - **步驟**：使用 Session A 的連線去呼叫 `channel_list_unread`、`channel_claim` 或 `channel_ack` 操作寄給 Session B（已註冊為其他 Agent）的訊息。
  - **期望**：API 與 MCP 核心層攔截此越權請求，拒絕操作並拋出 `403 Forbidden` 安全性錯誤。

## 3. 一鍵安裝腳本驗收 (Setup Scripts)
- [ ] **TSK-QA-011：CC 一鍵安裝腳本 (setup-cc-statusline.mjs)**
  - **步驟**：
    1. 備份 `~/.claude/settings.json`。
    2. 執行 `node bin/setup-cc-statusline.mjs`。
    3. 檢查 `~/.claude/settings.json` 的 `statusLine` 與 `hooks.UserPromptSubmit`。
    4. 確認 `~/.claude/statusline-wrapper.sh` 已複製。
    5. 確認 `~/.claude/hooks/pic-agent-autoreg-gate.js` 已複製。
  - **期望**：
    1. `statusLine.command` 指向正確的 bash + wrapper.sh 路徑。
    2. `UserPromptSubmit` hook 包含 `pic-agent-autoreg-gate.js`（不重複新增）。
    3. 重複執行腳本不產生重複 hook 條目（冪等）。
- [ ] **TSK-QA-012：AGY 一鍵安裝腳本 (setup-agy-statusline.mjs)**
  - **步驟**：
    1. 備份 `~/.gemini/settings.json`。
    2. 執行 `node bin/setup-agy-statusline.mjs`。
    3. 檢查 `~/.gemini/settings.json` 的 `statusLine` 與 `trusted_hooks`。
  - **期望**：
    1. `statusLine.command` 指向 `msg-statusline-wrapper.mjs`。
    2. `trusted_hooks.json` 的 `*` 與所有已存在專案 key 均包含信任條目。
    3. 重複執行不重複寫入（冪等）。

## 4. 品質門禁與流程驗證 (Quality & Process)
- [ ] **TSK-QA-013：AI 動作前訊息稽核門禁驗收**
  - **步驟**：在有未讀訊息時，嘗試要求 AI 執行寫入動作。
  - **期望**：AI 能偵測到 `unread > 0` 並拉起防守手煞車，優先 claim/read 訊息，直到 unread 為 0 才繼續執行寫入。


---
*產出日期：2026-06-23*
*驗收人員：AGY-QA*
*測試結果：PENDING*

---
## ⚖️ 範本異動紀錄 (Template Changelog)

| 範本版本 | 異動日期 | 專案規範對齊 | 異動者 | 異動內容 |
| :---: | :---: | :---: | :---: | :--- |
| V1.0.0 | 2026-06-23 | pic-agent-call v1.1.0 | AGY-QA | 建立 v1.1.0 重構方案專屬的 UAT 驗收測試清單 |
