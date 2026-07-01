# Requirements — 多態識別大一統與多視窗隔離優化 (v1.2.2)

## 1. 背景與痛點 (Problem Statement)
目前 `pic-agent-call` 的身份管理（Agent Registration）存在以下設計缺陷：
- **Session 誤判碰撞**：MCP 伺服器為全域單例，無終端環境變數時會 fallback 掃描最新 mtime 的 Brain 目錄，導致多個不同視窗被識別為同一個 `session_id`。
- **視窗互搶角色**：由於 Session ID 被誤判碰撞，當視窗 B 強制（`forced`）註冊角色時，資料庫的舊角色清理 SQL 會因只過濾 `session_id` 而將視窗 A 的活躍角色誤踢為 `offline`，導致狀態列被覆蓋。
- **API 參數命名混淆**：原本用於識別視窗的參數叫 `wt_session`，這與 `WT_SESSION` 綁定且是選填，容易在其他終端環境下產生漏填或誤解。
- **缺少註銷 API**：目前缺乏主動註銷（解除註冊）角色的機制，無法完成身份管理的 CRUD（增刪改查）閉環。

---

## 2. 需求範圍 (Scope of Requirements)

### 2.1 新增角色註銷工具 (`unregister_agent`)
- **功能**：允許 AI 代理人主動登出/註銷當前視窗或特定的角色。
- **輸入參數**：
  - `target` (string, **Required**): 定位識別碼。
- **多態識別規則**：
  - 若 `target` 命中 `agent_id`：註銷該特定角色（狀態設為 `offline`）。
  - 若 `target` 命中 `term_key`：註銷該 Terminal 視窗下的所有角色。
  - 若 `target` 命中 `session_id`：註銷該對話會話下的所有角色。

### 2.2 大一統多態查詢工具 (`agent_status`)
- **功能**：查詢當前視窗、會話或特定角色的活躍狀態與未讀數。
- **輸入參數**：
  - `target` (string, **Required**): 定位識別碼。移除所有背景自動推導與 fallback 掃描邏輯，強制呼叫端必須明確指定查詢目標。

### 2.3 優化註冊工具 (`register_agent`)
- **參數調整**：原本選填的 `wt_session` 參數重命名為 `target` (string, **Required**)，強制呼叫端在註冊時必須傳入其視窗 UUID。
- **隔離接管卡控**：在 forced 接管時，清理同 session 殘留角色的 SQL 必須同時過濾 `session_id` 與 `term_key`，避免跨視窗誤踢他人角色。

### 2.4 安全驗證去 Session 化 (Decouple Session for Security Gate)
- 在 `channel_send`、`channel_claim`、`channel_ack` 與 `claim_task` 等安全檢查中，改為直接依據 `agent_id` (或 `sender`) 於資料庫直查其是否為活躍角色（`active` / `attached`），不再透過 `resolveSessionId()` 獲取名單比對，防止因 Session 誤判碰撞而誤拒合法操作。

---

## 3. 驗收條件 (Definition of Done)
- **規格服從**：`register_agent`、`unregister_agent`、`agent_status` 必須大一統使用 `target` 參數。
- **多視窗隔離**：在 VS Code 中開啟兩個不同的 Terminal 視窗，註冊不同角色後，兩邊狀態列能精確、獨立顯示各自角色，不再發生互搶覆蓋。
- **測試覆蓋**：更新 `tests/` 以適應 `target` 必填參數，執行 `npm run test` 所有測試 100% 通過。
