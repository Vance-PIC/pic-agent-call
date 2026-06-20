# SDD-Spec — pic-agent-call v1.0.0

## 1. 專案概述

`@pic-ai/agent-call` 是跨 AI CLI 平台（CC、AGY、Copilot、Codex）共用的 MCP server。
提供三大功能層：Memory（知識圖譜）、Channel（跨代理人訊息）、Task-Broker（任務派發）。

- **Runtime**: Node.js >= 22.0.0（使用 `node:sqlite` 內建模組）
- **Protocol**: MCP（Model Context Protocol）via `@modelcontextprotocol/sdk`
- **Module format**: 純 ESM（`.mjs`）

---

## 2. 目錄結構

```
pic-agent-call/
├── specs/
│   ├── WBS.md
│   └── SDD-Spec.md         ← 本文件
├── src/
│   ├── db.mjs              ← DB 初始化、路徑解析、JSON 同步
│   ├── memory.mjs          ← entities / observations / relations
│   ├── channel.mjs         ← channel 訊息 CRUD
│   └── tasks.mjs           ← task broker + agents 表
├── bin/
│   └── server.mjs          ← MCP transport + 18 tools 註冊
├── tests/
├── evidence/
├── package.json
└── jest.config.js
```

---

## 3. DB Schema

沿用 `agent-call` 現有 schema，零遷移成本。

### 3.1 entities
| 欄位 | 型態 | 說明 |
|------|------|------|
| name | TEXT PK | 實體唯一名稱 |
| entityType | TEXT NOT NULL | 分類 |
| description | TEXT | 描述 |
| version | INTEGER DEFAULT 1 | 樂觀鎖版本號 |
| created_at | TEXT | ISO datetime |
| updated_at | TEXT | ISO datetime |
| last_written_by | TEXT NOT NULL | 寫入者身分 |

### 3.2 observations
| 欄位 | 型態 | 說明 |
|------|------|------|
| id | INTEGER PK AUTOINCREMENT | |
| entity_name | TEXT FK→entities | |
| observation | TEXT NOT NULL | 觀測內容 |
| created_at | TEXT | |
| last_written_by | TEXT NOT NULL | |

### 3.3 relations
| 欄位 | 型態 | 說明 |
|------|------|------|
| from_entity | TEXT FK→entities | |
| to_entity | TEXT FK→entities | |
| relationType | TEXT NOT NULL | |
| created_at | TEXT | |
| last_written_by | TEXT NOT NULL | |
| PK | (from_entity, to_entity, relationType) | |

### 3.4 tasks
| 欄位 | 型態 | 說明 |
|------|------|------|
| task_id | TEXT PK | uuid |
| feature | TEXT NOT NULL | |
| assign_to | TEXT NOT NULL | |
| payload | TEXT NOT NULL | JSON 字串 |
| type | TEXT DEFAULT 'task' | task\|final |
| status | TEXT DEFAULT 'pending' | pending\|claimed\|completed\|failed |
| claimed_by | TEXT | |
| claimed_at | TEXT | |
| completed_at | TEXT | |
| result | TEXT | |
| fail_reason | TEXT | |
| relay_to | TEXT | |
| payload_hash | TEXT NOT NULL UNIQUE | SHA-256 冪等保護 |
| created_at | TEXT | |
| updated_at | TEXT | |

### 3.5 agents
| 欄位 | 型態 | 說明 |
|------|------|------|
| agent_id | TEXT PK | |
| last_seen | TEXT | |
| status | TEXT DEFAULT 'offline' | active\|offline |
| agent_timeout_sec | INTEGER DEFAULT 120 | |
| poll_interval_sec | INTEGER DEFAULT 30 | |
| term_key | TEXT | terminal 識別鍵 |
| created_at | TEXT | |
| updated_at | TEXT | |

### 3.6 agent_collaboration_channel
| 欄位 | 型態 | 說明 |
|------|------|------|
| message_id | TEXT PK | uuid |
| sender | TEXT NOT NULL | |
| receiver | TEXT NOT NULL | |
| priority | INTEGER DEFAULT 5 | 1~10 |
| status | TEXT DEFAULT 'UNREAD' | UNREAD\|IN_PROGRESS\|READ |
| lock_owner | TEXT | |
| lock_time | TEXT | |
| message | TEXT NOT NULL | |
| created_at | TEXT | |
| updated_at | TEXT | |

---

## 4. 模組 API 規格

### 4.1 src/db.mjs

```js
// 路徑解析（優先序：MEMORY_DB_PATH env → settings.local.json → cwd/.memory → ~/.memory）
export function resolveMemoryPaths(): { dbPath: string, jsonPath: string }

// DB 初始化（建表、PRAGMA、自動遷移）
export function initDatabase(dbPath: string, jsonPath: string): DatabaseSync

// DB → JSON 快照原子同步
export function syncDbToJson(db: DatabaseSync, jsonPath: string): void

// 指數退避重試（SQLITE_BUSY 防護）
export async function withRetry(fn: () => any, maxRetries?: number): Promise<any>

// 寫入者身分常數
export const IDENTITY: string
```

### 4.2 src/memory.mjs

```js
// 新增觀測（實體不存在自動建立）
export async function addObservation(
  db, jsonPath, entityName, observationText
): Promise<void>

// 查詢實體完整資訊（null = 不存在）
export function queryEntity(db, entityName): EntityResult | null

// 統計資訊
export function getStats(db, dbPath): { entities, relations, observations, dbPath }

// 批次建立實體
export function createEntities(db, jsonPath, entities): void

// 批次新增觀測（實體須存在，否則 throw）
export function addObservations(db, jsonPath, observations): void

// 建立關聯
export function createRelations(db, jsonPath, relations): void

// 讀取完整圖譜
export function readGraph(db): GraphResult

// 模糊搜尋
export function searchNodes(db, query): GraphResult
```

### 4.3 src/channel.mjs

```js
// 傳送訊息
export function sendMessage(db, sender, receiver, message, priority)
  : { message_id, status: 'UNREAD' }

// 列出未讀（自動釋放逾時 IN_PROGRESS >15min）
export function listUnread(db, receiver)
  : { messages, count }

// 原子搶鎖
export function claimMessage(db, message_id, agent_id)
  : { success, message_id?, reason? }

// 確認完成
export function ackMessage(db, message_id, agent_id)
  : { success, message_id?, reason? }
```

### 4.4 src/tasks.mjs

```js
// agents 表初始化（由 db.mjs initDatabase 呼叫）
export function initAgentsTable(db): void

export function createTask(db, feature, assign_to, payload, type?, relay_to?): TaskResult
export function listPendingTasks(db, assign_to?): { tasks, count }
export function claimTask(db, task_id, agent_id): ClaimResult
export function completeTask(db, task_id, result): CompleteResult
export function failTask(db, task_id, fail_reason): FailResult
export function getTask(db, task_id): Task | ErrorResult
```

---

## 5. 錯誤碼定義

| 錯誤碼 | 說明 | 發生模組 |
|--------|------|----------|
| ERR_DATABASE_LOCKED | SQLITE_BUSY 超過最大重試 | db.mjs |
| ERR_ENTITY_NOT_FOUND | 查詢實體不存在 | memory.mjs |
| ERR_VALIDATION | 輸入參數不合法 | 所有模組 |
| ERR_NOT_FOUND | task / message 不存在 | tasks.mjs / channel.mjs |
| ERR_ALREADY_CLAIMED | task 已被領取 | tasks.mjs |
| ERR_INVALID_STATUS | task 狀態不符合操作前提 | tasks.mjs |
| ERR_RACE_CONDITION | channel claim 被搶先 | channel.mjs |

---

## 6. MCP Tools 清單（18 tools）

### Memory（客製化）
| Tool | 對應函式 |
|------|----------|
| add-observation | memory.addObservation |
| query-entity | memory.queryEntity |
| stats | memory.getStats |

### Memory（官方相容）
| Tool | 對應函式 |
|------|----------|
| create_entities | memory.createEntities |
| add_observations | memory.addObservations |
| create_relations | memory.createRelations |
| read_graph | memory.readGraph |
| search_nodes | memory.searchNodes |

### Task-Broker
| Tool | 對應函式 |
|------|----------|
| create_task | tasks.createTask |
| list_pending_tasks | tasks.listPendingTasks |
| claim_task | tasks.claimTask |
| complete_task | tasks.completeTask |
| fail_task | tasks.failTask |
| get_task | tasks.getTask |

### Channel
| Tool | 對應函式 |
|------|----------|
| channel_send | channel.sendMessage |
| channel_list_unread | channel.listUnread |
| channel_claim | channel.claimMessage |
| channel_ack | channel.ackMessage |

---

## 7. 輸入驗證規則

| 欄位 | 規則 |
|------|------|
| entityName | 1~100 字元，非空白 |
| observationText | 1~2000 字元，非空白 |
| feature | 1~100 字元，非空白 |
| assign_to | 1~50 字元，非空白 |
| agent_id | 1~100 字元，非空白 |
| payload | 非空白，UTF-8 <= 65536 bytes |
| fail_reason | 非空白，UTF-8 <= 1000 bytes |
| priority | integer 1~10 |
| type | 'task' \| 'final' |
