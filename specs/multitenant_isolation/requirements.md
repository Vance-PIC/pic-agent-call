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

### 2.4 訊息未讀查詢優化 (`channel_list_unread`)
- **功能**：列出當前視窗或指定角色的未讀訊息聯集。
- **輸入參數**：
  - `target` (string, **Required**): 定位識別碼。移除背景 `resolveSessionId` 推導，強制要求傳入定位標的。
  - `receiver` (string, Optional): 原本的 receiver 參數，可傳入特定角色。
- **多態與安全規則**：
  - 內部使用多態解析 `target` 取得活躍角色名單。
  - 若指定了 `receiver`，則必須確認該 `receiver` 存在於該名單中，否則拋出 `403 Forbidden` 拒絕存取，確保跨視窗的信箱隔離安全。

### 2.5 安全驗證去 Session 直查 (`channel` / `tasks` 模組)
- **範圍**：適用於 `channel_send` (發送者驗證)、`channel_claim` (領取驗證)、`channel_ack` (確認驗證) 與 `claim_task` 等 API。
- **需求**：移除對 `resolveSessionId()` 隱式名單的依賴，直接拿傳入的角色 ID (如 `sender` 或 `agent_id`) 於資料庫直查其活躍狀態（`active` / `attached`），只要為活躍狀態即通過驗證，徹底防堵 Session 碰撞誤阻。

---

## 3. 受影響之 API 範圍與需求變更清單 (11 個 API)

### 3.1 狀態管理模組 (Status Module - 3 個 API)
1. **`register_agent`**：
   - 參數 `wt_session` 重命名為 `target` (Required，必填)。
   - Forced 清理邏輯：同時以 `session_id` 與 `term_key = target` 進行同視窗舊角色清理。
2. **`unregister_agent`** (新增)：
   - 參數為 `target` (Required，必填)。
   - 實作多態定位註銷（按角色/視窗/會話），將狀態設為 `'offline'`。
3. **`agent_status`**：
   - 參數 `target` 改為 **Required (必填)**。
   - 實作多態查詢，移除所有背景 fallback/自動推導，僅由傳入的 `target` 唯一識別。

### 3.2 協作通道模組 (Channel Module - 4 個 API)
4. **`channel_list_unread`**：
   - 參數增加 `target` (Required，必填)。
   - 以 `target` 執行多態解析獲取活躍角色，進行未讀訊息撈取。指定 `receiver` 時進行安全卡控，不合則拋 `403`。
5. **`channel_send`**：
   - 安全驗證直查化（去 Session）：直接以 `sender` (角色 ID) 查詢 DB 活躍狀態。移除 `sessionId` 參數的傳遞與依賴。
6. **`channel_claim`**：
   - 安全驗證直查化：直接以操作者 `agent_id` 查詢 DB 活躍狀態。移除 `sessionId` 參數。
7. **`channel_ack`**：
   - 安全驗證直查化：直接以操作者 `agent_id` 查詢 DB 活躍狀態。移除 `sessionId` 參數。

### 3.3 任務管理模組 (Tasks Module - 4 個 API)
8. **`create_task`**：
   - 移除 `sessionId` 參數傳遞，改為無狀態的任務創建。
9. **`claim_task`**：
   - 安全驗證直查化：直接以領取者 `agent_id` (executorId) 查詢 DB 活躍狀態。移除 `sessionId` 參數。
10. **`complete_task`**：
    - 移除 `sessionId` 參數傳遞，安全判定完全去 Session 化。
11. **`fail_task`**：
    - 移除 `sessionId` 參數傳遞，安全判定完全去 Session 化。

---

## 4. 驗收條件 (Definition of Done)
- **規格服從**：`register_agent`、`unregister_agent`、`agent_status` 必須大一統使用 `target` 參數。
- **多視窗隔離**：在 VS Code 中開啟兩個不同的 Terminal 視窗，註冊不同角色後，兩邊狀態列能精確、獨立顯示各自角色，不再發生互搶覆蓋。
- **測試覆蓋**：更新 `tests/` 以適應 `target` 必填參數，執行 `npm run test` 所有測試 100% 通過。
