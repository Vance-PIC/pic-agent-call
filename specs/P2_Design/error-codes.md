# Error Codes (L2) — pic-agent-call v1.2.2 RC Cleanup

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

## v1.2.2 新增 / 需標準化錯誤碼

| 錯誤碼 | 型態 | 說明 | 發生模組 |
|--------|------|------|----------|
| `target_required` | `{ success: false }` | `register_agent` / `agent_status` / `channel_list_unread` 缺少必要 `target` | status.mjs / channel.mjs / server.mjs |
| `term_key_required` | `{ success: false }` | 前台註冊 CLI 無法取得 `PIC_TERM_KEY` 或合法 fallback | bin/register.mjs |
| `invalid_agent_id_format` | `{ success: false }` | `agent_id` 為 GUID 或不符合命名慣例 | status.mjs |
| `registration_conflict` | `{ success: false }` | agent_id / session / term scope 衝突且未指定 force | status.mjs |
| `active_agent_conflict` | `{ success: false }` | 同一 `term_key` 出現 active 唯一性衝突 | status.mjs / SQLite provider |
| `invalid_role` | `{ success: false }` | role 或 agent_id token 解析後不合法 | status.mjs / bin/register.mjs |
| `unauthorized_receiver` | `{ success: false }` 或 MCP `isError: true` | `receiver` 不屬於 target 解析出的活躍角色集合 | channel.mjs |
| `forbidden` | `{ success: false }` 或 MCP `isError: true` | target 無效、越權讀取或越權 claim / ack | channel.mjs / server.mjs |
| `storage_busy` | throw Error 或 normalized CLI error | SQLite busy / locked 經重試後仍失敗 | db.mjs / SQLite provider |
| `migration_failed` | throw Error | schema migration 失敗，且非 duplicate column 類可忽略錯誤 | db.mjs |
| `platform_env_unverified` | CLI normalized error | LLM command runner 路徑未驗證可繼承前台 terminal env | hook / platform adapter / conformance test |
| `child_process_launch_failure` | CLI normalized error | 未來 foreground launcher 無法啟動 AI CLI child process | bin launcher, deferred |

錯誤碼應簡量穩定；PG 不得自行新增未登錄 reason string。若需新增，必須同步更新本文件與對應測試。


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
