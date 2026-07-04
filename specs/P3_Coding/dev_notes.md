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

---

## v1.3.0-trusted-term-key（task-3b368741-08c8-4d9a-993a-6f4934f802de）

> [!NOTE]
> 🤖 **[交接上下文：P3 Coding ➔ P4 FunctionTest / QA]**
>
> - **任務來源**：AGY-SA 派工，根因為 AI 透過 `run_command` 讀取 `PIC_TERM_KEY` 時會 spawn 新 pwsh，量到的值與 CLI 主行程不同（非兩個物理視窗）
> - **規格**：SDD-Spec.md / api-spec.md v1.3.0（§5.2 Trust Boundary、§register_agent v1.3.0、§9）
> - **測試結果**：144/144 pass（7 suites），evidence: `evidence/v1.3.0-trusted-term-key-test-pass.log`

### 實作摘要

1. **`src/status.mjs`** 新增 `resolveTrustedTermKey(target)`：純函式，依 `process.env.PIC_TERM_KEY || process.env.WT_SESSION` 解析 trusted term_key；兩者皆缺時回傳 `term_key_unavailable` + diagnostics；僅 `PIC_ALLOW_UNTRUSTED_TARGET_TERM_KEY=1` 時允許 fallback 至 AI 傳入的 `target`（並發 warning）。
2. **`bin/server.mjs`** register_agent handler：呼叫 `resolveTrustedTermKey(target)` 取得 `resolvedTermKey`，傳入 `registerAgent()` 取代原本直傳 `target`；解析失敗直接回傳 `{ success:false, reason:'term_key_unavailable', diagnostics }`；`target` 參數 describe 文字同步更新為僅作 auth 用途。
3. **`bin/agent-statusline.mjs`** 移除 AGY 分支（`ANTIGRAVITY_CONVERSATION_ID`/`CLAUDE_CODE_SESSION_ID` 平台判斷），還原為 `process.env.PIC_TERM_KEY || resolveSessionId() || ''`，與 register_agent 同源。
4. **測試**：`tests/status.test.mjs` 新增 `resolveTrustedTermKey()` describe block，覆蓋 api-spec 6 case 矩陣（正常/降級/拒絕/Debug/Debug 無 target/CI 未注入）+ PIC_TERM_KEY 優先 invariant，共 7 個新測試（#43–49）。TDD RED→GREEN 全程走完。

### 注意事項（QA 必讀）

1. `bin/agent-statusline.mjs`、`bin/register.mjs` 皆為頂層 side-effect script（呼叫即執行、`process.exit`），專案慣例不直接單元測試，以 `evidence/` log 佐證。
2. 順帶發現 `scripts/setup-terminal-key.ps1`：VS Code 整合終端機每次啟動**強制**重生 UUID（非僅缺失時才生成）。與本次修法無牴觸（trusted term_key 邏輯本身不變，只要 register 與 statusline 出自同一個實際持久 shell 即一致），但若之後仍有跨 tab 不一致回報，這支腳本是優先排查點，供 SA 參考。

### 相依套件

無新增套件。

### P3 完成宣告

```
✅ v1.3.0-trusted-term-key 已完成
📂 產出物：specs/P3_Coding/dev_notes.md
📂 程式碼：src/status.mjs、bin/server.mjs、bin/agent-statusline.mjs、tests/status.test.mjs
📂 Evidence：evidence/v1.3.0-trusted-term-key-test-pass.log
✅ 144/144 tests pass
```
