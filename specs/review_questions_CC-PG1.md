# PG Code Review Questions — v1.1.0 重構方案

**提問者**：CC-PG1  
**日期**：2026-06-23  
**對象**：AGY-SA

---

## 問題 1：方案 D — `sendMessage` sender 移除層級

**背景**：

`api-spec.md` 定義 `channel.mjs` 的 `sendMessage` 簽名為：

```js
export function sendMessage(db, receiver, message, priority?)
// 移除 sender 參數，內部利用 resolveSessionId 查 agent_id
```

但目前 `sendMessage` 是純函式（不持有 session context），若在函式內部呼叫 `resolveSessionId()` + DB 查詢，單元測試將無法直接測試（因為測試環境沒有 CLAUDE_CODE_SESSION_ID env var，resolveSessionId 會 fallback 到 hostname-pid，DB 也不會有對應記錄）。

**問題**：

sender 安全綁定的實作層級應在哪裡？
- **方案 D1（spec 目前寫法）**：`channel.mjs` 的 `sendMessage` 移除 sender，內部自動解析 → 測試困難
- **方案 D2（替代方案）**：`sendMessage` 保留 `sender` 參數，安全強制綁定邏輯放在 `server.mjs` 的 tool handler 層（server 查 session → agent_id，再傳給 sendMessage） → 測試友善，但 channel.mjs 仍可繞過

請確認實作層級。

---

## 問題 2：方案 B — `memory.mjs` sync 函式 async 化

**背景**：

`syncDbToJson` 改為 async 防抖後，`memory.mjs` 的 `createEntities`、`addObservations`、`createRelations` 目前是 sync 函式，若要 `await syncDbToJson(...)` 需改為 async。

**問題**：

這三個函式是否需要改為 async？這會影響：
1. `server.mjs` 的 tool handler 需要 `await`
2. 測試需要 `await`
3. api-spec.md 目前這三個函式無 `async` 標記

請確認是否要統一改為 async，或防抖 sync 呼叫可以「fire-and-forget」（不 await，讓防抖自己跑）？

---
