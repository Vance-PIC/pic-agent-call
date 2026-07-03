# Code Review Result - src vs specs/P2_Design

審查範圍：`C:\PIC\AI-tools\claude-marketplace\pic-agent-call\src`

對照規格：`specs\P2_Design`，主要參考：

- `api-spec.md`
- `SDD-Spec.md`
- `db-schema.md`
- `error-codes.md`

結論：目前 `src` 只算部分符合 P2 Design。Memory、Task、Channel、Status、DB 初始化的主要模組都有建立，部分 v1.2.2 去 Session 化與 v1.1.4 三態模型也有實作痕跡，但仍有多個高風險規格落差，尤其集中在 `term_key` 隔離、`registerAgent` 原子性、Channel 橫向越權防護、Task claim 授權，以及 API 限制值不一致。

## 高風險問題

### 1. `channel.listUnread` 在 target 無效時會放行指定 receiver 查詢

位置：`src/channel.mjs:123`

問題：

`listUnread(db, receiver, target)` 若傳入指定 `receiver`，理論上必須先用 `target` 解析出當前活躍角色，並確認該 `receiver` 屬於這批角色或 role mailbox。現在 `_resolveRegsByTarget()` 若回傳空陣列，授權檢查會被跳過，後續仍直接查詢該 `receiver` 的未讀訊息。

影響：

這違反 P2 Design 的橫向越權防護。攻擊者或錯誤 caller 可用不存在的 `target` 搭配任意 `receiver` 讀取他人信箱。

建議：

若 `target` 解析不到任何 active/attached registration，且指定了 `receiver`，應直接回傳或拋出 403，不可繼續查詢。

### 2. `registerAgent` 沒有強制 target 必填，term_key 可為空

位置：`src/status.mjs:182`、`src/db.mjs:144`

問題：

P2 v1.2.2 規格要求 `register_agent` 的 `target` 是必填參數，且應為目前終端視窗的 `PIC_TERM_KEY`。目前 `registerAgent` 的 `target` 預設為空字串，`resolvedTermKey` 也允許空字串。DB schema 也將 `term_key` 設為 `TEXT NOT NULL DEFAULT ''`。

影響：

空 `term_key` 會讓視窗隔離失效，造成多個角色或多個 session 落在同一個不明確的視窗身份下。這和 P2 Design 要用 `PIC_TERM_KEY` 作為多視窗安全定位鍵的核心設計不一致。

建議：

`registerAgent` 在 `target` 空值時應回傳 `{ success: false, reason: 'target is required' }`。DB migration 也應避免用空字串作為有效 term key，舊資料需有明確遷移策略。

### 3. `idx_agents_term_active` 對空 term_key 豁免，違反唯一 active 規格

位置：`src/db.mjs:185`

問題：

規格要求：

```sql
CREATE UNIQUE INDEX idx_agents_term_active ON agents(term_key) WHERE status = 'active'
```

目前實作為：

```sql
CREATE UNIQUE INDEX IF NOT EXISTS idx_agents_term_active ON agents(term_key) WHERE status = 'active' AND term_key != ''
```

影響：

只要 `term_key = ''`，同一空視窗身份下可以有多個 active agent。這會破壞 v1.1.4 三態模型中「同一 term_key 只能有一個 active 主角色」的 DB 層約束。

建議：

先修正 `target` 必填與舊資料遷移，再移除 `AND term_key != ''` 豁免條件，符合規格建立 partial unique index。

### 4. `registerAgent` 多步驟寫入沒有 transaction / withRetry 包裹

位置：`src/status.mjs:188` 起

問題：

`registerAgent` 會執行多個 UPDATE、DELETE、INSERT/UPSERT，但整體沒有 `BEGIN IMMEDIATE` / `COMMIT` transaction，也沒有 `withRetry` 包裹。

影響：

如果中途發生 constraint error、DB busy 或其他例外，可能留下半更新狀態，例如舊 session 已被 offline、新角色只註冊一半、active/attached 狀態不完整。這違反 SDD §6 的「全寫入 / 交易 withRetry 包裹」規格。

建議：

將整個 register flow 包進 `withRetry(() => { BEGIN IMMEDIATE ... COMMIT })`。所有早退路徑都要確保 rollback。

### 5. 非 forced 重新註冊時沒有先釋放 active 鎖

位置：`src/status.mjs:196`

問題：

目前只有 `forced` 時才將同 session 的 active 降級為 attached。P2 v1.1.4 規格要求 register loop 前必須先將目前 session 下所有角色降級為 `attached`，以釋放 active unique index，避免重新指定主角色時撞到唯一 active constraint。

影響：

同 session / 同 term_key 重新註冊並調整角色順序時，可能在設定新 active 前撞到舊 active，導致註冊失敗或狀態不一致。

建議：

在註冊迴圈前，不只 forced，所有 register 流程都應對當前 session 釋放 active 鎖，再依新輸入順序指定第一個為 active。

### 6. `claimTask` 未驗證 agent 是否 active/attached

位置：`src/tasks.mjs:72`

問題：

P2 v1.2.2 規格要求 `claim_task` 安全驗證直接用傳入的 `agent_id` 查 DB，確認其 status 為 `active` 或 `attached`。目前只檢查 `agent_id` 字串格式，未查 agents 表。

影響：

未註冊、offline 或任意字串 agent 都可以 claim task。這是任務協作安全漏洞。

建議：

`claimTask` 在進入 transaction 前或 transaction 內查詢：

```sql
SELECT 1 FROM agents WHERE agent_id = ? AND status IN ('active','attached')
```

查無資料時回傳 403 或 validation/security reason。

## 中風險問題

### 7. Task payload/result 大小限制與 API Spec 不一致

位置：`src/tasks.mjs:28`、`src/tasks.mjs:98`

問題：

API spec 寫明 `payload` 與 `result` 應為 `<= 65536 bytes`。目前實作使用 `1048576` bytes，也就是 1 MiB。

影響：

會接受超出規格 16 倍的 payload/result，可能造成 MCP response、DB 儲存、任務傳遞成本失控。

建議：

改為 `65536`，並確認測試覆蓋 65536 邊界與 65537 拒絕。

### 8. `getAgentStatus` freshness 過期時回傳 null，不符合黃燈規格

位置：`src/status.mjs:462`

問題：

P2 規格說 `statusLineFreshnessMin` 是狀態列新鮮度判定，超過門檻時應顯示黃燈，不改變 DB 存活狀態。現在 active role 的 `last_seen` 超過 freshnessSec 時直接 `return null`。

影響：

狀態列可能把已註冊但不新鮮的角色當作無狀態/無資料處理，而不是顯示 stale 狀態。

建議：

保留 registered response，display 中使用黃燈標示，例如 `🟡0·AGY-SA`，不要回傳 null。

### 9. `claimMessage` 允許 attached agent claim，與三態模型文字衝突

位置：`src/channel.mjs:165`

問題：

`_isActiveAgent()` 接受 `active` 與 `attached`，因此 attached agent 也可 claim/ack。v1.1.4 三態模型描述中，`active` 才有詳細讀信與 Claim/Ack 特權，`attached` 僅限讀取未讀數。

影響：

若三態模型為最終規格，attached agent 可越權 claim message。若 v1.2.2「active/attached 直查放行」才是最終規格，則 P2 文件內部有衝突，需要先統一規格。

建議：

先釐清最終設計。若採三態模型，`claimMessage` / `ackMessage` 應只允許 `status = 'active'`。

### 10. `addObservation` 未實作 API Spec 長度限制

位置：`src/memory.mjs:3`

問題：

API spec 規定：

- `entityName`: 1 到 100 字元
- `observationText`: 1 到 2000 字元

目前 `addObservation` 未檢查空值或長度。

影響：

不合法資料可寫入 memory graph，可能造成查詢、JSON snapshot 或 UI 顯示問題。

建議：

在 function 開頭加入 validation，不合法時依錯誤處理原則回傳或 throw 明確錯誤。若 library 層希望一致，建議回傳 `{ success: false, reason: 'validation_error' }` 或由 server 層統一轉換。

## 其他觀察

### `tasks.initAgentsTable` schema 已落後

位置：`src/tasks.mjs:7`

`initAgentsTable` 建出的 agents table 仍只允許 `active/offline`，`agent_timeout_sec` 預設也是 120，且缺少 session_id / role 等欄位。雖然註解說外部不需直接呼叫、主要保留給測試隔離，但它與 P2 schema 已明顯不一致，會讓測試或外部誤用建立錯誤 schema。

### `db.mjs` migration 沒有真正移除 `is_primary` 欄位

位置：`src/db.mjs:180`

目前只 drop `idx_agents_session_primary`，但 SQLite 舊表若已有 `is_primary` 欄位，並未 rebuild table 移除欄位。P2 自動遷移清單寫「刪除 `is_primary` 欄位」。若需要嚴格符合 schema，必須處理 table rebuild；若接受保留舊欄位，規格需要修正為「不再使用」。

## 符合或大致符合的部分

- `src/db.mjs` 已有 WAL、foreign_keys、busy_timeout。
- `resolveMemoryPaths()` 已從 cwd 向上找 `.git` 或 `package.json`，符合防 DB 分裂方向。
- `syncDbToJson()` 已有 600ms debounce，使用 async write/rename，且有 `console.error`。
- `channel.sendMessage()` 對非 SYSTEM sender 有查 DB active/attached 狀態。
- `channel.sendMessage(receiver='all')` 已把 SELECT 與 INSERT 放在同一 transaction。
- `completeTask()` / `failTask()` 已使用 `BEGIN IMMEDIATE` 並檢查 changes，方向符合 TOCTOU 防護。
- Memory 大部分寫入操作有 `withRetry` + transaction。

## 建議修正優先順序

1. 修正 Channel `listUnread` 的 target 空解析越權問題。
2. 強制 `registerAgent target` 必填，禁止空 `term_key` 作為有效視窗身份。
3. 修正 `idx_agents_term_active`，移除空 term_key 豁免，並補舊資料遷移策略。
4. 將 `registerAgent` 整體包成 transaction + `withRetry`，並修正 active 鎖釋放流程。
5. `claimTask` 增加 active/attached DB 授權檢查。
6. 將 task payload/result 限制改為 65536 bytes。
7. 修正 `getAgentStatus` freshness 黃燈行為。
8. 釐清 attached agent 是否可 claim/ack，並統一 P2 Design 與程式行為。
9. 補 Memory validation 與相關單元測試。
10. 更新 `initAgentsTable` 或限制它只供舊測試使用，避免建立落後 schema。
