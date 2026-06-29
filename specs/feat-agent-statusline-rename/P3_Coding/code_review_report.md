# Code Review Report — feat-agent-statusline-rename (v1.1.4)

> 產出者：CC-PG1 | 工具：workflow code-review (ecc:code-simplifier + agent-skills:code-reviewer)
> 日期：2026-06-29 | 狀態：**REQUEST CHANGES — 待 SA 更新 SPEC 後派工修正**

---

## Verdict: REQUEST CHANGES

---

## 🔴 Critical Issues（必修）

### C1 — `src/tasks.mjs:106-115` TOCTOU race in completeTask/failTask
**問題**：`completeTask` 與 `failTask` 的 SELECT status 與 UPDATE 未包在 `BEGIN IMMEDIATE` transaction。並發場景下 UPDATE 靜默完成 0 rows，但函式仍回傳 `{ success: true }` 帶過期 `completed_at`。
**影響**：task-broker 狀態不一致，可能導致任務雙重完成或幽靈成功。
**建議修法**：同 `claimTask` 模式，將 pre-check SELECT + UPDATE 包入 `BEGIN IMMEDIATE ... COMMIT`。

### C2 — `src/db.mjs:177-203` `_doSyncDbToJson` 吃掉所有 error
**問題**：外層 `catch (_) {}` 丟棄所有例外（含 disk full、rename 失敗、權限錯誤），JSON 快照可永久偏離 SQLite DB 且無任何訊號。
**影響**：memory-graph.json 資料靜默損壞，跨代理人記憶失效。
**建議修法**：至少 `console.error` 記錄，或 expose 健康旗標供呼叫端感知。

---

## 🟠 Important Issues（應修）

### I1 — `src/tasks.mjs:6-10` `_now()` JS timezone offset 計算錯誤
**問題**：`_now()` 使用 `getTimezoneOffset() * 60000` 計算本地時間，DST 邊界（半小時時區如 IST、NPT）會截斷。其他所有 timestamp 均使用 `datetime('now','localtime')`。
**建議修法**：直接在 SQL 中用 `datetime('now','localtime')` 替換三個 call-site，刪除 `_now()`。

### I2 — `src/memory.mjs:72` `datetime('now')` 缺 `'localtime'`
**問題**：`addObservations` 的 UPDATE `updated_at` 寫入 UTC，其他所有 timestamp 為 localtime，破壞時間排序與顯示邏輯。
**建議修法**：改為 `datetime('now','localtime')`。

### I3 — `src/channel.mjs:28-53` sendMessage broadcast SELECT 在 transaction 外
**問題**：`SELECT agent_id FROM agents WHERE status = 'active'` 在 `BEGIN IMMEDIATE` 之前執行，agent 可在 read 後、write 前被移除，導致 missed 或 phantom receivers。
**建議修法**：將 SELECT 移入 `BEGIN IMMEDIATE` 內。

### I4 — `src/db.mjs:129-137` schema migration 吞掉所有 ALTER TABLE 錯誤
**問題**：`try { db.exec(sql); } catch (_) {}` 吞掉所有 ALTER TABLE 失敗，含 missing table / schema 損壞，留下部分遷移狀態。
**建議修法**：判斷 `err.message.includes('duplicate column')` 才 swallow，其他錯誤應 rethrow 或 log。

### I5 — `src/channel.mjs:147-161, 207-221` 重複的 primary-agent 解析邏輯
**問題**：`claimMessage` 與 `ackMessage` 有相同 10 行 WT_SESSION → term_key → sessionId → registrations 查詢，且查詢在 transaction 外（authorization 保證略弱）。
**建議修法**：提取 `_resolvePrimaryAgentId(db, sessionId)` helper，或將查詢移入 transaction 並加文件說明 best-effort 性質。

### I6 — 缺少 channel claim/ack 的測試
**問題**：`tests/status.test.mjs` 無任何 `channel.mjs` claim/ack 測試，但 TOCTOU race（C1 同性質）正存在於此路徑。
**建議修法**：新增 channel claim/ack 測試案例。

---

## 🟡 Suggestions（重構簡化，非阻塞）

| 位置 | 建議 |
|------|------|
| `tasks.mjs:27-34` | 提取 `_validateString(val, maxLen)` 消除 4 個重複 guard |
| `tasks.mjs:106-108, 124-126` | 提取 `_requireClaimedTask(db, task_id)` helper |
| `db.mjs:11-43` | 提取 `_makePaths(dbPath)` 消除 3 處重複 literal |
| `memory.mjs:111-125, 140-148` | 提取 `_buildObsMap(rows)` 消除重複 obsMap 累積邏輯 |
| `status.mjs:76-87` | ORDER BY 片段常數化，供 3 個 query function 共用 |
| `status.mjs:330-337` | consolidate `unreadStmt` / `unreadNoPoolStmt` 為單一參數化 path |
| `bin/agent-statusline.mjs:47` | term_key 補寫缺 `withRetry` 包覆，busy DB 時靜默失敗 |
| `bin/agent-statusline-wrapper.mjs:65-67` | 300ms safety timeout 對慢機器可能不夠，建議 env var 可配置 |

---

## 優先修正順序（CC-PG1 建議）

1. **C1** tasks.mjs TOCTOU — 資料正確性
2. **C2** db.mjs silent error swallow — 靜默資料損壞
3. **I2** memory.mjs datetime UTC — 靜默時間欄位錯誤
4. **I4** db.mjs migration error — schema 遷移安全性
5. **I1** tasks.mjs `_now()` timezone — 時區正確性
6. **I3, I5, I6** channel transaction safety + 測試補充

---

## 什麼是好的（Done Well）

- `registerAgent` 三圍邏輯乾淨，fence2 term_key shortcut 是好的效能優化
- forced orphan 保護（同視窗重啟不孤兒化）邏輯正確且有 O1/O2 測試驗證
- `syncDbToJson` debounce 設計良好，防止高頻寫入風暴
- `getAgentStatus`/`registerAgent` 測試覆蓋率高（cases 15-21, P1-P5）

---

> 🔖 **待辦**：請 pic-SA1 依本 report 更新 SDD-Spec.md 相關規格後，派工 CC-PG1 修正 C1、C2、I1~I6。
