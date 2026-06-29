# Project Rules — pic-agent-call

## MCP Tools Permission Policy
- 使用者已於 2026-06-21 09:27 授權：當 AI 代理人呼叫 `pic-agent-call` MCP 伺服器的所有工具時，皆無須再次詢問使用者，一律預先自動允許。

## Unit Testing Guidelines
- **防範家目錄環境污染 (Home Directory Pollution)**：在編寫或執行涉及讀取使用者家目錄（如 `os.homedir()`、`~/.gemini`）的測試時，必須在測試環境或特定 Test Case 中 mock/stub 家目錄路徑（例如將其設為 nonexistent 虛擬路徑），以防止實體主機中的實際快取或設定干擾測試斷言。

## 🚀 Session Startup Protocol（每次 Session 開始必須執行）
1. 呼叫 `agent_status` 確認當前 session 是否已登記。
2. 若 `registered: false`：
   - **優先自動推導**：根據任務、環境變數或 WBS 自動呼叫 `register_agent`（如 `CC-PG1`、`AGY-SA`）。
   - **無法推導時**：主動詢問使用者選取角色後立即 `register_agent`，完成前不開始其他任務。
3. 登記完成後方可進入正常工作流程。

## Pre-action Message Check Gate (動作前訊息稽核門禁)
- **觸發時機**：在呼叫任何「寫入/修改檔案工具」（如 `replace_file_content`, `write_to_file`）或「指令執行工具」（如 `run_command`）**之前**。
- **稽核動作**：AI 必須先主動呼叫 `agent_status` MCP 工具。
- **防守手煞車**：若 `agent_status` 回傳的 `unread > 0`，**嚴禁執行後續寫入或指令**。AI 必須立刻呼叫 `channel_list_unread` 讀取所有未讀訊息並優先處理（或回覆），直到 `unread` 歸零後，方可繼續原定的寫入或指令動作。

## 💬 團隊協作：對話極簡原則 (v1.1.0 共識規則)
- **極簡對話**：對話框回覆之自然語言以 3 句話為限，嚴禁任何客套、問候與重複性說辭。
- **文件沉澱**：凡涉及複雜技術分析、架構設計、完整程式碼重構，一律直接寫入/更新對應之 specs 檔案（如 .md、OpenSpec 等），對話框僅提供檔案路徑與核心摘要。
- **容許例外**：核心程式碼片段（Code Block）、方案對比表格、條列式澄清提問、以及 **Debug 錯誤追蹤的逐步推理清單 (Numbered Steps)**，不在此 3 句話限制內，但仍須保持架構清晰。

## ⚡ Read/Write Batching 操作原子性原則 (R/W Atomicity)
- **Read 階段（讀取與預檢）**：讀取檔案、查詢資料庫、`channel_list_unread`、`agent_status` 等所有稽核與檢視操作，必須集中在同一個 Turn 一次性完成。嚴禁在 Write 階段執行途中穿插任何讀取。
- **Write 階段（修改與提交）**：修改程式碼、執行測試、執行 Git 提交、以及 `channel_claim`/`channel_ack` 等所有會變更外部狀態的操作，必須集中在同一個 Write batch 一次性完成。
- **Write 內部驗證閉環（例外）**：Write 途中允許讀取「本次修改產生的 artifacts」——test log、stderr 輸出、git diff、剛寫入的檔案內容。此類讀取屬於驗證閉環，不算打破原子性。嚴禁讀取 `channel_list_unread`、`agent_status` 或與本次修改無關的任意檔案。
- **轉換卡控**：從 Read 進入 Write 前，必須確認 `unread = 0`。一旦進入 Write，Commit 或證據交付完成前禁止接新任務。
- **目的**：確保 AI 代理人讀寫具有時間局域性與原子性，防範讀寫交錯造成的狀態競態衝突與 Token 浪費。

## 📜 SDD 規格驅動開發至高天條 (Spec-First Rule)
- **原則**：在向任何 AI 代理人（特別是 `pic-PG`）發送程式碼修改請求前，**SA 必須先在物理規格書（L1 Requirements 或 L2 SDD-Spec/db-schema.md）中完成規格的異動與 Commit 提交**。
- **約束**：嚴禁僅憑口頭或 Channel 訊息直接指派代碼修改。`pic-PG` 只認物理 SPEC 開工。SA 必須嚴格把關規格變更，始終維護 SDD 單一真實來源 (SSoT)。
- **Git 破壞防禦線**：SA 進行規格修正或版本退回時，**絕對禁止執行 `git reset --hard` 或是任何波及 `src/` 或 `tests/` 範圍的毀滅性 git 操作**（以防誤殺 PG 工作區尚未 commit 的實體代碼）。若需退回，僅限使用精確的單一檔案還原（如 `git restore specs/`）。


