# Error Codes (L2) — pic-agent-call v1.0.0

---

## 錯誤碼定義

| 錯誤碼 | 型態 | 說明 | 發生模組 |
|--------|------|------|----------|
| `ERR_DATABASE_LOCKED` | throw Error | SQLITE_BUSY 超過最大重試次數（20 次） | db.mjs |
| `ERR_ENTITY_NOT_FOUND` | throw Error | addObservations 時指定實體不存在 | memory.mjs |
| `validation_error` | `{ success: false }` | 輸入參數不合法（長度、型態、空值） | tasks.mjs / channel.mjs |
| `not_found` | `{ success: false }` | task / message 不存在 | tasks.mjs / channel.mjs |
| `already_claimed` | `{ success: false }` | task 已被其他 agent 領取 | tasks.mjs |
| `invalid_status` | `{ success: false }` | task 狀態不符操作前提 | tasks.mjs |
| `race` | `{ success: false }` | channel claim 被搶先 | channel.mjs |
| `payload_too_large` | `{ success: false }` | payload/result/fail_reason 超過 byte 上限 | tasks.mjs |

---

## 錯誤處理原則

**library 層**（src/*.mjs）：
- 可回復錯誤 → 回傳 `{ success: false, reason }` 物件，**不 throw**
- 不可回復錯誤（DB locked / DB init 失敗）→ **throw Error**
- 禁止呼叫 `process.exit()`

**server 層**（bin/server.mjs）：
- catch throw → 回傳 `{ isError: true, content: [{ type: 'text', text: err.message }] }`
- DB init 失敗 → `process.exit(1)`

**CLI 入口層**（bin/register.mjs）：
- 註冊成功 → `process.exit(0)`
- 註冊失敗或參數驗證不合法 → 輸出 Normalized Error 並以 `process.exit(1)` 退出


---

## MCP isError 回傳規則

| 情境 | isError |
|------|---------|
| 操作成功 | 省略（undefined） |
| query-entity 找不到實體 | `true` |
| claim / complete / fail 操作失敗 | `true` |
| DB throw | `true` |
