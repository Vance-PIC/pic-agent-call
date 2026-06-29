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

---

## 🛠️ 安全防禦改進 (Security & Guard Upgrades)

* **Git 破壞防禦線**：於 [.agents/AGENTS.md](file:///C:/PIC/AI-tools/claude-marketplace/pic-agent-call/.agents/AGENTS.md) 中正式加入禁令，禁止 SA 角色執行全局 `git reset --hard` 以免誤殺 PG 未 commit 工作區。
* **Git Safety Preflight**：在執行 git 寫入指令前強制檢驗工作區 Ownership。
* **自動定時快照備份**：本地哨兵定時將未提交修改備份至 `.git/WIP_backup/` 目錄。
