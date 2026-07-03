# Solution Proposal — agent-sessions 清理與 wt_session 取得機制

## 1. agent-sessions/ 快取目錄清理策略

### 背景與現狀
在 `pic-agent-call` v1.1.3 之後，已徹底廢除 `agent-sessions/<termKey>.json` 本地快取機制，跨 session 識別職責已完全轉移至資料庫中的 `agents.term_key` 欄位。因此，`agent-sessions/` 目錄下的所有快取檔案皆為歷史殘留，不再有任何業務用途。

### 清理方案
1. **清理定義與依據**：直接全數刪除，不需保留，因為 v1.1.3+ 程式碼已不再讀取此目錄。
2. **清理時機**：在 MCP 伺服器啟動初始化（`initDatabase` 或 `setup` 階段）時，自動執行一次性刪除（Delete Directory）。
3. **清理範圍**：完整清除整個 `agent-sessions/` 目錄。
4. **向下相容**：原本的 `cleanExpiredAgentSessionCache` 函式已廢棄，其實作改為 `no-op` 或僅用於刪除殘留檔案。

---

## 2. wt_session 參數的自動取得機制

### 現狀分析
由於 MCP 伺服器是以獨立進程（Parent 為 VS Code 或全域服務進程）在背景執行，與 Client 端（PowerShell / Bash 終端機）處於完全不同的進程樹中，因此 MCP 伺服器**無法**直接從自己的環境變數中讀取 Client 端的 `$env:WT_SESSION` 或 `$env:PIC_TERM_KEY`。

### 結論
- 現有設計「由 Client 端（如 CC 的 `prompt-submit` hook 或 `agent-statusline-wrapper.mjs`）在發送請求時手動帶入 `wt_session` 參數」是**目前最健壯且唯一可行**的方案。
- Server 端無法在不修改 MCP 通訊傳輸層的前提下自動取得呼叫端終端機的環境變數。
