# UAT Checklist — pic-agent-call v1.3.1 (Trusted term_key & Platform Collaboration)

* **核准角色**：`USER (Human-in-the-Loop)`
* **執行角色**：`AGY-QA` (QA)
* **執行狀態**：`100% PASSED`
* **物理證據路徑**：[evidence/v1.3.1-channel-pool-and-self-exclusion-test-pass.log](file:///C:/PIC/AI-tools/claude-marketplace/pic-agent-call/evidence/v1.3.1-channel-pool-and-self-exclusion-test-pass.log)

---

## 1. v1.3.0 核心安全與隔離驗收項目

- [x] **Trusted term_key 安全防護**
  - *測試場景*：環境變數具備 `PIC_TERM_KEY` 時，`register_agent` 成功寫入該 key 且忽略傳入的 target 參數。
  - *測試場景*：環境變數均缺失且未開啟 debug flag 時，`register_agent` 拒絕並回傳 `term_key_unavailable` 錯誤與 diagnostics 診斷欄位。
  - *測試場景*：開啟 `PIC_ALLOW_UNTRUSTED_TARGET_TERM_KEY=1` 時，允許以 target 作為 fallback 並於 stderr 輸出警告。
- [x] **狀態列金鑰回歸與同源匹配**
  - *測試場景*：`agent-statusline.mjs` 正常以 `PIC_TERM_KEY` 或 `resolveSessionId` 查詢 DB。當與 register_agent 同源時，狀態列正確印出角色狀態與未讀數。
- [x] **PowerShell Profile 金鑰 Scope 隔離**
  - *測試場景*：執行 `setup-terminal-key.ps1` 後，PowerShell 啟動時自動分配 Scope。
  - *測試場景*：VS Code 整合終端機繼承自 Windows Terminal 污染的 `PIC_TERM_KEY_SCOPE` 時，自動重新生成新的 `PIC_TERM_KEY` 並更新 Scope 為 `vscode`（防跨 shell 類型污染）。
  - *測試場景*：一般 nested shell 或 `run_command` 繼承相同 Scope 時，保留金鑰不重複生成。
  - *測試場景*：確認 Profile 腳本不再對 `WT_SESSION` 進行 any 主動寫入。

---

## 2. v1.3.1 平台協作與自排除驗收項目

- [x] **平台池 (Platform Pool) 支援**
  - *測試場景*：向 `CC?` 發送訊息，屬於 CC 平台（如 `CC-PG1`、`CC-QA1`）的活躍角色在查詢 `listUnread` 時能正常看到，而 AGY 平台角色（如 `AGY-SA`）則看不見。
- [x] **發送者自排除 (Sender Self-Exclusion)**
  - *測試場景*：向 `any`、`role?` 或 `platform?` 發送訊息後，發送者（例如 `AGY-SA`）在查詢未讀訊息聯集時，結果中自動過濾掉自己所發送的這筆訊息，但其他合格接收者依然看得到。

---

## 3. DoD 核對表

- [x] **規格服從**：所有實作 (status.mjs, server.mjs, channel.mjs, setup-terminal-key.ps1) 100% 符合 `SDD-Spec.md` v1.3.1 與 `api-spec.md` v1.3.1 規格。
- [x] **單元測試**：執行 `npm run test`，所有單元測試 PASS（覆蓋率與新增測試覆蓋符合要求，146/146 passed）。
- [x] **物理證據**：`evidence/` 目錄下的測試報告與日誌檔案完整無缺。
