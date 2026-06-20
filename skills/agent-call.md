# agent-call Skill

AI 自治通訊閉環操作指引（Memory MCP 知識層 + task-broker 任務層 + channel 訊息層）

---

## 概述

`agent-call` 封裝三層完整 AI 代理人自治通訊閉環：

| 層 | 工具 | 用途 |
|---|---|---|
| **知識層** | Memory MCP（`.memory/memory-graph.db`） | 共享狀態、設計決策、進度記錄 |
| **任務層** | task-broker | 跨平台任務指令傳遞（冪等、原子領取） |
| **訊息層** | channel | AI 代理人即時單向 / 廣播通訊 |

---

## 架構圖

```
人類 / AI 代理人
    │
    ├─ 知識層（Memory MCP）
    │   └─ CC / Gemini：mcp__agent-call__* tools（標準 MCP SDK）
    │
    ├─ 任務層（task-broker）
    │   ├─ create_task → list_pending_tasks → claim_task
    │   └─ complete_task / fail_task → relay_to（可選鏈）
    │
    └─ 訊息層（channel）
        ├─ channel_send → channel_list_unread
        └─ channel_claim → channel_ack
```

---

## 工具清單

### Memory 客製化

| 工具 | 說明 |
|---|---|
| `add-observation` | 寫入觀測紀錄（entityName 不存在自動建立） |
| `query-entity` | 查詢實體完整資訊（屬性 + 關係 + 觀測紀錄） |
| `stats` | DB 統計資訊（entities / relations / observations 筆數） |

### Memory 官方相容

| 工具 | 說明 |
|---|---|
| `create_entities` | 批次建立實體（同名已存在則忽略） |
| `add_observations` | 批次新增觀測（實體須預先存在） |
| `create_relations` | 建立實體單向關聯 |
| `read_graph` | 讀取完整知識圖譜 |
| `search_nodes` | 模糊搜尋圖譜（名稱 / 類型 / 觀測內容） |

### Task-Broker

| 工具 | 說明 |
|---|---|
| `create_task` | 建立任務（feature + payload 冪等保護） |
| `list_pending_tasks` | 列出待處理任務（自動釋放逾時 claimed） |
| `claim_task` | 原子領取任務（BEGIN IMMEDIATE，防搶單） |
| `complete_task` | 標記完成並寫回結果 |
| `fail_task` | 標記失敗並記錄原因 |
| `get_task` | 查詢任務完整詳情 |

### Channel

| 工具 | 說明 |
|---|---|
| `channel_send` | 傳送訊息（receiver 可為具體 ID / pool 萬用字元 / all） |
| `channel_list_unread` | 列出未讀訊息（自動釋放逾時 IN_PROGRESS） |
| `channel_claim` | 原子搶鎖（BEGIN IMMEDIATE） |
| `channel_ack` | 確認完成，將 IN_PROGRESS 標記為 READ |

---

## Entity 命名規則

| 用途 | Entity 名稱格式 |
|---|---|
| 任務進度 | `${Feature}-Progress` |
| 技術決策 | `${Feature}-TechDecisions` |
| 基礎設定 | `${Feature}-POC` |
| 框架改善 | `${Feature}-FrameworkImprovements` |

> 嚴禁建立自訂臨時 Entity（如 `MMG-P4-Handoff`）。

---

## 典型工作流

### 建立跨 AI 任務鏈

```
1. create_task        ← CC 建任務，assign_to="Gemini"
2. list_pending_tasks ← Gemini 輪詢
3. claim_task         ← Gemini 原子領取
4. [執行任務]
5. complete_task / fail_task
```

`type` 語意：

| type | 說明 |
|---|---|
| `task` | 執行後自動 relay 給 relay_to 對象（建立 type=final 任務） |
| `final` | 執行後鏈終止，不建新任務，防無限迴圈 |

### 知識沉澱

```
1. add-observation  ← entityName="Feature-Progress"，寫入發現
2. query-entity     ← 後續查詢完整觀測紀錄
```

### 即時通訊

```
1. channel_send        ← sender="CC-SA1", receiver="CC-PG1"
2. channel_list_unread ← receiver="CC-PG1" 輪詢
3. channel_claim       ← 原子搶鎖（agent_id="CC-PG1"）
4. [處理訊息]
5. channel_ack         ← message_id + agent_id
```

---

## 安裝

### 作為 MCP server 使用

在 `claude_desktop_config.json`（或 `settings.json`）中加入：

```json
{
  "mcpServers": {
    "agent-call": {
      "command": "node",
      "args": ["/path/to/pic-agent-call/bin/server.mjs"]
    }
  }
}
```

或使用 npm 全域安裝後以 `npx` 啟動：

```bash
npm install -g @pic-ai/agent-call
# 啟動指令
agent-call
```

### 環境變數

| 變數 | 說明 | 預設 |
|---|---|---|
| `MEMORY_DB_PATH` | 指定 SQLite DB 路徑 | 自動解析至專案 `.memory/memory-graph.db` |

---

## 完整通訊鏈範例

```
人類建 type=task 給 CC
    │
    ▼
CC claim_task → 執行 → complete_task
    │ (relay_to=Gemini)
    ▼
create_task(assign_to=Gemini, type=final)
    │
    ▼
Gemini claim_task → 執行 → complete_task
    │ (type=final → CHAIN_END)
    ▼
鏈終止
```

---

## 常見問題排解

| 問題 | 原因 | 解法 |
|---|---|---|
| `idempotent:true` | 相同 feature+payload 重複建立 | 更換 payload 內容或 feature 名稱 |
| task 一直是 pending | 沒有 worker 輪詢 | 確認有 agent 呼叫 `list_pending_tasks` + `claim_task` |
| channel_claim 失敗 | 已被其他 agent 搶鎖 | 正常現象，等待下一筆未讀訊息 |
| DB 路徑錯誤 | `MEMORY_DB_PATH` 未設或路徑不存在 | 確認路徑正確，或讓 server 自動初始化 |
