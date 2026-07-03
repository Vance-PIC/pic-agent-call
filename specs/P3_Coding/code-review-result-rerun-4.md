# Code Review Result - rerun 4

Review date: 2026-07-02
Scope: `src/`, `bin/server.mjs` 對照 `specs/P2_Design`
Reviewer: Codex

## 結論

本輪 rerun3 後，多數前次問題已修正：`listPendingTasks()` 已改為 async 並用 `withRetry + BEGIN IMMEDIATE` 包住 timeout release UPDATE；`bin/server.mjs` 也已 `await`；`channel_send` MCP schema 已移除 `sender`；`register_agent` 的 server-level `findAgentIdConflict` 預檢也已移除。

SA 裁定的 Low 1 心跳未包 `withRetry` 本輪接受為規格例外：SDD §6.12.4.4 已明確寫入「心跳背景更新（getAgentStatus）為低風險技術債豁免，不加 withRetry」，因此不再列為缺失。

仍有 2 個需要處理的規格落差，以及 1 個 L2 文件一致性問題。

## Findings

### Medium 1. `channel_send` 找不到 active 主角色時沒有拒絕，會 fallback 用 attached 角色送信

位置：
- `bin/server.mjs:188-194`
- `src/channel.mjs:20-23`
- 規格：`specs/P2_Design/SDD-Spec.md:155-158`

SDD §4 / 協作與任務 API 去 Session 化安全直查規格要求：`channel_send` 由 `target` 定位角色群後，必須「強制提取其中狀態為 `active` 的主角色作為 sender」，且「若無主角色則拒絕發送」。

目前 handler 實作是：

```js
const activeReg = regs.find(r => r.status === 'active') ?? regs[0];
const sender = activeReg.agent_id;
```

而 `resolveRegsByTarget()` 會回傳 `status IN ('active','attached')` 的角色。因此當 target 只解析到 attached 角色，或資料狀態異常導致沒有 active 主角色時，MCP 仍會使用第一個 attached 角色作為 sender 發送訊息。這和規格要求不一致，也弱化了「只有主角色可代表視窗送信」的防偽造邊界。

建議修正：
- `bin/server.mjs` 若 `regs.find(r => r.status === 'active')` 為空，直接回 `{ success:false, reason:'403: target 無 active 主角色，禁止發送' }` 或等價錯誤。
- 補一個測試：同一 target 只有 attached role 時，`channel_send` 不應送出訊息。

### Low 1. GUID agent_id 拒絕註冊的 reason 與 SDD 指定值不一致

位置：
- `src/status.mjs:197-200`
- 規格：`specs/P2_Design/SDD-Spec.md:279-281`

SDD §6.12.4.2 指定 GUID 格式的 `agent_id` 應回傳：

```js
{ success: false, reason: 'invalid_agent_id_format' }
```

目前程式回傳：

```js
{ success: false, reason: 'agent_id_format_invalid' }
```

這是 API contract 不一致。若呼叫端或測試依 SDD 的錯誤碼分流，會判斷不到此錯誤。

建議修正：將 `src/status.mjs:199` 改為 `invalid_agent_id_format`，並補測試鎖定此錯誤碼。

### Low 2. `api-spec.md` 仍保留舊版/重複簽名，與 SDD 和實作不一致

位置：
- `specs/P2_Design/api-spec.md:106-112`
- `specs/P2_Design/api-spec.md:167-170`
- `specs/P2_Design/api-spec.md:294-311`

`api-spec.md` 同時存在新舊兩段 `src/channel.mjs` 規格，後段仍寫 `sendMessage(db, receiver, message, sender, sessionId, priority?)`，與目前 SDD v1.2.2 去 Session 化描述及實作不一致。`listPendingTasks()` 也寫成 `Promise<Array<any>>`，但實作與 server 實際回 `{ tasks, count }`。

這不是 `src` runtime bug，但會讓後續 PG/QA 依 L2 規格開發或測試時產生歧義。建議 SA 同步清理 L2 文件，保留單一 v1.2.2 版本簽名。

## 已確認修正項

- `src/tasks.mjs:64-84`：`listPendingTasks()` timeout release UPDATE 已包 `withRetry + BEGIN IMMEDIATE`。
- `bin/server.mjs:134-138`：`list_pending_tasks` handler 已 `await tasks.listPendingTasks(...)`。
- `bin/server.mjs:178-195`：`channel_send` MCP schema 已移除 caller-supplied `sender`，改用 `target` 解析 sender。
- `src/channel.mjs:90-115`：`listUnread` 對無效 target 即使 receiver 為空也會丟 403。
- `src/db.mjs`：`agents.term_key` 新表 DDL 已為 `TEXT NOT NULL`，且舊表會 rebuild 以物理落實 NOT NULL。
- `src/status.mjs:190-350`：`registerAgent()` 已 async，交易包在 `withRetry`，且 target 必填、timeout 寫入同 transaction。
- `src/status.mjs:355-413`：`unregisterAgent()` 已包 `withRetry + BEGIN IMMEDIATE`。

## 測試結果

已執行：

```powershell
npm test -- --runInBand
```

結果：

```text
Test Suites: 7 passed, 7 total
Tests:       136 passed, 136 total
```

## 建議優先順序

1. 修 `channel_send` 無 active 主角色時 fallback attached 的問題。
2. 修 GUID agent_id 錯誤碼字串。
3. 清理 `api-spec.md` 的舊版重複簽名。
