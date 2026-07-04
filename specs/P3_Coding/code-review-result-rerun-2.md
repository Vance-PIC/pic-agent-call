# Code Review Result Rerun 2 - src/bin vs specs/P2_Design

審查日期：2026-07-01

審查範圍：

- `src/db.mjs`
- `src/status.mjs`
- `src/channel.mjs`
- `src/tasks.mjs`
- `src/memory.mjs`
- `bin/server.mjs`

對照規格：`specs/P2_Design` 最新版本，尤其 `SDD-Spec.md` v1.2.2、`api-spec.md`、`db-schema.md`。

## 結論

這一輪 PG 的實作已明顯跟上 SA 新規格：

- `channel_send` MCP schema 已移除 `sender`，改用 `target` 解析 active 主角色。
- `registerAgent` 已改為 async，target 在 library 層卡控，transaction 包進 `withRetry`。
- timeout 已移入 `registerAgent` transaction 原子寫入。
- forced/非 forced 都先釋放 active 鎖，符合新規格方向。
- `_handleOrphanedMessages` 已拆成 internal + public wrapper，避免 nested transaction。
- `idx_agents_term_active` 已移除 `term_key != ''` 豁免，並強制 DROP+CREATE 確保舊 DB 生效（commit `e454987`）。

但仍有幾個需要修正的規格落差與測試穩定性問題。

## Findings

### High 1. DB migration 仍把 NULL `term_key` 遷移成空字串，與新規格衝突

位置：`src/db.mjs:184`、`src/db.mjs:185`

目前程式：

```sql
UPDATE agents SET term_key = '' WHERE term_key IS NULL
```

但最新 `db-schema.md` 自動遷移規格要求：

- `agents.term_key` 保證為 `NOT NULL`
- 若舊資料為 null，應自動遷移更新為當前 `PIC_TERM_KEY` 預設值
- 新版設計也明確禁止空 `term_key` 作為有效視窗身份

影響：

舊 DB 若有 `NULL term_key`，初始化後會變成 `''`。這會留下不合法視窗身份；若舊資料中有多筆 `status='active' AND term_key IS NULL`，轉成空字串後建立 `idx_agents_term_active` 甚至可能直接失敗。

建議：

用可追溯的非空 fallback，例如：

- 優先 `process.env.PIC_TERM_KEY`
- 再退 `process.env.WT_SESSION`
- 再退 deterministic legacy key，例如 `legacy-${session_id}` 或 `legacy-${agent_id}`

並在建立 unique index 前處理多筆 active 衝突。

### High 2. `_resolveRegsByTarget` 多態解析存在 flat-namespace 命名空間衝突風險

位置：`src/channel.mjs:14`

解析優先序為 `agent_id` → `term_key` → `session_id`。Windows Terminal GUID（如 `{xxxx-xxxx-...}`）作為 term_key 傳入時，會先嘗試 `WHERE agent_id IN (?)` 查詢，找不到才 fallthrough 到 term_key。若使用者恰好把某個 agent 命名為一個 GUID 字串，`channel_send` 和 `channel_list_unread` 的 target 解析會靜默選中 agent，而非終端視窗身份，造成多租戶隔離錯誤。

影響：

不一定會發生（agent_id 命名慣例通常為 `CC-XXX`/`AGY-XXX`），但在邊界案例下會靜默誤解 target 指向，違反多視窗隔離目標。

建議：

在 spec 中加入 agent_id 命名慣例限制（禁止 GUID 形式），或加入格式偵測（GUID `{...}` 直接走 term_key 路徑，跳過 agent_id 比對）。

### Medium 1. `agents.term_key` DDL 仍有 `DEFAULT ''`

位置：`src/db.mjs:144`、`src/tasks.mjs:16`

`db-schema.md` 定義為：

```sql
term_key TEXT NOT NULL
```

目前正式 DB 與測試 helper 都是：

```sql
term_key TEXT NOT NULL DEFAULT ''
```

影響：

雖然 `registerAgent()` 已拒絕空 target，但 DB 層仍允許其他 direct insert 在未提供 term_key 時落成空字串。這和「library 已卡控 `term_key` 不能為空，索引不豁免空值」的設計意圖不一致。

建議：

移除 default 空字串。測試資料也應明確提供 term_key。

### Medium 2. `api-spec.md` 要求 `_handleOrphanedMessages` export，但實作未 export

位置：`src/status.mjs:106`

最新 `api-spec.md` 寫：

```js
export function _handleOrphanedMessages(...): number
```

目前實作是：

```js
function _handleOrphanedMessages(...)
```

只有 `handleOrphanedMessages()` 被 export。

影響：

若 spec 要求測試或其他模組直接引用 internal transaction helper，現在無法 import。若不希望 external 使用 internal helper，應修 spec，把 `_handleOrphanedMessages` 標成 non-export internal helper。

建議：

二選一：

- 照 spec 加 `export function _handleOrphanedMessages(...)`
- 或更新 spec，只保留 public `handleOrphanedMessages()`

### Medium 3. `cleanExpiredAgentSessionCache` 規格仍列為 export，但實作不存在

位置：`specs/P2_Design/api-spec.md` 對照 `src/status.mjs`

`api-spec.md` 仍要求：

```js
export function cleanExpiredAgentSessionCache(db, sessionDir): void
```

目前 `src/status.mjs` 沒有該 export。

影響：

這是 API surface mismatch。即使該功能已廢棄，規格說「保留 export 供測試相容，實作體可為 no-op」，因此目前仍不符合 spec。

建議：

新增 no-op export：

```js
export function cleanExpiredAgentSessionCache(db, sessionDir) {}
```

### Medium 4. 多個寫入路徑仍未使用 `withRetry`

位置：

- `src/channel.mjs:90` 的超時釋放 UPDATE
- `src/channel.mjs:170` `claimMessage()` transaction
- `src/channel.mjs:220` `ackMessage()` transaction
- `src/tasks.mjs:56` `listPendingTasks()` 超時釋放 UPDATE
- `src/tasks.mjs:75` `claimTask()` transaction
- `src/status.mjs:344` `unregisterAgent()` UPDATE（無 transaction 包覆，partial unregister 風險）
- `src/status.mjs:443` `getAgentStatus()` timeout/purge UPDATE/DELETE
- `src/status.mjs:536` `heartbeat()` UPDATE/DELETE

P2 Design §6 要求所有 INSERT/UPDATE/DELETE 與 transaction block 都包在 `withRetry`。

影響：

在多視窗狀態列輪詢與註冊/通道並行時，這些路徑仍可能遇到 `SQLITE_BUSY` 後直接失敗或吞掉錯誤。`unregisterAgent` 特別值得注意：多步驟 SELECT+UPDATE 無 transaction，crash 視窗中可能部分離線。

建議：

至少先補高頻/高風險路徑：`claimMessage`、`ackMessage`、`claimTask`、`unregisterAgent`。狀態列背景寫入可維持 fire-and-forget，但內部仍應用 `withRetry` 或明確降級策略。

### Medium 5. `listUnread` receiver=null 時對無效 target 靜默回傳空陣列而非 403

位置：`src/channel.mjs:88`

`receiver` 為 null 或 `'all'` 且 `_resolveRegsByTarget` 回傳空陣列時，函式靜默回傳 `{ messages: [], count: 0 }`。僅當 `receiver` 為具體值時才拋 403。

影響：

caller 帶無效 target 仍可輪詢 `channel_list_unread`（receiver=null），收到空結果而非錯誤，洩漏「沒有訊息」的資訊，且與 receiver 有值時的 403 行為不一致。

建議：

當 `_resolveRegsByTarget` 回傳空陣列時，不論 receiver 是否指定，一律拋出 403。

### Medium 6. 測試全部通過但 `npm test` exit code 為 1

位置：`src/db.mjs:209`、`src/db.mjs:219`

執行結果：

- `Test Suites: 7 passed, 7 total`
- `Tests: 136 passed, 136 total`
- 但 process exit code = 1

原因是 debounced `syncDbToJson()` timer 在測試結束後才觸發，DB 已被關閉，因此 `_doSyncDbToJson()` 嘗試 `db.prepare()` 時拋出 `ERR_INVALID_STATE`，又在 Jest 結束後 `console.error`，造成 `Cannot log after tests are done`。

影響：

CI 會判定失敗，即使所有 assertion 都通過。這也代表 runtime shutdown 時可能出現已關閉 DB 的 delayed sync error。

建議：

提供測試/關閉用的 flush/cancel API，例如：

- `flushDbJsonSync(jsonPath?)`
- `cancelDbJsonSync(jsonPath?)`
- 或在 `syncDbToJson` timer callback 中偵測 DB closed 時安靜跳過，不在測試結束後 log

### Low 1. `bin/server.mjs` 直接使用 `channel._resolveRegsByTarget` 底線命名的 internal helper

位置：`bin/server.mjs:190`、`src/channel.mjs:14`

目前 `_resolveRegsByTarget` 已 export，功能上可用。但底線命名表示 internal helper，server 直接依賴它會讓 API 邊界不清楚。

建議：

若這是正式 server handler 需要的能力，改名成 public helper，例如 `resolveRegistrationsByTarget()`，並加入 API spec。

### Low 2. `agent_status` server handler `??` fallback 為 dead code

位置：`bin/server.mjs:290`

```js
return textJson(status ?? { registered: false, session_id: null, message: '...' });
```

`getAgentStatus` 在 v1.2.2 已不回傳 `null`/`undefined`（target 無效時回傳 `{ registered: false, ... }`），`??` 後的 fallback 永遠不會執行。

建議：移除 fallback object，改為：

```js
return textJson(status);
```

## 已修正項目（本輪 P3 完成）

| 項目 | commit |
|------|--------|
| `channel_send` 移除 `sender`，加 `target` 防偽造 | f38c867 |
| `registerAgent` async + `withRetry` + transaction | f38c867 |
| `registerAgent` library 層拒絕空 target | f38c867 |
| timeout 移入 `registerAgent` transaction | f38c867 |
| forced/非 forced 均先釋放 active lock | f38c867 |
| `handleOrphanedMessages` public wrapper 自帶 transaction + retry | f38c867 |
| `idx_agents_term_active` 移除空 term_key 豁免 + DROP+CREATE 確保舊 DB 生效 | e454987 |
| `getAgentStatus` top-level `freshness` 欄位，移除 unused `isSessionFresh` | af73235 |

## 測試狀態

```
Test Suites: 7 passed, 7 total
Tests:       136 passed, 136 total
Exit code: 1（debounced JSON sync timer 在 DB 關閉後觸發，見 Medium 6）
```
