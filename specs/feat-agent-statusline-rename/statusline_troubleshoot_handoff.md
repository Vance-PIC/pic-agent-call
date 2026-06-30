# 🔍 狀態列 (agy-statusline) 未浮現問題交接與除錯備忘錄 (SA Handoff Notes)

本文件由 System Analyst (SA) 撰寫並沉澱於 `specs/` 下，詳細紀錄目前於 Windows Antigravity 2.0 (agy) 實體終端機中，狀態列在背景執行成功但畫面上**依然空白、未浮現**的調研狀態，供 `CC-PG1` 及 `Codex` 作為接續除錯與交接的真實依據。

---

## 1. 目前現象與已確認狀態 (Symptom & Ruled-Out Items)

### 🔴 目前現象 (Symptom)
* 使用者在 Windows Terminal 重啟與輸入 prompt 後，後台指令執行正常（退出碼 0），資料庫中的 `updated_at` 也隨之正常更新。
* 但 Terminal 底部（頁尾）依然一片空白，狀態列未顯示 any 資訊。

### 🟢 已排查排除的項目 (Ruled-Out)
1. **排除了指令超時被殺**：`agent-statusline-wrapper.mjs` 中的 300ms 安全防禦超時（`safetyTimeout` + `process.exit(0)`）已啟用，絕對不會超出 CLI 對 Hook 執行的超時限制。
2. **排除了 Stdin 造成的背景卡死**：`child.stdin.end()` 的 EOF 關閉 Bug 已完全修復，不會有 node.exe 進程洩漏與 CPU 卡頓。
3. **排除了路徑引號與安全信任**：全域與專用 `settings.json` 裡的雙引號已全部移除（避免了 Windows spawn 的畸形拼接路徑 `Cannot find module` 錯誤），且 `trusted_hooks.json` 中已登記信任。
4. **排除了資料庫查詢無效**：DB 中當前 session 的 `term_key` 與 `WT_SESSION` 綁定狀態 100% 正確，測試執行輸出也正常。

---

## 2. 深度懷疑的技術成因 (Suspected Root Causes for PG / Codex)

以下為 SA 調研後，認為最有可能導致 CLI 捕獲了 stdout 卻「默默丟棄、不予顯示」的關鍵盲點：

### 🔎 懷疑一：Windows 控制台 (Console) 編碼與 Unicode Emojis 解碼失敗
* **成因**：Windows Terminal 下 the `agy.exe` 是 Go 語言編譯的，它在捕獲子進程（Node.js wrapper）的 stdout 時，預設使用作業系統的字元集（如繁體中文環境的 CP950）。
* **問題**：Node.js 輸出的狀態列 display 含有 **4-byte 寬字元 Emoji（如 `🟢`, `▶`）以及 ANSI 顏色控制碼**。Go 在讀取這些位元組流時，若因為編碼不匹配導致解碼出畸形亂碼，CLI 的格式驗證器或安全過濾可能判定該輸出「不合法」而直接將該行默默丟棄。
* **交接嘗試**：我們已在 `bin/agent-statusline.mjs` 中為 `agy` 平台實施了「純 ASCII 降級輸出」（`[SA] AGY-SA1(0)` 格式）。**請 PG 繼續確認**：此 ASCII 降級是否已經被 CLI 成功解讀，或者是否需要將所有方括號、括號等特殊 ASCII 也一併移除（例如改為最純粹的 `SA AGY-SA1 0`）以進一步排查。

### 🔎 懷疑救援二：bubbletea / lipgloss 的渲染行數與寬度邊界限制
* **成因**：Antigravity 2.0 CLI 在頁尾底部使用 bubbletea (Go UI 框架) 與 `lipgloss` 進行排版渲染。其 Footer 區塊通常是「固定的單行渲染」。
* **問題**：
  * 當 Quota 腳本正常返回時，wrapper 的輸出會有 **2 行**（第一行 Quota 資訊，第二行 Agent 資訊）。
  * 如果 bubbletea 的 Footer 控制器**只預留了 1 行的高度**，接收到 2 行輸出時，可能會引發渲染器邊界溢出崩潰，或直接拒絕渲染這多出來的行數，導致整行變空白。
* **調查建議**：
  1. 請 PG 或 Codex 協助在 `settings.json` 中臨時把 statusLine 設為 `node C:/.../agent-statusline.mjs` (只輸出 Agent 的單行) 測試看能否顯示。
  2. 檢查 `agy` CLI 原始碼中對於 `ui.footer` 或 `statusLine` 輸出的 lines 限制與寬度裁切邏輯。

### 🔎 懷疑三：CLI 內部 `/statusline` 開關狀態與會話 Session ID
* **問題**：CLI 內部維護的狀態列開關（藉由 `/statusline` 控制）是否因為重啟或 session 轉移，在內部被記為了 `false` 或 `disabled`。請 PG 協助確認在該狀態下，`/statusline` 指令是否能正常切換與觸發背景 wrapper 執行。

---

## 3. 交接代辦事項 (Handoff TODOs for CC-PG1)

1. 優先修復 `specs/P2_Design/SDD-Spec.md` §6.12 節中定義的 C1~C2, I1~I6 併發安全與時區問題。
2. 在修復 channel 與 tasks 代碼時，順便在本地調試 agy 狀態列的 stdout 捕獲：
   * 試著在 `agent-statusline-wrapper.mjs` 輸出最純粹的單行英文字串（如 `hello`），看 agy 底部是否能顯示。
   * 若 `hello` 能顯示，再逐步加入 `[SA]`, `AGY-SA1`, 以及 ANSI 顏色、Emoji，藉此找出 Go 語言捕獲 stdout 的「字元集/轉義碼地雷邊界」。

---

## 4. settings.json 額度指標項目缺失問題 (v1.1.4 補正)

### 🔴 額度列空白問題與成因 (Symptom & Root Cause)
* **現象**：狀態列啟用後，只有 Agent 狀態列能浮現，但上面的 `antigravity-cli-statusline`（Quota 狀態列）卻只退回預設的極簡快捷鍵與模型名稱格式，沒有任何彩色膠囊額度指標。
* **成因**：全域與專用 `settings.json` 中缺失了 `ui.footer.items`（或 `statusLine.items`）陣列，導致 `statusline-quota.mjs` 判定沒有需要啟用的指標項目，進而直接降級執行退回邏輯（L239-245）。

### 🟢 解決方案與指標排序規範 (Solution & Ordered Items)
* **方案**：必須在全域與專用 `settings.json` 的 `ui.footer` 與 `statusLine` 區塊下，寫入 `items` 陣列指標。
* **指標排序規範**（依照使用者期望之最佳排版視覺效果進行順序排列）：
  ```json
  "items": [
    "project-full-path",
    "git-branch",
    "model-name",
    "context-used",
    "token-count",
    "quota",
    "quota-reset-countdown"
  ]
  ```
  當 settings.json 套用此 items 設定後，狀態列即會按照以上順序渲染並顯示豐富的指標膠囊，並藉由 hot reload 即時生效。

---

## 5. MCP 伺服器與狀態列 DB 路徑分裂問題 (v1.1.4 補正)

### 🔴 DB 分裂不同步問題與成因 (Symptom & Root Cause)
* **現象**：在對話框中成功執行 `register_agent` 將主角色設為 SA1 且 JSON 回傳正常，但 Terminal 底部的 `agent-statusline` 卻依然頑固顯示舊的主角色（如 PM1）。
* **成因**：
  * 對話框的 MCP 伺服器進程啟動時 `cwd` 為家目錄 `C:\Users\P10377167`，因此 `resolveMemoryPaths` 返回並讀寫的是家目錄下的 `C:\Users\P10377167\.memory\memory-graph.db`。
  * 背景刷新腳本 `agent-statusline.mjs` 執行時 `cwd` 為專案目錄，因此讀寫的是專案目錄下的 `.memory/memory-graph.db`。
  * 兩個進程各自讀寫完全不同的 SQLite 資料庫，導致狀態列資訊與對話框登錄完全分裂不同步。

### 🟢 解決方案 (Solution)
* **方案**：修改 `src/db.mjs` 中的 `resolveMemoryPaths`，在解析專案目錄 `.memory` 時，應從當前目錄向上遞迴尋找 `.git` 或 `package.json` 以定位真實的專案根路徑，以此專案根路徑為基準讀寫 `.memory` 資料庫，不再盲目依賴 `process.cwd()`。

### 📅 PG1 追加代辦事項
3. 依據 `specs/P2_Design/SDD-Spec.md` §6.12 第 6 點，修改 `src/db.mjs` 中的 `resolveMemoryPaths` 函式，實施向上遞迴尋找專案根目錄防分裂機制，確保 MCP 伺服器長進程與背景 `agent-statusline.mjs` 讀寫同一個 SQLite 資料庫檔案。
4. 依據 `specs/P2_Design/SDD-Spec.md` §6.12 第 7 點及三態狀態模型（v1.1.4 補正），重構 `src/db.mjs`、`src/status.mjs` 與 `src/channel.mjs`：
   * **DB 變更**：`term_key TEXT NOT NULL`，且限制 `status IN ('active', 'attached', 'offline')`。廢除 `is_primary` 欄位。增設 `idx_agents_term_active` 唯一活躍索引。
   * **註冊狀態與轉移**：名單首位設為 `'active'`，其餘為 `'attached'`。同視窗重開新 Session 時，先斷開舊會話（`status = 'offline'`）再整批繫結。
   * **心跳與 attached 豁免**：心跳更新擴大為 `status IN ('active', 'attached')`，保持 attached 角色的在線掛載；狀態列可讀取 attached 角色的未讀數。
   * **讀信與 Claim 權限門禁**：`server.mjs` 呼叫時自動解析並傳入 `sessionId`；`channel.mjs` 內部校驗唯有 `'active'`（主角色）可讀信與 Claim，其餘 `'attached'` 角色一律拒絕。
   * **雙重超時與 Freshness**：`agent_timeout_sec = 86400`（24小時）作為 DB 存活超時；狀態列渲染則使用 120 秒作為 Freshness threshold 判定是否顯示黃燈/灰燈，不改變 DB status。
   * **自動注入**：在 `bin/setup-statusline.mjs` 啟動時，若環境變數無 `PIC_TERM_KEY`，自動產生隨機 UUID 並寫入當前視窗環境變數 `$env:PIC_TERM_KEY`。
   * **過期自動清理**：每次超時判定，自動 `DELETE` 離線已滿 7 天的角色。

