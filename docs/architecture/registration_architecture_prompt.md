# [HISTORICAL ARCHIVE] 系統架構諮詢：多視窗 AI 協調系統的身份註冊與環境變數隔離設計

> **Migration Note (v1.2.2)**: 
> 本諮詢文檔為架構探索階段的歷史存檔。在 v1.2.2 中，專案正式裁定並批准採用 **Option D Lite v2** 方案：
> 1. 第一階段僅實作前台短行程註冊 CLI `bin/register.mjs`，不包裹 AI 命令行進程。
> 2. 結合方案 C 的前台環境變數繼承優勢，但**嚴禁直連 SQLite**，註冊動作必須調用共享應用服務 `src/status.mjs::registerAgent()`，確保 storage 抽象與 business 邏輯單一真實來源 (SSoT)。


## 1. 系統背景與進程拓撲
我們正在開發一個名為 `pic-agent-call` 的多代理人（AI Swarm）協調中心，該系統基於 Model Context Protocol (MCP) 與 SQLite 進行狀態持久化，主要有三個組件：
1. **MCP Server (背景長駐單例)**：由 IDE 啟動的 Node.js stdio 長行程，負責處理 AI 調用的工具 (Tool Calls)，包括 `register_agent` 等。
2. **前端 Hook (UserPromptSubmit) 與 狀態列 (Statusline)**：這兩者是使用者在前台 Terminal Shell 視窗中每次發言或定期自動 "即時 spawn" 的短生命週期 Node.js 進程。
3. **AI 代理人 (雲端 LLM)**：運行於雲端的生成模型，透過 IDE 的 stdio 向背景 MCP Server 發起工具調用。

## 2. 面臨的核心痛點 (OS 進程限制與多視窗隔離)
* **狀態列與視窗對齊需求**：使用者會多開 Terminal 視窗（視窗 A, 視窗 B），每個視窗在啟動時會被寫入一個唯一的環境變數 `PIC_TERM_KEY`。視窗底部的狀態列需要依據此 key 來查詢該視窗當前登記的角色。
* **背景與前台的隔離**：因為 MCP Server 是長行程單例，它的 `process.env` 在啟動時就定格了，無法感知使用者後來在不同 Shell 分頁中 export/產生的 `PIC_TERM_KEY`。
* **LLM 的侷限**：AI 代理人只是生成文字的模型，在產生工具調用 JSON 時，無法讀取或執行本機的 `process.env`。
* **隔離度要求**：必須完美支持多視窗、多角色併發，且絕對不能發生跨視窗的角色狀態污染。

---

## 3. 備選架構方案對比

### 方案 A：源頭變數注入 + AI 執行 `echo` 顯式傳參
* **流程**：使用者發起註冊時，AI 先透過執行 `run_command` 工具跑一次背景 shell `echo $env:PIC_TERM_KEY`（Windows）或 `echo $PIC_TERM_KEY`（Linux），看見 stdout 的金鑰明文後，在下一步的 MCP `register_agent(target: "真實UUID")` 呼叫中填入。
* **利弊**：最符合 $env 規格，保持核心 API 純粹。但 AI 註冊需多跑一輪指令任務（多花 Token 與時間），且需處理 Windows/Linux/macOS 不同的 shell 語法以防報錯，金鑰明文亦有曝露在日誌中的風險。

### 方案 B：本地對照表 JSON 快取 (前端 Hook 預寫入 + API AUTO 對齊)
* **流程**：使用者在對話框打註冊指令時，前台運行的 Hook 攔截並讀取真實 `PIC_TERM_KEY` 與當前 `session_id`，以 `{ "session_id": "term_key" }` 寫入本地 JSON 檔案。AI 註冊時直接帶入 `"AUTO"` 關鍵字，背景 MCP Server 讀取 JSON 並在 SQLite 中寫入實體角色綁定。
* **利弊**：AI 零負擔、無 OS 平台差異、金鑰不曝露。但在多視窗併發寫入同一個 JSON 檔案時，因無檔案鎖可能存在 Race Condition 風險；且 CC 與 AGY 對話 of session_id 命名空間若不一致則流程極難對齊；且引入了 SSoT 之外的隱藏設定檔側通道。

### 方案 C：前台 CLI 物理註冊腳本 (agy register)
* **流程**：AI 與背景 MCP Server 2.0 徹底不參與註冊。使用者想登記角色時，直接在終端機執行短行程 CLI 腳本：`node bin/register.mjs AGY-SA+AGY-PM`。該腳本在 Shell 前台即時執行，100% 讀得到當前視窗正確的環境變數，直接透過 SQLite 的事務寫鎖安全寫入 `agents` 資料表。而背景 Hook 只負責純唯讀的 `block` 安全防禦，Statusline 負責純唯讀的狀態查詢。
* **利弊**：AI 與 MCP 伺服器 0 負擔，Hook 保持極致純粹的唯讀防禦。由於 `register.mjs` 是前台短行程，天然享有即時環境繼承，且透過 SQLite 原生的 `BEGIN IMMEDIATE` 寫入，安全性與併發鎖 100% 保障，完全避開進程隔離與 Race Condition。但註冊行為從「與 AI 對話互動」變成了「手動在 shell 中打指令」。

---

## 4. 請幫我評估：
1. 從「多開視窗隔離安全性」、「操作系統進程模型繼承限制」、「KISS 簡潔與防併發衝突 (Race Condition)」、「跨平台容錯率」等角度，這三種方案哪一個才是最具工業級可行性的最優架構設計？
2. 方案 B 的多視窗命名空間問題與 Race Condition 是否可以被優雅解決？
3. 方案 C 作為降維打擊的 CLI 方案，是否是最不易出 Bug 且長期穩固的架構決策？請給出您的深度架構分析。
