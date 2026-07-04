# Code Review Result - rerun 6

Review date: 2026-07-02
Scope: `src/`, `bin/server.mjs`, `tests/` 對照 `specs/P2_Design`
Reviewer: Codex

## 結論

r5 回報的兩個問題本輪已確認修正：

- `ackMessage()` 的 active/attached 授權檢查已移入 `BEGIN IMMEDIATE` transaction 內，符合 SDD §6.12 I5 / §6.12.4.4 的 TOCTOU 防護要求。
- `api-spec.md` 已更新到 `v1.2.2`，且 `listPendingTasks()` signature 已改為 `Promise<{ tasks: Task[], count: number }>`。

針對 `src/` 與 `bin/server.mjs`，本輪未再發現新的規格不符。測試全數通過。

## Findings

### Low 1. `error-codes.md` 仍是舊版 L2 文件，未收錄 v1.2.2 新增錯誤碼

位置：
- `specs/P2_Design/error-codes.md:1`
- `specs/P2_Design/error-codes.md:7-16`
- 對照：`src/status.mjs:193`, `src/status.mjs:199`, `src/channel.mjs:51`, `src/channel.mjs:123-155`

`error-codes.md` 標題仍為 `v1.0.0`，目前只列出早期錯誤碼。v1.2.2 之後新增或實際使用的錯誤碼 / reason 未同步收錄，例如：

- `target_required`
- `invalid_agent_id_format`
- `ERR_UNAUTHORIZED`
- `ERR_FORBIDDEN`
- channel / task 中多個 `403: ...` reason

這不是 runtime bug，也不影響本輪測試，但 L2 錯誤碼文件已無法完整反映目前 API contract。後續若 QA 或 caller 依 `error-codes.md` 建立錯誤處理矩陣，會漏掉 register/channel 的新錯誤路徑。

建議修正：將 `error-codes.md` 升版到 `v1.2.2`，補齊上述錯誤碼與 MCP `isError` 規則。

## 已確認修正項

- `src/channel.mjs:241-268`：`ackMessage()` 現在於 `withRetry` callback 內先 `BEGIN IMMEDIATE`，再執行 `_isActiveAgent(db, agent_id)`，授權檢查與 ACK 狀態更新在同一交易邊界內。
- `specs/P2_Design/api-spec.md:1`：版本已更新為 `v1.2.2`。
- `specs/P2_Design/api-spec.md:167-170`：`listPendingTasks()` 回傳 signature 已更新為 `{ tasks, count }`。
- `bin/server.mjs:188-197`：`channel_send` 無 active 主角色時拒絕發送的修正仍保留。
- `src/status.mjs:197-199`：GUID agent_id reason 仍為 `invalid_agent_id_format`。

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

1. 同步更新 `specs/P2_Design/error-codes.md`。
2. 若 SA 認定 `error-codes.md` 暫不維護，則可將本輪視為 src/bin review pass。
