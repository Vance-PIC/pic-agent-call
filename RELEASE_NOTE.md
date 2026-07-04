# Release Note — @pic-ai/pic-agent-call v1.3.1

* **發布日期**：2026-07-04
* **版本編號**：`v1.3.1`
* **發布角色**：`AGY-SA` (System Architect)

---

## 🚀 新增功能與重大升級 (New Features & Enhancements in v1.3.1)

### 1. Trusted term_key 解析與安全防護 (v1.3.0)
* **規格安全解耦**：MCP Server 的 `register_agent` 徹底與 AI 傳入的 `target` 參數解耦。`resolvedTermKey` 改為強制自 MCP 行程環境變數 `process.env.PIC_TERM_KEY || process.env.WT_SESSION` 解析。
* **安全卡控防護**：兩者皆缺時直接回傳 `term_key_unavailable` 拒絕註冊；僅在 `PIC_ALLOW_UNTRUSTED_TARGET_TERM_KEY=1` 的 debug flag 開啟時才允許 fallback 至 AI target（並輸出警告）。

### 2. 狀態列與 Profile 啟動金鑰 Scope 隔離機制 (v1.3.0)
* **Profile 注入重構**：重構 `scripts/setup-terminal-key.ps1`，引入 `PIC_TERM_KEY_SCOPE`（`vscode` / `windows-terminal` / `generic-shell`）。
* **隔離合約**：只在 Scope 不符或缺失時才重新生成 UUID；在 VS Code 整合終端機繼承自 Windows Terminal 的 `code .` 環境變數污染時，會自動重新生成並更新為 `vscode`，徹底防範金鑰互蓋與 `NO AGENT` 異常。

### 3. 平台池 (Platform Pool) 支援 (v1.3.1)
* **協作擴充**：新增平台信箱池（例如投遞至 `CC?` 或 `AGY?`）。系統會根據 `agent_id` 的前綴自動解析平台，使該平台下的所有活躍角色（不限角色）皆能拉取並進行原子搶鎖協作。

### 4. 發送者自排除 (Sender Self-Exclusion) (v1.3.1)
* **收件匣清理**：`listUnread` 查詢未讀時，會自動排除由當前視窗活躍角色群（`regs.agent_id`）自己發送的 `any`、`role?` 或 `platform?` 任務，避免自己在收件匣中看見並搶鎖自己發送的工作。

---

# Release Note — @pic-ai/pic-agent-call v1.2.0

* **發布日期**：2026-06-29
* **版本編號**：`v1.2.0`
* **發布角色**：`AGY-SA1` (System Architect)

---

## 🚀 新增功能與重大升級 (New Features & Enhancements)

### 1. 大一統三態活躍角色模型 (Three-State Agent Identity Model)
* **架構優化**：淘汰舊的 `is_primary` 單一欄位旗標，引進全新的 `status` 三態模型（`active` / `attached` / `offline`）。
* **功能特性**：
  * **`active` (主角色)**：同一物理視窗環境（`term_key`）下，**有且僅能有一個** `active` 角色獨佔對話框讀信與 Claim 特權。狀態列前置以 `▶` 標示。
  * **`attached` (掛載角色)**：支援多個角色並存掛載於同一視窗，僅能定時輪詢未讀數，禁止讀取信件與 Claim（403 阻斷保護）。
  * **`offline` (離線角色)**：超時或被強制接管的舊角色自動轉為 `offline` 狀態。

### 2. 心跳降頻優化與 WAL 背景非同步寫入 (High-Concurrency Heartbeat)
* **讀寫分離**：在 10 秒內重複查詢狀態時直接跳過 DB `UPDATE` 心跳，改為無鎖純讀（`SELECT`），防止 SQLite 讀寫鎖死（`ETIMEDOUT`）。
* **背景寫入**：心跳更新操作以 `setImmediate` Background Async (fire-and-forget) 方式執行，狀態列讀取立即返回，主線程 100% 不阻塞。

### 3. 多角色切換 Active 鎖定釋放機制 (Conflict-Free Switch)
* **註冊防鎖**：當同會話重新登記並切換主從角色順序時，註冊迴圈開始前會自動重設當前會話的所有角色為 `attached`，徹底解決 `idx_agents_term_active` 唯一索引衝突。

### 4. 向上遞迴尋根防分裂 (Database Root Path Fix)
* **路徑解析**：修復了 `resolveMemoryPaths` 的向上遞迴邏輯，確保在深層目錄中開啟 CLI 時，正確感應並指向同一個專案根目錄 `.memory/memory-graph.db`，防止子庫分裂。

### 5. `settings.json` 自訂分鐘參數配置化 (Cascading Configs)
* **參數自訂**：支援在全域或專案 `settings.json` 中配置以下三個以**分鐘**為單位的屬性鍵：
  * `"agentTimeoutMin"`：Session 存活超時（預設 1440 分鐘 / 24小時）。
  * `"statusLineFreshnessMin"`：黃燈新鮮度閾值（預設 120 分鐘 / 2小時）。
  * `"historyPurgeMin"`：歷史離線清理存活期（預設 10080 分鐘 / 7天）。

### 6. No Jitter 固定顯示順序狀態列顯示優化 (Sorting Consistency)
* **視覺體驗改進**：狀態列上的角色左右排列順序固定依據註冊創建時間 (`created_at ASC`) 進行排列。切換主從關係或心跳更新時，角色名稱不會左右位移或交叉閃爍。
* **動態指針跳動**：僅 `▶` 箭頭會隨當前 active 主角色的切換而在其名稱前動態跳移，維持界面極致穩定。

### 7. 狀態列傳參覆寫 Bug 搶修 (Parameter Override Bugfix)
* **修復問題**：修復了 `bin/agent-statusline.mjs` 呼叫端自作聰明將名單首位角色賦值給 `primaryAgentId` 並作為第三個參數傳給 `getAgentStatus`，導致箭頭永遠被最早創建的角色（如 SA1）強制鎖死的 Bug。目前已完全省略此參數，交由後台依據實體 `status = 'active'` 自主精確解析主角色。

---

## 🛠️ 安全防禦改進 (Security & Guard Upgrades)

* **Git 破壞防禦線**：於 [.agents/AGENTS.md](file:///C:/PIC/AI-tools/claude-marketplace/pic-agent-call/.agents/AGENTS.md) 中正式加入禁令，禁止 SA 角色執行全局 `git reset --hard` 以免誤殺 PG 未 commit 工作區。
* **Git Safety Preflight**：在執行 git 寫入指令前強制檢驗工作區 Ownership。
* **自動定時快照備份**：本地哨兵定時將未提交修改備份至 `.git/WIP_backup/` 目錄。
