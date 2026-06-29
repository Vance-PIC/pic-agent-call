# Dev Notes — feat-agent-statusline-rename

## 🤖 操作缺失檢討報告

**報告日期**：2026-06-25
**回報人**：CC-PG2
**嚴重等級**：低（本次未造成實際錯誤，但為潛在風險）

---

### 一、問題說明

確認「主/副角色判斷規則」時，僅查閱 `specs/P2_Design/SDD-Spec.md`，未同步查閱 `specs/P2_Design/api-spec.md`。直到用戶明確 @ 指定 api-spec.md 才補讀。

---

### 二、影響範圍

- **本次影響**：兩份 SPEC 結論一致，實際回答正確，未造成錯誤交付
- **潛在風險**：若兩份 SPEC 有差異（如 api-spec 有更細的型態限制、廢棄標記、或參數變更），可能產生錯誤實作並通過錯誤的單元測試，到 QA 或 UAT 才爆發

---

### 三、根本原因

未建立「查規格須雙文件齊查」的操作習慣。預設只搜尋 SDD-Spec（設計邏輯層），遺漏 api-spec（函式簽名 / 型態 / 廢棄標記層）。本質是 checklist 缺失，非技術能力問題。

---

### 四、補救辦法

1. **即時**：已將規則寫入 auto-memory（`feedback_spec_reading.md`），未來 session 自動載入
2. **流程**：MEMORY.md 加入索引條目，確保跨 session 持續生效
3. **通知**：已發 channel 訊息告知 AGY-SA 與 AGY-PM

**補救方法修正（2026-06-25 補記）**：

初版補救辦法僅描述「查閱多份 SPEC」，不夠具體。正確的 SPEC 對照程序應為：

1. `git diff v1.1.3..HEAD -- specs/P2_Design/` 查看本次分支相對**上一個 release tag（v1.1.3）**的 SPEC 差異，確認 SA 做了哪些調整
2. 對照 `git diff v1.1.3..HEAD -- src/ bin/` 確認實作變更範圍
3. 逐一核查每個實作變更是否有對應的 SPEC 條目，找出遺漏

**本次執行結果**：`specs/P2_Design/` 對比 v1.1.3 **零 diff**，表示 SA 的 SPEC 更新（含 `~/.gemini/statusline-wrapper.mjs` 條目）已在 v1.1.3 之後直接推至 main，SPEC 現況已是最新。但發現以下 5 項 **SPEC 與實作不符**，已通知 SA 更新：

| # | 檔案 | 問題 | 類型 |
|---|------|------|------|
| 1 | api-spec.md | `getAgentStatus` 缺第三參數 `primaryAgentId` | SPEC 舊欠債（v1.1.3 前即存在，本次分支未改動） |
| 2 | api-spec.md | `resolveSessionId` 缺 `callerType` 參數 | SPEC 舊欠債（同上） |
| 3 | api-spec.md | 缺 `getAgentsByPlatformStatus`、`getRegistration` 兩個 export | SPEC 舊欠債（同上） |
| 4 | SDD-Spec §3 | `agent-statusline-wrapper.mjs` 描述過時（未反映 readline 方案）| 本次分支引入之差異 |
| 5 | SDD-Spec §2 | `bin/` 目錄清單不完整 | SPEC 舊欠債 |

> `git diff v1.1.3..HEAD -- src/status.mjs` 驗證：第 1-3 項無 diff，確認為既有欠債。第 4 項（readline 方案）為本次 v1.1.4 分支新增，SPEC 確實需要補。

---

### 五、程式碼補改說明

本次缺失為**流程操作問題**，不需改動生產程式碼。但有一項遺漏的文件同步需補齊：

#### 5.1 已改動的檔案（feat-agent-statusline-rename 分支）

| 檔案 | 改動內容 | Commit |
|------|---------|--------|
| `bin/setup-agy-statusline.mjs` | 新增 `setupForwarder()`，以 `fileURLToPath(import.meta.url)` 動態解析 `agent-statusline-wrapper.mjs` 真實絕對路徑，寫入 `~/.gemini/statusline-wrapper.mjs` | `fee4159` |
| `~/.gemini/statusline-wrapper.mjs` | target 路徑由 `msg-statusline-wrapper.mjs` 修正為 `agent-statusline-wrapper.mjs` | 直接修改（非 repo 追蹤） |

#### 5.2 未改動但需確認的檔案

| 檔案 | 確認項目 |
|------|---------|
| `specs/P2_Design/SDD-Spec.md` | SA 於 msg-050adf17 指出 §3 模組切割表格需含 `~/.gemini/statusline-wrapper.mjs` 條目，請 SA 確認已補充 |

---

### 六、QA 請協助補充的測試案例

**T1 — `setupForwarder()` 動態路徑生成正確性**
- 執行 `node bin/setup-agy-statusline.mjs`
- 驗證 `~/.gemini/statusline-wrapper.mjs` 的 `target` 變數值等於 `bin/agent-statusline-wrapper.mjs` 的真實絕對路徑
- 路徑分隔符應為正斜線（`/`）
- 不應包含 `msg-statusline-wrapper.mjs` 舊名

**T2 — forwarder 可正常啟動**
- 執行 `node ~/.gemini/statusline-wrapper.mjs`
- 應可成功啟動並正常退出（exit code 0）
- 不應出現 `Cannot find module` 錯誤

**T3 — 改名後 statusline 輸出正常**
- 模擬 CC 視窗環境（設定 `CLAUDE_CODE_SESSION_ID`、`WT_SESSION`）
- 執行 `node bin/agent-statusline.mjs`
- 應輸出正確的 agent 狀態，不應輸出 `NO AGENT` 或報錯

---

### 七、檢驗方式

**操作合規**：下次查規格時，工具呼叫 log 中應同時出現對 `SDD-Spec.md` 與 `api-spec.md` 兩份文件的 Read 或 Grep 呼叫，缺一視為未合規。

**程式碼修復**：T1、T2、T3 測試案例全數通過。

---

> [!NOTE]
> 🤖 **[開發上下文：P3 Coding 缺失補救]**
> * **分支**：`track/feat-agent-statusline-rename`
> * **相關 Commit**：`fee4159` fix(setup-agy-statusline)
> * **待 QA**：T1、T2、T3 三個測試案例（見第六節）
> * **注意事項**：`setupForwarder()` 使用 template literal 展開 `targetPath`，QA 驗證時注意路徑分隔符為正斜線（`/`）
