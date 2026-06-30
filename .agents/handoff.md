# 📜 Spec 交接驗收 & 實作進度手冊 (Handoff to CC-PG)

本文件是為 **Claude Code (CC)** 作為執行端（pic-PG/DevOps/QA）接手時準備的交接手冊，詳細說明了 **Gemini (AGY)** 作為 SA 已完成的規格修改與代碼實作進度。

---

## 1. 調整目標與背景
* **移除哨兵指標**：自狀態列腳本中徹底移除了已被停用的哨兵倒數（`watchdog-countdown`）指標及相關邏輯。
* **狀態列產品化**：為了讓所有使用者都能一鍵合併 Gemini Quota 與 Brain 狀態列，我們將原本手寫在個人 `~/.gemini` 下的 wrapper 邏輯與一鍵安裝器，直接收納到 `@pic-ai/pic-agent-call` 核心產品專案中。

---

## 2. 異步異動檔案清單

### 🎨 規格書修改 (已由 AGY-SA 完成)
1. **[specs/P2_Design/SDD-Spec.md](file:///C:/PIC/AI%20tools/claude-marketplace/pic-agent-call/specs/P2_Design/SDD-Spec.md)**
   * 將原本的 `bin/statusline.mjs` 規格更新為 `bin/agent-statusline.mjs`。
   * 新增了 `bin/msg-statusline-wrapper.mjs` 作為狀態列整合包裝器的規格描述。
2. **[README.md](file:///C:/PIC/AI%20tools/claude-marketplace/pic-agent-call/README.md)**
   * 更新了相關指令說明，將舊的 statusline 指向新指令，並加入 wrapper 安裝說明。

### 💻 原始碼修改 (已由 AGY-PG/DevOps 實作)
1. **`bin/statusline.mjs`** (已刪除)
   * 舊狀態列腳本已移除，由新版取代。
2. **[bin/agent-statusline.mjs](file:///C:/PIC/AI%20tools/claude-marketplace/pic-agent-call/bin/agent-statusline.mjs)** (已建立)
   * 重新命名並完整繼承了原腳本的訊息狀態查詢與 `agent-sessions/cc-*.json` fallback 讀取邏輯。
3. **[bin/msg-statusline-wrapper.mjs](file:///C:/PIC/AI%20tools/claude-marketplace/pic-agent-call/bin/msg-statusline-wrapper.mjs)** (已建立)
   * **超時防卡死保險**：針對 `execFileSync` 分別加上了 `timeout: 250` (Quota 腳本) 與 `timeout: 150` (Brain 狀態列) 的超時設定。即使 SQLite 鎖定卡死，wrapper 也會被 Node.js 主動安全中斷，徹底避免 CLI 超時強行 Terminate 拋出 `Access is denied` 錯誤。
   * **相對路徑載入**：使用 `fileURLToPath(import.meta.url)` 動態解析同目錄下的 `agent-statusline.mjs`，消除原本全域路徑中對 `homedir` 的硬編碼，達成跨作業系統、跨安裝路徑的 100% 通用性。
4. **[bin/setup-statusline.mjs](file:///C:/PIC/AI%20tools/claude-marketplace/pic-agent-call/bin/setup-statusline.mjs)** (已建立)
   * 一鍵設定安裝器。執行後會自動去解析使用者的家目錄，更新 `~/.gemini/settings.json`（設定 command 指向全域的 wrapper 絕對路徑、移除 `watchdog-countdown` 並套用 powerline 風格），並將 wrapper 的絕對路徑寫入 `~/.gemini/trusted_hooks.json` 安全性信任清單中。
5. **[package.json](file:///C:/PIC/AI%20tools/claude-marketplace/pic-agent-call/package.json)** (已註冊 bin)
   * 註冊了三個全域執行指令：
     - `"msg-statusline": "bin/agent-statusline.mjs"`
     - `"msg-statusline-wrapper": "bin/msg-statusline-wrapper.mjs"`
     - `"setup-statusline": "bin/setup-statusline.mjs"`

---

## 3. 當前品質與測試狀態
* **單元測試狀態**：
  在 CWD 目錄下執行 `npm run test`，**5 組 Test Suites 共 76 項單元測試全部 100% PASS**（無任何 Regression Bug）。
* **狀態列驗證**：
  改名後的 `agent-statusline.mjs` 搭配新版 `msg-statusline-wrapper.mjs` 能在 `pic-agent-call` 下正常解析出 `CWD`、`Git分支` 與當前的註冊代理人身份（`AGY-DevOps2`），運作良好。

---

## 4. 下一步交接給 CC 的任務 (Next Steps for CC)
CC 接手後，可以執行以下動作進行驗收與發布：

1. **本地執行一鍵安裝器測試**：
   在開發目錄下執行：
   ```bash
   node bin/setup-statusline.mjs
   ```
   檢查您個人的 `~/.gemini/settings.json` 和 `~/.gemini/trusted_hooks.json` 是否被正確、無損地寫入了 wrapper 的指向與安全授權。
2. **審查與提交**：
   * 檢查程式碼的 KISS 原則與編譯警告。
   * 通過後，請 CC 執行 `git add .` 將相關修改與新檔案提交，並依據 Git-Flow 完成發布交付。
