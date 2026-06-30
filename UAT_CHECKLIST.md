# UAT Checklist — pic-agent-call (Three-State & Heartbeat Optimizations)

* **核准角色**：`USER (Human-in-the-Loop)`
* **執行角色**：`AGY-QA` (QA)
* **執行狀態**：`100% PASSED`
* **物理證據路徑**：[evidence/uat_test_pass.log](file:///C:/PIC/AI-tools/claude-marketplace/pic-agent-call/evidence/uat_test_pass.log)

---

## 1. 核心功能驗收項目

- [x] **三態活躍角色模型 (Three-State Model)**
  - *驗收結果*：狀態列成功並存顯示多個掛載角色（`active/attached`）。無權角色嘗試讀取信件時被 403 阻斷，主角色能正常讀取。
- [x] **10 秒心跳降頻與非同步背景更新**
  - *驗收結果*：`getAgentStatus` 在 10 秒內重複調用時直接略過 DB 寫入操作。超過 10 秒的心跳更新改以 `setImmediate` 背景非同步寫入，主線程完全無阻塞。
- [x] **多角色註冊主從切換 (Active 鎖定釋放)**
  - *驗收結果*：重設主從角色順序時，在迴圈開始前自動降級該 session_id 下的所有活躍角色為 `attached`，徹底解決 `idx_agents_term_active` 唯一索引衝突。
- [x] **向上遞迴尋根防分裂**
  - *驗收結果*：`resolveMemoryPaths` 成功向上遞迴查找專案根目錄，不再產生分裂子庫。
- [x] **自訂 settings.json 分鐘參數**
  - *驗收結果*：讀取 `settings.json` 中配置的 `agentTimeoutMin`、`statusLineFreshnessMin`、`historyPurgeMin` 參數並精確套用於對應的超時、黃燈與過期清理邏輯。

---

## 2. DoD 核對表

- [x] **規格服從**：所有欄位與 API 設計 100% 遵守 L2 `api-spec.md` 與 `db-schema.md`。
- [x] **單元測試**：136/136 單元測試 PASS。
- [x] **物理證據**：`evidence/uat_test_pass.log` 存在且完整。
