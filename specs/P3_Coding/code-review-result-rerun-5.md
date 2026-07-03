# Code Review Result - rerun 5

Review date: 2026-07-02
Scope: `src/`, `bin/server.mjs`, `tests/` 對照 `specs/P2_Design`
Reviewer: Codex

## 結論

本輪 SA 調整 spec、PG 更新程式後，rerun4 的兩個主要實作問題已修正：

- `channel_send` 找不到 `active` 主角色時，現在會拒絕發送，不再 fallback 使用 `attached` 角色。
- GUID 格式 `agent_id` 的拒絕 reason 已改為 SDD 指定的 `invalid_agent_id_format`。

測試已全數通過。不過仍有 1 個程式交易邊界問題，以及 1 個 L2 文件一致性問題。

## Findings

### Medium 1. `ackMessage()` 的 active-agent 授權檢查仍在 transaction 外，未完全符合 I5 TOCTOU 防護

位置：
- `src/channel.mjs:241-247`
- 規格：`specs/P2_Design/SDD-Spec.md:263`

SDD §6.12 I5 要求 `claimMessage` 與 `ackMessage` 中的主角色解析與權限校驗必須包含在資料庫 transaction 內，或至少有 best-effort 讀寫一致性防護，避免讀取角色狀態到操作訊息之間發生越權或奪占。

目前 `claimMessage()` 已修正，active/attached 檢查在 `BEGIN IMMEDIATE` 後執行：

```js
db.exec('BEGIN IMMEDIATE');
const agentRow = db.prepare(...).get(agent_id);
```

但 `ackMessage()` 仍先在 transaction 外呼叫 `_isActiveAgent()`：

```js
if (!_isActiveAgent(db, agent_id)) {
    return { success: false, reason: `403: agent_id "${agent_id}" 未登記為活躍 Agent` };
}

return withRetry(() => {
    db.exec('BEGIN IMMEDIATE');
    ...
});
```

這留下 TOCTOU 視窗：agent 在 transaction 前被判定 active，但進入 transaction 前可能已被註銷或切換為 offline，後續仍可 ACK 已鎖定訊息。這和 `claimMessage()` 的修正方向不一致，也未完全符合 I5。

建議修正：把 `_isActiveAgent()` 等價查詢移進 `ackMessage()` 的 `BEGIN IMMEDIATE` block 內，並在 transaction 內同時檢查 active 狀態、訊息狀態與 `lock_owner`。

### Low 1. `api-spec.md` 仍有舊版簽名與目前實作不一致

位置：
- `specs/P2_Design/api-spec.md:1`
- `specs/P2_Design/api-spec.md:167-170`

`api-spec.md` 標題仍是 `v1.1.3`。另外 `listPendingTasks()` 仍寫成：

```js
): Promise<Array<any>>
```

但目前實作與 server 實際回傳為 `{ tasks, count }`，且測試也以 `{ tasks, count }` 使用。這不是 runtime bug，但 L2 規格會誤導後續開發與測試。

建議修正：更新 L2 版本與 signature，例如：

```js
): Promise<{ tasks: Task[], count: number }>
```

## 已確認修正項

- `bin/server.mjs:188-197`：`channel_send` 解析 target 後若無 `active` 主角色會回 403，不再 fallback `regs[0]`。
- `src/status.mjs:197-199`：GUID `agent_id` 拒絕 reason 已改為 `invalid_agent_id_format`。
- `tests/channel.test.mjs` 已新增 `channel_send` 無 active 主角色時拒絕的測試，總測試數由 136 增加為 137。
- `src/channel.mjs:189-237`：`claimMessage()` 的活躍狀態檢查已移入 transaction，符合 I5 修正方向。

## 測試結果

已執行：

```powershell
npm test -- --runInBand
```

結果：

```text
Test Suites: 7 passed, 7 total
Tests:       137 passed, 137 total
```

## 建議優先順序

1. 修 `ackMessage()`：把 active-agent 授權檢查移入同一個 `BEGIN IMMEDIATE` transaction。
2. 更新 `api-spec.md` 的版本與 `listPendingTasks()` 回傳 signature。
