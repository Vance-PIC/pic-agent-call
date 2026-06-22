# API Spec (L2) — pic-agent-call v1.0.0

---

## src/db.mjs

```js
// 寫入者身分常數（PID + USER）
export const IDENTITY: string

// 頂層便利初始化（整合路徑解析 + DB 初始化）
// 回傳 { db, dbPath, jsonPath }
// 內部依序呼叫：resolveMemoryPaths() → initDatabase(dbPath, jsonPath)
// options.dbPath 指定時跳過路徑解析邏輯，直接使用指定路徑
export function setup(options?: { dbPath?: string }): {
  db: DatabaseSync,
  dbPath: string,
  jsonPath: string
}

// 路徑解析
// 優先序：MEMORY_DB_PATH env → settings.local.json → cwd/.memory → ~/.memory
export function resolveMemoryPaths(): { dbPath: string, jsonPath: string }

// DB 初始化（建表、PRAGMA WAL、foreign_keys、自動遷移）
export function initDatabase(dbPath: string, jsonPath: string): DatabaseSync

// DB → JSON 快照原子同步（v1.1.0 改為非同步防抖覆蓋）
// 內部實作需防抖 (500ms~1000ms)，並使用非同步 I/O 避免阻塞主執行緒
export function syncDbToJson(db: DatabaseSync, jsonPath: string): void

// 指數退避重試（SQLITE_BUSY / database is locked）
// maxRetries 預設 20，base 5ms
export async function withRetry(fn: () => any, maxRetries?: number): Promise<any>
```

---

## src/memory.mjs

```js
// 新增觀測（實體不存在時自動建立 entityType='unknown'）
export async function addObservation(
  db: DatabaseSync,
  jsonPath: string,
  entityName: string,    // 1~100 字元
  observationText: string // 1~2000 字元
): Promise<void>

// 查詢實體（不存在回傳 null）
export function queryEntity(
  db: DatabaseSync,
  entityName: string
): { name, entityType, description, version, observations: string[], relations: Relation[] } | null

// 統計
export function getStats(
  db: DatabaseSync,
  dbPath: string
): { entities: number, relations: number, observations: number, dbPath: string }

// 批次建立實體（同名已存在則 ignore）
export function createEntities(
  db: DatabaseSync,
  jsonPath: string,
  entities: Array<{ name: string, entityType: string, observations?: string[] }>
): void

// 批次新增觀測（實體不存在則 throw Error）
export function addObservations(
  db: DatabaseSync,
  jsonPath: string,
  observations: Array<{ entityName: string, contents: string[] }>
): void

// 建立關聯（實體不存在自動建立 entityType='unknown'）
export function createRelations(
  db: DatabaseSync,
  jsonPath: string,
  relations: Array<{ from: string, to: string, relationType: string }>
): void

// 讀取完整圖譜
export function readGraph(
  db: DatabaseSync
): { entities: Entity[], relations: Relation[] }

// 模糊搜尋（name / entityType / observation 欄位）
export function searchNodes(
  db: DatabaseSync,
  query: string
): { entities: Entity[], relations: Relation[] }
```

---

## src/channel.mjs

```js
// 傳送訊息
// ⚠️ v1.1.0 安全強化：移除 sender 參數。內部利用 resolveSessionId 獲取當前 sessionId
// 並從 DB 查詢對應登記的 agent_id 作為 sender 寫入。若未註冊則拋出 Error。
export function sendMessage(
  db: DatabaseSync,
  receiver: string,   // 具體名稱 | pool? | all
  message: string,
  priority?: number   // 1~10，預設 5
): { message_id: string, status: 'UNREAD' }

// 列出未讀（自動釋放 IN_PROGRESS > 15 分鐘 → UNREAD）
export function listUnread(
  db: DatabaseSync,
  receiver: string
): { messages: Message[], count: number }

// 原子搶鎖（BEGIN IMMEDIATE）
export function claimMessage(
  db: DatabaseSync,
  message_id: string,
  agent_id: string
): { success: true, message_id: string }
 | { success: false, reason: string }

// ACK 確認完成（lock_owner 須吻合）
export function ackMessage(
  db: DatabaseSync,
  message_id: string,
  agent_id: string
): { success: true, message_id: string }
 | { success: false, reason: string }
```

---

## src/tasks.mjs

```js
// agents 表初始化（內部函式，已整合至 db.mjs 的 initDatabase）
// 外部不需直接呼叫；保留 export 供測試隔離使用
export function initAgentsTable(db: DatabaseSync): void

// 建立任務（同 feature+payload 冪等）
export function createTask(
  db: DatabaseSync,
  feature: string,    // 1~100
  assign_to: string,  // 1~50
  payload: string,    // JSON 字串，<= 65536 bytes
  type?: 'task' | 'final',
  relay_to?: string   // <= 50
): { task_id, status: 'pending', type, idempotent: boolean }
 | { success: false, reason: string }

// 列出 pending 任務（自動釋放 claimed > 30 分鐘）
export function listPendingTasks(
  db: DatabaseSync,
  assign_to?: string
): { tasks: Task[], count: number }

// 原子領取任務（BEGIN IMMEDIATE）
export function claimTask(
  db: DatabaseSync,
  task_id: string,
  agent_id: string   // 1~100
): { success: true, task_id, claimed_by, claimed_at }
 | { success: false, reason, current_status?, claimed_by? }

// 標記完成
export function completeTask(
  db: DatabaseSync,
  task_id: string,
  result: string   // <= 65536 bytes
): { success: true, task_id, status: 'completed', completed_at }
 | { success: false, reason }

// 標記失敗
export function failTask(
  db: DatabaseSync,
  task_id: string,
  fail_reason: string   // <= 1000 bytes
): { success: true, task_id, status: 'failed' }
 | { success: false, reason }

// 查詢任務詳情
export function getTask(
  db: DatabaseSync,
  task_id: string
): Task | { success: false, reason: 'not_found' | 'validation_error' }
```

---

## src/status.mjs

```js
// 解析當前 session_id
// 優先序：CLAUDE_CODE_SESSION_ID → ANTIGRAVITY_CONVERSATION_ID → AGENT_SESSION_ID → hostname-pid
// ⚠️ v1.1.0 效能優化：支援在進程記憶體中快取解析出的會話 ID，避免重複的目錄掃描與磁碟 I/O
export function resolveSessionId(): string

// 以 session_id 查詢 agents 表
export function getRegistration(
  db: DatabaseSync,
  sessionId: string
): { agent_id: string, role: string, session_id: string } | null

// 偵測 agent_id 被其他 session 占用
export function findAgentIdConflict(
  db: DatabaseSync,
  agentId: string,
  sessionId: string
): { agent_id: string, session_id: string, role: string } | null

// 換角色時處理孤兒訊息：
// 1. 找舊 agent_id 所有 UNREAD 訊息
// 2. 對每個唯一 sender 發 SYSTEM channel 通知
// 3. 將孤兒訊息標記為 ORPHANED
// 回傳孤兒訊息數量
export function handleOrphanedMessages(
  db: DatabaseSync,
  oldAgentId: string,
  newAgentId: string
): number

// Upsert agent registration（以 session_id 為 key）
// 換 agent_id 時自動觸發孤兒訊息處理
export function registerAgent(
  db: DatabaseSync,
  sessionId: string,
  agentId: string,
  role?: string
): { success: true, agent_id, role, session_id, previous?: string, orphans_notified?: number }
 | { success: false, reason: string }

// 查詢 agent 狀態（給 statusline 用）
// display 格式：[CC-PG1|PG] 📨3
// unread 計算 SQL 條件：
//   status = 'UNREAD' AND (receiver = agent_id OR receiver = 'all' OR receiver = pool)
//   pool = role + '?'（e.g. agent_id='CC-PG1', role='PG' → pool='PG?'）
//   role 為 null 時只查 agent_id 與 'all'
export function getAgentStatus(
  db: DatabaseSync,
  sessionId: string
): { agent_id: string, role: string, unread: number, display: string } | null
```
