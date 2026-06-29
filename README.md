# @pic-ai/pic-agent-call

> Cross-AI MCP server — Memory · Channel · Task-Broker · Agent Identity

讓 Claude Code、Gemini CLI、Copilot、Codex 共享記憶、溝通、協作的 MCP server。

---

## Features

- **20 MCP tools** 涵蓋四大功能層
- **Memory** — 知識圖譜（SQLite），相容官方 MCP memory server schema
- **Channel** — 跨 AI 訊息傳遞，狀態機：UNREAD → IN_PROGRESS → READ / ORPHANED
- **Task-Broker** — 任務派發，feature+payload 冪等建立，BEGIN IMMEDIATE 原子搶鎖
- **Agent Identity** — `register_agent` / `agent_status`，三態活躍模型（active/attached/offline），支援多角色並存與 settings.json 分鐘級參數自訂

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

### Claude Code（User-level，推薦）

在 `~/.claude/settings.json` 的 `mcpServers` 加入（user-level 跨專案共用）：

```json
{
  "mcpServers": {
    "pic-agent-call": {
      "command": "node",
      "args": ["YOUR_PATH/pic-agent-call/bin/server.mjs"]
    }
  }
}
```

將 `YOUR_PATH` 替換為你的本地絕對路徑，例如 `C:/projects/pic-agent-call`。

> 專案層級的 `.mcp.json` 可留空 `{"mcpServers":{}}` 或省略。

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
| `settings.json` 配置 | 自訂配置參數 (分) | 支援 `agentTimeoutMin`(預設 1440), `statusLineFreshnessMin`(預設 120), `historyPurgeMin`(預設 10080)|
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
| `register_agent` | 登記或更新當前 AI 視窗的身份（`agent_id` + `role`）。`session_id` 自動讀取。支援多角色（逗號分隔）、`force` 強制接管、`wt_session` 綁定 Windows Terminal、`timeout` 自訂超時秒數。`force=true` 時同 session 不在新名單的殘留角色自動軟離線（`status=offline`）。 |
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
🔴3·CC-SA1
```

表示 active 主角色 `CC-SA1` 有 3 則未讀訊息（無未讀時為 `🟢0·CC-SA1`）。
  
  **狀態列三態燈號與新鮮度定義：**
  * **主/從身份標示**：主角色前置 `▶` 標示，附屬/掛載角色 (`attached`) 僅顯示其燈號與未讀數。
  * **🟢 綠燈**：在線且無未讀訊息。
  * **🔴 紅燈**：在線且有未讀訊息。
  * **🟡 黃燈**：閒置角色（超過 `statusLineFreshnessMin` 設定時間未更新心跳，預設 120 分鐘）。
  * **自動清理**：離線角色超過 `historyPurgeMin` 分鐘（預設 7 天）將自動從 DB 清除。

Claude Code 使用者可搭配 `bin/agent-statusline.mjs` 將此資訊顯示在 statusbar 中。

### Statusline 設定指南

#### 1. 前置條件
- **註冊身份**：在啟用狀態列之前，當前 AI Session 必須先呼叫 `register_agent` 成功登記身份（`agent_id` + `role`）。
- **啟用 MCP 伺服器**：MCP 伺服器 `pic-agent-call` 必須已正確載入，且在各平台的啟用列表（如 `enabledMcpjsonServers` 或設定檔）中。

#### 2. bin/agent-statusline.mjs 說明
`bin/agent-statusline.mjs` 是一個輕量級的查詢工具，它會執行以下操作：
1. 自動解析當前 Session ID。
2. 查詢 SQLite 大腦資料庫（`memory-graph.db`）中的 `agents` 表與 `agent_collaboration_channel` 通訊資料表。
3. 取得當前代理人身份與未讀訊息數量，輸出格式為 `🟢0·CC-PG1`（有未讀時為 `🔴3·CC-PG1`），並以 `exit 0` 結束。
4. **狀態列整合應用**：直接由 CC `statusLine` 指令呼叫，綠燈代表無未讀，紅燈代表有未讀訊息待處理。

#### 3. Claude Code (CC) Statusline 設定
在 Claude Code 的全域設定檔（`~/.claude/settings.json`）中，加入 `"statusLine"` 欄位（值為字串指令）：

```json
{
  "statusLine": "bash bin/statusline.sh seg_brain"
}
```

> 若 CC 啟動目錄即為本專案根目錄，可用相對路徑 `bin/statusline.sh`。  
> 若從其他目錄啟動，改為絕對路徑（Windows 用正斜線，路徑有空格須加引號）。

> [!WARNING]
> **⚠️ 致命盲點與重要警告**
> 如果您的 `.claude/settings.local.json` 檔案中存在畸形或語法錯誤的 `Bash(...)` 規則（例如含有不當的雙引號或反斜線路徑，常見於 `/fewer-permission-prompts` 等自動化簡化授權的技能所產生的設定），**Claude Code 會在背景靜默跳過整個 settings 檔案**，導致您的 `statusLine` 配置被忽略且完全不執行，並且沒有任何錯誤提示。
> 若發現狀態列無法正常顯示，請務必優先檢查 `.claude/settings.local.json` 的 JSON 語法是否完全正確。

#### 4. Antigravity (AGY) Statusline 設定
在 Antigravity 終端機環境中，同樣支援掛載自訂狀態列。
請在全域設定 `~/.gemini/settings.json` 或最高優先級的 CLI 專屬設定 `~/.gemini/antigravity-cli/settings.json` 中配置 `statusLine`：

```json
{
  "statusLine": {
    "enabled": true,
    "type": "command",
    "command": "node C:\\Users\\<your_username>\\.gemini\\hooks\\statusline-quota.mjs"
  }
}
```

您可以使用專案內建的 `msg-statusline-wrapper`，或在自訂的 `statusline-quota.mjs` Hook 腳本中呼叫 `msg-statusline`，將其通訊狀態併入 Antigravity 的底部彩色狀態列中。同時，請記得在 `~/.gemini/trusted_hooks.json` 中將該 Hook 腳本加入安全性信任清單。

#### 5. setup-statusline Skill（快速安裝輔助）

本專案附帶一個 Claude Code skill，可引導你逐步完成上述設定：

**`~/.claude/skills/setup-statusline.md`**

**作用**：
- 逐步引導：前置條件確認 → settings.json 設定 → termKey 前綴驗證 → 測試輸出
- 提醒 settings.local.json 畸形規則的靜默失效陷阱
- 連結 [[cc-statusline-not-appearing]] 排查 skill（已壞才用）

**安裝方式**：
1. 複製 `skills/setup-statusline.md` 至 `~/.claude/skills/`
2. CC 中輸入 `/setup-statusline` 即可觸發

```bash
cp skills/setup-statusline.md ~/.claude/skills/setup-statusline.md
```

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
