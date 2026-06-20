# @pic-ai/pic-agent-call

> Cross-AI MCP server — Memory · Channel · Task-Broker · Agent Identity

讓 Claude Code、Gemini CLI、Copilot、Codex 共享記憶、溝通、協作的 MCP server。

---

## Features

- **20 MCP tools** 涵蓋四大功能層
- **Memory** — 知識圖譜（SQLite），相容官方 MCP memory server schema
- **Channel** — 跨 AI 訊息傳遞，狀態機：UNREAD → IN_PROGRESS → READ / ORPHANED
- **Task-Broker** — 任務派發，feature+payload 冪等建立，BEGIN IMMEDIATE 原子搶鎖
- **Agent Identity** — `register_agent` / `agent_status`，per-session 身份管理與 statusline 顯示

---

## Requirements

- **Node.js >= 22.0.0**（需要 `node:sqlite` built-in module）

---

## Installation

### Option A: npm / npx

```bash
npm install @pic-ai/pic-agent-call
# or run directly without installing
npx @pic-ai/pic-agent-call
```

### Option B: Local path（推薦用於 `.mcp.json` 設定）

```bash
git clone https://github.com/Vance-PIC/pic-agent-call.git
cd pic-agent-call
npm install
```

---

## Configuration

### Claude Code (`.mcp.json`)

在專案根目錄建立 `.mcp.json`：

```json
{
  "mcpServers": {
    "agent-call": {
      "command": "node",
      "args": ["YOUR_PATH/pic-agent-call/bin/server.mjs"]
    }
  }
}
```

將 `YOUR_PATH` 替換為你的本地絕對路徑，例如 `/Users/yourname/projects/pic-agent-call`。

### Gemini CLI (`~/.gemini/config/mcp_config.json`)

```json
{
  "mcpServers": {
    "agent-call": {
      "command": "node",
      "args": ["YOUR_PATH/pic-agent-call/bin/server.mjs"]
    }
  }
}
```

### 環境變數

| Variable | Description | Default |
|----------|-------------|---------|
| `MEMORY_DB_PATH` | SQLite DB 路徑 | `.memory/memory-graph.db`（自動解析至 cwd 或 `~/.memory`）|
| `AGENT_ID` | Agent 識別名稱（可選，配合 `register_agent` 使用）| — |

DB 路徑解析優先序：`MEMORY_DB_PATH` env → `settings.local.json` → `cwd/.memory` → `~/.memory`

---

## Tools (20)

### Memory — Custom

| Tool | Description |
|------|-------------|
| `add-observation` | 向指定記憶實體寫入觀測紀錄。實體不存在時自動建立，並同步更新 JSON 快照。 |
| `query-entity` | 查詢指定記憶實體的完整資訊，含屬性、關係及所有歷程觀測紀錄。 |
| `stats` | 取得 SQLite 資料庫統計資訊（entities / relations / observations 筆數與路徑）。 |

### Memory — Official Compatible

相容 [官方 MCP memory server](https://github.com/modelcontextprotocol/servers/tree/main/src/memory) schema，可直接替換使用。

| Tool | Description |
|------|-------------|
| `create_entities` | 批次建立知識實體。同名實體已存在則忽略。 |
| `add_observations` | 向多個已存在實體添加觀測記錄。實體不存在則失敗。 |
| `create_relations` | 建立兩實體之間的單向關聯。實體不存在時自動建立臨時節點。 |
| `read_graph` | 讀取並匯出完整知識圖譜（所有實體、觀測紀錄及關係）。 |
| `search_nodes` | 模糊搜尋知識圖譜（範圍：實體名稱、類型、觀測紀錄內容）。 |

### Task-Broker

| Tool | Description |
|------|-------------|
| `create_task` | 建立任務。相同 feature+payload 具備冪等保護，不會重複建立。 |
| `list_pending_tasks` | 列出待處理任務。自動釋放逾時（>30 分鐘）的 claimed 任務。 |
| `claim_task` | 原子操作領取任務，BEGIN IMMEDIATE 確保排他性，防搶單。 |
| `complete_task` | 標記任務完成並寫回執行結果。任務須為 claimed 狀態。 |
| `fail_task` | 標記任務失敗並記錄原因。任務須為 claimed 狀態。 |
| `get_task` | 查詢單一任務的完整詳情。 |

### Channel

| Tool | Description |
|------|-------------|
| `channel_send` | 傳送訊息給指定 AI 視窗或 pool（receiver 支援具體 ID / 萬用字元 / `all`）。 |
| `channel_list_unread` | 列出指定接收者的未讀訊息。自動釋放逾時 IN_PROGRESS（>15 分鐘）。 |
| `channel_claim` | 原子搶鎖：將 UNREAD 訊息標記為 IN_PROGRESS。BEGIN IMMEDIATE 保證同一訊息只有一個視窗成功。 |
| `channel_ack` | 確認完成：將 IN_PROGRESS 訊息標記為 READ。只有搶鎖者才能 ACK。 |

### Agent Identity

| Tool | Description |
|------|-------------|
| `register_agent` | 登記或更新當前 AI 視窗的身份（`agent_id` + `role`）。`session_id` 自動從環境變數讀取。換角色時自動處理孤兒訊息並通知原始發送者。 |
| `agent_status` | 查詢當前 AI 視窗的身份與未讀訊息數量。`session_id` 自動讀取。 |

---

## Agent Identity & Statusline

`register_agent` 讓每個 AI session 具備獨立身份，供 Channel 路由與 statusline 顯示使用。

**Session ID 解析優先序：**

```
CLAUDE_CODE_SESSION_ID → ANTIGRAVITY_CONVERSATION_ID → AGENT_SESSION_ID → hostname-pid
```

**呼叫範例：**

```json
// Tool: register_agent
{
  "agent_id": "CC-SA1",
  "role": "SA"
}
```

**Statusline 顯示格式：**

```
[CC-SA1|SA] 📨3
```

表示 agent `CC-SA1`，角色 `SA`，有 3 則未讀訊息。

Claude Code 使用者可搭配 `bin/statusline.mjs` 將此資訊顯示在 statusbar（詳見 `bin/statusline.mjs`）。

---

## Multi-Agent Workflow Example

三步驟跨 AI 任務協作：

```
Step 1 — SA creates a task for PG:

  create_task(
    feature="auth-feature",
    assign_to="CC-PG1",
    payload='{"action":"implement login endpoint"}'
  )

Step 2 — PG polls and claims:

  list_pending_tasks(assign_to="CC-PG1")
  claim_task(task_id="...", agent_id="CC-PG1")

Step 3 — PG completes:

  complete_task(task_id="...", result='{"status":"done","pr":"#42"}')
```

完整跨平台中繼鏈（CC → Gemini）範例見 `skills/agent-call.md`。

---

## Development

```bash
npm test   # runs unit tests + P5 function tests
```

專案包含 unit tests（Jest）與 P5 功能驗收測試，測試報告產出至 `evidence/` 資料夾。

---

## License

MIT

---

## Project

- **GitHub**: https://github.com/Vance-PIC/pic-agent-call
- **npm**: https://www.npmjs.com/package/@pic-ai/pic-agent-call
