# Code Review Result Rerun 3 - src/bin vs specs/P2_Design

審查日期：2026-07-02

審查範圍：

- `src/db.mjs`
- `src/status.mjs`
- `src/channel.mjs`
- `src/tasks.mjs`
- `src/memory.mjs`
- `bin/server.mjs`

對照規格：`specs/P2_Design` 最新版本，包含 SA 新增的 v1.2.2 裁定：invalid target 一律 403、舊 `term_key` fallback、agent_id 禁 GUID、createTask TOCTOU、high-risk withRetry 補全。

## 結論

這一輪整體狀態比前次好很多。前次指出的主要項目大多已修正：

- `channel_send` MCP 層已移除 `sender`，改用 `target` 解析 active 主角色。
- `registerAgent` 已 async + `withRetry` + transaction。
- `registerAgent` library 層已拒絕空 `target`。
- `timeout` 已納入 `registerAgent` transaction。
- `idx_agents_term_active` 已改成無空值豁免。
- `handleOrphanedMessages` 已拆成 internal helper + public transaction wrapper。
- `cleanExpiredAgentSessionCache` 已補 no-op export。
- `createTask` duplicate hash 檢查已移入 `BEGIN IMMEDIATE` transaction。
- `claimMessage`、`ackMessage`、`claimTask`、`unregisterAgent` 已補 `withRetry`。
- `listUnread` invalid target 已改為一律 403。
- `npm test -- --runInBand` 已乾淨通過，exit code 為 0。

目前仍有幾個規格/實作落差，主要集中在舊 DB schema 遷移的強約束、agent_id GUID 禁用、以及部分測試未 await async API。

## Findings

### High 1. 舊 DB 的 `agents.term_key` 欄位若原本 nullable，migration 沒有重建表來強制 `NOT NULL`

位置：`src/db.mjs:169`、`src/db.mjs:186`

新建 DB 的 DDL 已是：

```sql
term_key TEXT NOT NULL
```

但對舊 DB，migration 仍是：

```sql
ALTER TABLE agents ADD COLUMN term_key TEXT
```

後續雖然會把 `NULL` 或空字串資料更新成 `legacy-${agent_id}` 並標成 offline，但欄位本身在舊表 schema 中仍然是 nullable，沒有真正達成 `db-schema.md` 和 SDD §6.12 的「term_key TEXT NOT NULL」結構約束。

影響：

舊 DB 經 migration 後，仍可能被 direct SQL 寫入 `term_key = NULL`。這不會被 DB constraint 擋下，只能靠應用層避免。若 spec 要求 DB 層強制，這仍不符合。

建議：

若要嚴格符合 schema，需要針對舊 agents table 做 rebuild migration：建立新表、複製清洗後資料、drop 舊表、rename 新表、重建 index。若決定不 rebuild，spec 需要明確改成「資料清理保證，不保證舊表物理 NOT NULL constraint」。

### High 2. `agent_id` 禁止 GUID 格式的裁定尚未實作

位置：`src/status.mjs:161`、`src/status.mjs:182`

SDD §6.12.4.2 新增：

> `agent_id` 明確禁止使用標準 GUID 格式。

目前 `_parseAgentIds()` 只做分隔與平台前綴補全，`registerAgent()` 沒有拒絕 GUID 格式 agent_id。若傳入 `550e8400-e29b-41d4-a716-446655440000` 這類值，程式會視環境自動補成 `AGY-550e...` 或在已有前綴時直接寫入。

影響：

規格新增這條是為了避免和 `term_key` / `session_id` 的 flat-namespace 多態解析衝突。未實作會讓 `target` 解析優先序在特殊命名下產生歧義。

建議：

在 `_parseAgentIds()` 或 `registerAgent()` 中加入 GUID regex 檢查。需同時檢查原始 token 與移除 `CC-` / `AGY-` 前綴後的 token。

### Medium 1. `registerAgent` 的 conflict pre-check 仍在 transaction 外，可能和 library 內狀態不一致

位置：`bin/server.mjs:243`、`bin/server.mjs:246`

server handler 仍保留單角色 conflict pre-check：

```js
const conflict = findAgentIdConflict(db, agent_id, sessionId);
if (conflict && !force) return textJson({ conflict: true, ... });
```

真正的 `registerAgent()` 內部也會在 transaction 中做 conflict 檢查。這個外層 pre-check 不是原子操作，且沒有 `withRetry`。

影響：

這不是安全漏洞，因為 library 內還會檢查；但 server 可能在 race condition 下回傳過期 conflict 提示，或與 library 的多角色/三道防線判定不完全一致。

建議：

考慮移除 server handler 的 pre-check，統一由 `registerAgent()` 回傳 conflict 結果。若保留，只應視為提示，不應作為權威判定。

### Medium 2. `status.test.mjs` 仍有 async `registerAgent()` 未 await 的測試碼，可能形成假陽性

位置：`tests/status.test.mjs:711` 附近

`registerAgent()` 已改為 async，但部分 O1/O2 測試仍直接呼叫：

```js
registerAgent(db, 'sess-old', ...)
registerAgent(db, 'sess-new', ...)
```

未 await 的 async function 會立即回傳 Promise，測試可能在 DB transaction 尚未完成時就往下跑。這次完整測試通過，但這類測試存在非決定性風險，也可能漏抓 rejection。

影響：

CI 目前是綠的，但測試對 async register 行為的覆蓋不可靠。

建議：

將相關 test 改成 `async () =>` 並 `await registerAgent(...)`。

### Medium 3. `listPendingTasks()` 的 timeout release UPDATE 仍未使用 `withRetry`

位置：`src/tasks.mjs:64`

SDD §6 仍是全寫入/交易都要 `withRetry`。本 sprint 明確列出的 high-risk 補全範圍已包含 `claimTask`，但 `listPendingTasks()` 裡的自動釋放 claimed task 仍是直接 UPDATE。

影響：

這不是目前 SA 明確列出的 high-risk 必修項，但仍是寫入路徑。高併發或 DB busy 時可能直接 throw。

建議：

若要完全符合 §6，將這段 UPDATE 包進 `withRetry`，或把 `listPendingTasks` 改 async 並更新 handler/tests。

### Low 1. `getAgentStatus()` timeout/purge 和 heartbeat 背景 UPDATE 仍沒有 `withRetry`

位置：`src/status.mjs:455`、`src/status.mjs:473`、`src/status.mjs:548`

這些仍是寫入路徑，但目前有 try/catch 或 fire-and-forget 降級。規格 §6 的文字是全寫入都要 `withRetry`；§6.12.7 允許 heartbeat 用非同步背景 fire-and-forget，但仍提到需要重試或非阻塞保護。

影響：

狀態列高頻路徑可能在 DB busy 時漏更新心跳或超時清理，但通常不會阻塞主流程。

建議：

可接受作為低風險技術債；若要嚴格符合，背景 update 內也應呼叫 `withRetry`，並避免未處理 Promise。

### Low 2. `channel._resolveRegsByTarget` 是正式依賴但仍使用 internal 命名

位置：`src/channel.mjs:14`、`bin/server.mjs:190`

server 的 `channel_send` 正式依賴 `_resolveRegsByTarget()`。底線命名表示 internal helper，但它已成為跨模組 API。

影響：

不影響功能，但 API 邊界不清楚。

建議：

改名為 `resolveRegsByTarget` 或 `resolveRegistrationsByTarget`，並補進 api-spec。

## 已驗證改善

- `src/db.mjs`：新建 agents table 已移除 `DEFAULT ''`。
- `src/db.mjs`：NULL/空 `term_key` 舊資料已 fallback 成 `legacy-${agent_id}` 並設為 offline。
- `src/db.mjs`：`idx_agents_term_active` 會先 drop 再 create，避免舊 predicate 留存。
- `src/db.mjs`：新增 `cancelDbJsonSync()` 並對 DB closed 的 delayed sync 靜默處理。
- `src/status.mjs`：`cleanExpiredAgentSessionCache()` no-op export 已補上。
- `src/channel.mjs`：`listUnread` invalid target 無論 receiver 是否指定都會 403。
- `src/tasks.mjs`：`createTask` duplicate hash check 已進 transaction。
- `bin/server.mjs`：async `channel` / `task` handler 已補 await。

## 測試結果

已執行：

```bash
npm test -- --runInBand
```

結果：

- Test Suites: 7 passed, 7 total
- Tests: 136 passed, 136 total
- Exit code: 0
