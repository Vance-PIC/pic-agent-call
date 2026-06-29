# Lesson Learned: 物理工作區 Git 衝突與角色權限誤傷事件報告

## 1. 事件背景
* **時間**：2026-06-29 17:21 (UTC+8)
* **角色**：`AGY-SA1` (SA)
* **受害者**：`CC-PG1` (PG)
* **事件摘要**：SA1 在執行規格書（specs/）的版本回退時，於終端機執行了 `git reset --hard HEAD~1` 命令。由於 PG1 正在本地編寫 `src/` 與 `tests/` 代碼且尚未 commit 提交，該毀滅性 Git 命令直接無差別抹除了 PG1 本地工作區的所有未提交修改，導致 PG1 辛勤寫好的降頻、鎖釋放等功能代碼全數丟失。

---

## 2. 根本原因分析 (Root Cause Analysis)
1. **物理工作區共享機制 (Shared Workspace)**：
   雖然專案在邏輯上採用了嚴格的 **角色寫入權限鎖定 (Role-Based File Locks)**（SA 禁寫 `src/`，PG 禁寫 `specs/`），但在實體主機上，多個 AI 代理人是**共享同一個物理專案目錄（Working Directory）**。
2. **Git Reset --Hard 的無差別抹除特性**：
   `git reset --hard` 的運作本質是將整個物理工作區同步至指定 Commit 狀態。Git 無法識別該修改是屬於 SA 還是 PG，會無條件清空所有 `uncommitted changes`。
3. **指令操作缺乏精確性 (Lack of Command Precision)**：
   SA1 在遇到規格回退需求時，貪圖快速，使用了波及全域的 `git reset --hard`，而未採用僅限於 specs 目錄的微觀還原指令（如 `git restore specs/`）。

---

## 3. 未來防禦措施 (Action Items)

### 🛡️ 措施 A：SA 側 — 實施「微觀精準還原」鐵律
* **原則**：SA 角色在進行規格修正或版本退回時，**絕對禁止執行 `git reset --hard`、`git clean -fd` 等全局重設與清理指令**。
* **執行標準**：若需退回，僅限使用指向精確路徑的還原指令：
  ```bash
  # 僅允許還原特定規格書目錄
  git restore specs/
  # 或精確到單一規格檔案
  git restore specs/P2_Design/SDD-Spec.md
  ```

### 🛡️ 措施 B：專案規則檔實體卡控 (Systemic Constraints)
* **落實**：已於專案最高規則檔 [.agents/AGENTS.md](file:///C:/PIC/AI-tools/claude-marketplace/pic-agent-call/.agents/AGENTS.md) 中，將「Git 破壞防禦線」明文寫入 System Prompt。未來的任何對話 session，AI 代理人啟動時皆會加載此指令級卡控。

### 🛡️ 措施 C：PG 側 — 實施「微觀 Commit/Stash」防線
* **原則**：PG 代理人或任何執行代碼修改的角色，在暫停工作或等待交接時，應養成**隨手暫存**的習慣：
  * 修改到一定階段，立即執行 `git add .` 與 `git commit`（可使用臨時的 WIP commit）。
  * 或執行 `git stash` 將工作區修改安全推入 Git 暫存棧中，以防被外部工具 reset 抹除。

---

## 4. 總結
本專案採用 SDD 模式，雖然成功卡控了「檔案寫入工具」的角色權限，但本次事件表明，**「終端機指令工具 (run_command)」同樣具備跨邊界破壞力**。所有代理人必須以此為鑑，指令操作必須具備精確路徑指向性，嚴防全局破壞性命令。
