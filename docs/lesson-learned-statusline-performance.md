# 💡 狀態列 wrapper 效能瓶頸與進程洩漏經驗教訓 (Lesson Learned)

本文件紀錄於 `v1.1.4` 開發期間，針對 Antigravity (agy) 狀態列包裝器（`agent-statusline-wrapper.mjs`）因 Stdin 處理不當導致背景進程卡死、CPU 飆高與 SQLite 資料庫死鎖的技術成因分析、優化解決方案及未來最佳實踐。

---

## 1. 問題現象與效能衝擊 (Symptoms & Impact)

1. **狀態列完全空白**：終端機狀態列（statusline bar）一行資訊都未呈現。
2. **電腦效能嚴重卡頓**：系統資源消耗急遽上升。經排查發現，背景殘留了十多個未退出的 `node.exe` 進程。
3. **資料庫鎖死競爭 (SQLite DB Lock)**：
   * 殘留的 node 進程每 5 秒高頻率嘗試連接 SQLite WAL 資料庫並寫入心跳（heartbeat）。
   * 導致資料庫發生嚴重的寫鎖定競爭，使正常查詢被 `busy_timeout = 30000` (30秒) 長時間阻塞。

---

## 2. 根本原因分析 (Root Causes)

效能卡頓與進程洩漏主要由以下三個底層 Bug 交互作用造成：

### Bug 1: Stdin EOF 未正常關閉 (造成 1.5 秒超時掛起)
在 `agent-statusline-wrapper.mjs` 的 `spawnNode` 函式中，原實作如下：
```javascript
// ⚠️ 舊版 Bug 代碼
if (opts?.input) { child.stdin.write(opts.input); child.stdin.end(); }
```
* **成因**：當定時刷新或無 Metadata 傳入時，`opts.input` 為空字串 `''`，導致 `if (opts.input)` 判定為 **falsy**。
* **後果**：`child.stdin.end()` 永遠未被執行，子進程的 stdin 管道一直保持開啟，導致子進程（如 quotaScript）無限期等待 EOF，直至達到 `TIMEOUT_MS` (1500ms) 超時被強行中斷，每次刷新固定卡死 1.5 秒。

### Bug 2: Node Event Loop 保持活躍 (造成進程洩漏)
* **成因**：wrapper 輸出完畢後，因 `readline` 監聽了 `process.stdin` 卻未在結束時主動暫停 (`process.stdin.pause()`)，且腳本尾端沒有呼叫 `process.exit(0)`。
* **後果**：Node.js 的 Event Loop 判定 I/O 管道依然活躍，進程拒絕主動退出，從而在背景永久殘留。

### Bug 3: 下游 Quota 腳本卡頓 (超出 CLI 超時上限)
* **成因**：下游的 `statusline-quota.mjs` 在 Windows 環境下執行 Git 命令（如 `git branch`）或 countdown 需耗時 **5 秒** 左右。
* **後果**：在無防禦超時情況下，整個 wrapper 會跟著被卡住 5 秒。而 Antigravity CLI 的狀態列執行時間通常卡控在幾百毫秒內，超時的狀態列會被 CLI 直接拋棄並不予顯示，造成「整行空白」。

---

## 3. 解決方案與優化防線 (Solutions & Architecture Defenses)

為了徹底斬斷此死結，我們在 `v1.1.4` 引入了以下兩道關鍵防禦：

### 防線一：強制關閉 Stdin (Stdin Atomicity)
修改 `spawnNode`，不論 input 內容為何，只要 input 非 `undefined`，均強制呼叫 `child.stdin.end()`：
```javascript
// ✅ 修正後的代碼
if (opts?.input !== undefined) { 
  if (opts.input) child.stdin.write(opts.input); 
  child.stdin.end(); // 確保無條件發送 EOF
}
```

### 防線二：300ms 安全防禦超時與強制退出 (Performance Degradation Guard)
在 wrapper 中加入 `300ms` 的強制安全超時卡控。若 Quota 腳本因 Windows 底層命令卡死：
1. 超過 **300ms** 時，`safetyTimeout` 立即觸發。
2. 直接將已快速取得的 Agent 狀態（約 50ms）輸出，**果斷捨棄/降級 Quota 資訊**。
3. 立即呼叫 `process.exit(0)` 強制終止進程，釋放 Event Loop。
```javascript
// ✅ 修正後的 300ms 防禦防線
const safetyTimeout = setTimeout(() => {
  outputAndExit(); // 300ms 到達時，強制印出目前所得並 exit
}, 300);
```

**優化成效**：Wrapper 執行時間從 **5000ms 暴降至 < 300ms（正常時 < 80ms）**。背景殘留進程數降為 **0**，徹底排除了 CPU 佔用與 SQLite WAL 鎖競爭，使電腦效能完全恢復正常。

---

## 4. 未來開發最佳實踐 (Lessons Learned & Best Practices)

1. **高頻背景腳本防禦性設計**：任何每數秒執行一次的背景 Hook 或狀態列腳本，**必須具備總超時防線**，並在結束時呼叫 `process.exit(0)` 確保無條件退出。
2. **I/O 管道的生命週期管理**：使用 `child_process` 或 `readline` 時，必須特別留意 `stdin` 的寫入與關閉。只要建立了 writable stream，就必須保證在所有分支（包含空字串或 null 情境）都會呼叫 `.end()`。
3. **高頻查詢的讀寫分離**：SQLite 在 WAL 模式下雖允許多個讀取者，但只要有高頻寫入（如心跳更新），依然會阻塞其它寫入。應盡量降低背景心跳寫入頻率（如設定 10 秒心跳降頻閾值），避免鎖競爭。
