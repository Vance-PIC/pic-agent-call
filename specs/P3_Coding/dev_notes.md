# P3 Coding Dev Notes — feat-agent-multitenant-isolation

> [!NOTE]
> 🤖 **[交接上下文：P3 Coding ➔ P4 FunctionTest / QA]**
>
> - **開發分支**：`track/feat-agent-multitenant-isolation`
> - **最終 commit**：`7dea06b`（[P3_Coding] fix(status,server): implement 3 SA-clarified specs from code review）
> - **測試結果**：136/136 pass（7 suites）

---

## 實作摘要

本 P3 週期完成 Code Review 全部 10 項問題的修正，分由 CC-PG1 與 SA commit 52d099d 共同完成：

| # | 問題 | 修正方式 | commit |
|---|------|---------|--------|
| 高 #1 | `listUnread` 空 target 越權繞過 403 | 反轉條件：`!regs \|\| regs.length===0` 直接 throw 403 | 52d099d (SA) |
| 高 #2 | `register_agent` server handler target 必填 | `bin/server.mjs` 加 `target_required` guard | 7dea06b (PG1) |
| 高 #3 | `idx_agents_term_active` 唯一部分索引確保 | schema 已在 `src/db.mjs:187` 建立 | 52d099d (SA) |
| 高 #4/5 | `registerAgent` nested transaction crash + forced active 鎖釋放 | `handleOrphanedMessages` 移除內層 BEGIN IMMEDIATE；`registerAgent` 加外層 BEGIN IMMEDIATE；`if (forced)` 才降 active→attached | 52d099d (SA) |
| 高 #6 | `claimTask` 缺 agent 授權 DB 驗證 | 加 `SELECT 1 FROM agents WHERE agent_id=? AND status IN ('active','attached')` | 52d099d (SA) |
| 中 #7 | payload/result 限制過大（1MB→64KB） | `createTask`/`completeTask` 改 65536 | 52d099d (SA) |
| 中 #8 | `getAgentStatus` stale 時 return null 打壞 statusline | 改回傳 `freshness:'fresh'\|'stale'` per-agent 欄位；dot 🟡 | 7dea06b (PG1) |
| 中 #9 | attached 狀態能否 claim/ack | SA 選 Option B：attached 可操作，三態說明更新 spec | 52d099d (SA) |
| 中 #10 | `addObservation` 缺 input validation | entityName 1–100、observationText 1–2000 邊界驗證 | 52d099d (SA) |
| 其他 | `initAgentsTable` schema 不完整；`is_primary` 廢棄 comment | 補齊欄位、加廢棄說明 | 52d099d (SA) |

---

## 注意事項（QA 必讀）

1. **`_doSyncDbToJson` ERR_INVALID_STATE 警告**：測試跑完後 debounce timer 在 DB 關閉後觸發，屬已知無害 `console.error`，不影響功能。
2. **`register_agent` target 必填**：lib 函式（`src/status.mjs::registerAgent`）本身不強制 target，guard 在 `bin/server.mjs` handler 層。測試直呼 lib 可不帶 target（設計意圖：測試隔離）。
3. **`claimTask` 需要 agent 存在 DB**：UAT 場景中 agent 必須先 `register_agent` 才能 `claim_task`，否則回傳 403。

---

## 相依套件

無新增套件。

---

## P3 完成宣告

```
✅ P3 已完成
📂 產出物：specs/P3_Coding/dev_notes.md
📂 程式碼：src/{status,channel,tasks,memory}.mjs、bin/server.mjs、tests/tasks.test.mjs
📂 Code Review 報告：specs/P3_Coding/code-review-result.md
✅ 136/136 tests pass

請 PJM 審查並執行：
scripts/approve-phase.ps1 -Feature feat-agent-multitenant-isolation -Phase P3
```
