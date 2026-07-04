# Code Review Result Rerun - src vs specs/P2_Design

審查範圍：`C:\PIC\AI-tools\claude-marketplace\pic-agent-call\src`

複審重點：檢查前次 review 指出的高風險項目是否已修正，並重新對照 `specs\P2_Design` 的 API、DB schema、Channel、Task、Status 規格。

## 複審結論

本次修正已處理多個前次問題：

- `channel.listUnread` 已補上 target 解析不到角色時的 403 阻擋。
- `tasks.createTask` / `completeTask` payload/result 限制已改為 65536 bytes。
- `tasks.claimTask` 已補上 agent 必須為 active/attached 的 DB 驗證。
- `memory.addObservation` 已補上 entityName 與 observationText 長度檢查。
- `getAgentStatus` freshness 已不再直接回傳 null，改為以黃色 stale 狀態顯示。
- `tasks.initAgentsTable` 已更新為三態與基本欄位，雖然仍標註僅供測試隔離。

但仍有幾個規格不符與安全/一致性風險，主要仍集中在 `registerAgent`、`term_key` schema、transaction retry 與 MCP handler 的 sender 參數。

## 仍需修正的問題

### High 1. MCP `channel_send` 仍暴露 `sender` 參數，違反「工具層移除 sender 防偽造」規格

位置：`bin/server.mjs:180`

目前 MCP schema：

```js
{ sender: z.string(), receiver: z.string(), message: z.string(), ... }
```

P2 Design 在 SDD §6.4 明確要求 MCP 工具層移除 sender 參數，以防使用者偽造任意 sender；handler 應由當前已註冊身份推導 sender，再傳給 `channel.sendMessage()`。

影響：

雖然 `src/channel.mjs` 會檢查 sender 是否 active/attached，但 MCP caller 仍可指定任何已註冊且活躍的 agent_id 作為 sender，造成身份偽造風險。

建議：

- `channel_send` schema 移除 `sender`。
- 新增必填 `target` 或使用目前視窗定位資訊解析 active 主角色。
- handler 由 DB 查出的 active agent_id 作為 sender。

### High 2. `registerAgent` 仍未在 library 層強制 target 必填，且仍允許空 term_key

位置：`src/status.mjs:180`、`src/status.mjs:186`、`src/db.mjs:144`

server handler 在 `bin/server.mjs:230` 有擋空 target，但 `src/status.mjs` 的 `registerAgent()` 本身仍預設 `target = ''`，並將空值寫成 `resolvedTermKey = ''`。DB schema 也仍是：

```sql
term_key TEXT NOT NULL DEFAULT ''
```

P2 v1.2.2 要求 `target` 必填，且由 `$env:PIC_TERM_KEY` 提供。規格核心是用 term_key 做視窗隔離，不應允許空字串作為有效定位鍵。

影響：

任何直接呼叫 library 的測試、內部程式或未來 handler 都仍能建立空 `term_key` agent。這會繞過視窗隔離模型。

建議：

`registerAgent()` 開頭直接檢查：

```js
if (!target || !target.trim()) return { success: false, reason: 'target_required' };
```

並避免 DB 層以空字串作為合法 fallback。舊資料需遷移或清理。

### High 3. `idx_agents_term_active` 仍豁免空 term_key，與 DB schema 規格不一致

位置：`src/db.mjs:187`

目前仍為：

```sql
CREATE UNIQUE INDEX IF NOT EXISTS idx_agents_term_active
ON agents(term_key) WHERE status = 'active' AND term_key != ''
```

規格要求：

```sql
CREATE UNIQUE INDEX idx_agents_term_active
ON agents(term_key) WHERE status = 'active'
```

影響：

只要 term_key 是空字串，DB 層仍允許多個 active agent。這與三態模型「同一 term_key 同時間只能有一個 active」不一致。

建議：

修掉空 target/空 term_key 後，移除 `AND term_key != ''`。若已有舊資料，先做 migration 清理 active 衝突。

### High 4. `registerAgent` 有 transaction，但沒有 `withRetry` 包裹

位置：`src/status.mjs:188`

目前已加上 `BEGIN IMMEDIATE` / `COMMIT`，這是進步；但 P2 Design §6 要求所有寫入/交易要包在 `withRetry` 指數退避重試裡。`registerAgent()` 目前未 import/use `withRetry`。

影響：

遇到 `SQLITE_BUSY` 或 `database is locked` 時，register 會直接 throw，而不是依規格 retry。狀態列、註冊、channel 並行時，這是實際會發生的路徑。

建議：

將整個 transaction 放入 `withRetry(() => { ... })`，或改為 async function 並 await retry。若維持 sync API，需要重新評估 `withRetry` async signature 與現有 callers。

### High 5. `registerAgent` 非 forced 流程仍沒有依規格先釋放 active 鎖

位置：`src/status.mjs:198`

目前註解明確說「非 forced 由 hasActiveInSession 控制，避免誤降其他角色」。但 P2 §6.12 要求在 register loop 前先將當前 session 下所有角色降級為 attached，以釋放 active unique index，避免重新登記與調整角色順序時撞 unique constraint。

影響：

同 session / 同 term_key 重新註冊並調整角色主從順序時，仍可能因舊 active 沒先釋放而造成 constraint error，或新輸入的第一角色沒有正確成為 active。

建議：

對當前 session 或當前 session + term_key 範圍，在註冊迴圈前先統一降級 active 為 attached，再依新名單順序將第一個設 active。

### Medium 1. `registerAgent` 的 timeout 不是 library API 實作，而是 server handler 額外補寫

位置：`src/status.mjs:180`、`bin/server.mjs:254`

API spec 中 `registerAgent(..., timeout?: number)` 是 `src/status.mjs` library 函式簽名的一部分。目前 `registerAgent()` 沒有 timeout 參數，timeout 寫入是在 MCP handler 成功後額外 UPDATE。

影響：

直接呼叫 library 的使用者無法取得 spec 定義的 timeout 行為。更重要的是，註冊與 timeout 更新不在同一個 transaction 裡，可能出現註冊成功但 timeout 更新失敗的部分成功狀態。

建議：

把 timeout 參數移入 `registerAgent()`，在同一個 transaction 中寫入 `agent_timeout_sec`。

### Medium 2. `handleOrphanedMessages` 現在假設一定由外層 transaction 包覆，直接呼叫時失去原子性

位置：`src/status.mjs:108`

前版此函式自己開 transaction；新版移除 nested transaction，註解寫「由 registerAgent 外層 transaction 包覆」。但它仍是 export function，API spec 也把它列為可呼叫函式。

影響：

若測試或其他模組直接呼叫 `handleOrphanedMessages()`，通知與 ORPHANED 標記不是 transaction，可能部分寫入。

建議：

拆成 internal `_handleOrphanedMessagesInTransaction()` 與 public wrapper；public wrapper 自己開 transaction，registerAgent 呼叫 internal 版本。

### Medium 3. `getAgentStatus` 有未使用變數與 freshness 設計仍不完整

位置：`src/status.mjs:475`

`isSessionFresh` 被設定但沒有被使用。單 agent stale 已會顯示 `🟡`，這比前版好，但 primary/session 層級是否 stale 未反映在 top-level result。

影響：

不影響核心安全，但會讓呼叫端無法透過 structured result 判斷整個 session freshness，只能 parse display 或看每個 registered_agents 的 freshness。

建議：

回傳 top-level `freshness: 'fresh' | 'stale'` 或移除未使用變數。

## 已修正項目確認

### Fixed 1. `channel.listUnread` target 空解析越權

位置：`src/channel.mjs:123`

已補上 `regs` 空陣列時直接 throw 403，前次高風險問題已修正。

### Fixed 2. Task payload/result 限制

位置：`src/tasks.mjs:31`、`src/tasks.mjs:109`

已由 1048576 改為 65536，符合 API spec。

### Fixed 3. `claimTask` agent 授權

位置：`src/tasks.mjs:81`

已在 transaction 中查詢 agents 表，確認 `status IN ('active','attached')`，符合 v1.2.2 去 session 化直查方向。

### Fixed 4. `getAgentStatus` freshness 不再直接回傳 null

位置：`src/status.mjs:473`

已改為 stale/yellow display，符合規格方向。

### Fixed 5. `memory.addObservation` validation

位置：`src/memory.mjs:3`

已補 `entityName` 1-100、`observationText` 1-2000 檢查。

## 建議優先順序

1. 先修 `channel_send` MCP schema 移除 sender，避免偽造 sender。
2. 在 `src/status.mjs registerAgent()` library 層強制 target 必填，禁止空 term_key。
3. 修正 DB unique index，移除 `term_key != ''` 豁免，並處理舊資料 migration。
4. 讓 `registerAgent` 使用 `withRetry`，並處理 async/sync API 設計。
5. 非 forced register 也要先釋放 active 鎖，符合三態模型。
6. 把 timeout 納入 `registerAgent()` transaction。
7. 將 orphan handler 拆成 public wrapper + transaction internal helper。

## 測試狀態

本次為靜態 code review，未執行 test suite。
