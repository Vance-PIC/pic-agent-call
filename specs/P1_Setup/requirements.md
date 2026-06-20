# Requirements — pic-agent-call v1.0.0

## 1. 背景與動機

現有 `agent-call` 專案（v2.0.0）以 CJS + ESM bridge（`createRequire`）方式實作 MCP server，
業務邏輯散落在 `mcp-client.cjs` 與 `task-broker.cjs`，且包含 CLI `main()` 入口，職責不單一。

本專案目標：全面重寫為純 ESM 模組化架構，發布為標準 npm package。

---

## 2. 功能需求（Functional Requirements）

### FR-01 Memory 知識圖譜
- 支援建立、查詢、搜尋知識實體（entities）
- 支援新增觀測紀錄（observations）至實體
- 支援建立實體間關聯（relations）
- 支援匯出完整知識圖譜（read_graph）
- DB 變更後自動同步 JSON 快照（memory-graph.json）

### FR-02 Channel 跨代理人訊息
- 支援傳送訊息至指定 agent 或 pool（receiver 支援萬用字元 `?`）
- 支援列出未讀訊息（自動釋放逾時 IN_PROGRESS > 15 分鐘）
- 支援原子搶鎖（BEGIN IMMEDIATE 保證排他性）
- 支援 ACK 確認完成

### FR-03 Task-Broker 任務派發
- 支援建立任務（相同 feature+payload 冪等保護）
- 支援列出待處理任務（自動釋放逾時 claimed > 30 分鐘）
- 支援原子領取任務
- 支援標記完成 / 失敗
- 支援查詢單一任務詳情

### FR-04 MCP Protocol
- 完整實作 MCP 協議 via `@modelcontextprotocol/sdk`
- 提供 18 個 MCP tools（詳見 SDD-Spec.md §6）
- 支援 stdio transport

---

## 3. 非功能需求（Non-Functional Requirements）

### NFR-01 相容性
- Node.js >= 22.0.0（node:sqlite 內建）
- 零外部 DB 依賴（純 SQLite）
- 與現有 `agent-call` DB schema 100% 相容（無破壞性遷移）

### NFR-02 可發布性
- 發布為 `@pic-ai/agent-call` npm public package
- 支援 `npx -y @pic-ai/agent-call` 啟動
- AI CLI 設定格式：
  ```json
  { "mcpServers": { "agent-call": { "command": "npx", "args": ["-y", "@pic-ai/agent-call"] } } }
  ```

### NFR-03 跨平台
- Windows / macOS / Linux 均可運作
- DB 路徑動態解析（MEMORY_DB_PATH env → settings.local.json → cwd/.memory → ~/.memory）

### NFR-04 可靠性
- SQLITE_BUSY 指數退避重試（最多 20 次）
- Channel / Task 原子操作防止 Race Condition
- JSON 快照原子寫入（temp file + rename）

### NFR-05 可測試性
- 單元測試覆蓋率 >= 80%
- 整合測試透過 stdio JSON-RPC 驗證
- 測試 log 寫入 evidence/

---

## 4. 限制條件（Constraints）

- 純 ESM，禁止 `require()` / `module.exports`
- 禁止硬編碼路徑或設定值
- 禁止使用 `process.exit()` 於 library 層（只允許 server.mjs）
- 不重新設計 DB schema（沿用現有）

---

## 5. 驗收標準（Acceptance Criteria）

| # | 條件 |
|---|------|
| AC-01 | `npm test` 全部 PASS，覆蓋率 >= 80% |
| AC-02 | CC `.mcp.json` 掛載後顯示 18 tools |
| AC-03 | AGY `mcp_config.json` 掛載後工具可正常呼叫 |
| AC-04 | `npx -y @pic-ai/agent-call` 啟動無錯誤 |
| AC-05 | 與現有 `agent-call` DB（memory-graph.db）相容，資料不遺失 |
