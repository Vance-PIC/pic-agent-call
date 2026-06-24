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
// ⚠️ v1.1.0 安全與廣播強化：
// - MCP 工具層移除 sender 參數以防偽造。
// - sendMessage 調整為接收 sessionId，並在內部驗證 sender 是否與該 sessionId 對應的活躍角色（即本地快取 agent_id）吻合（SYSTEM 豁免）。
// - 支援廣播與任意信箱類型：
//   - 若 receiver === 'all'，自動複製訊息並廣播分發給當前所有活躍狀態的 agent（status = 'active'，排除 sender 本身），各自寫入 receiver = 'agent_id' 的獨立記錄。
//   - 若 receiver === 'any'，直接寫入單筆 receiver = 'any' 記錄，採先搶先得機制。
export function sendMessage(
  db: DatabaseSync,
  receiver: string,   // 具體名稱 | pool? | any | all
  message: string,
  sender: string,
  sessionId: string,
  priority?: number   // 1~10，預設 5
): { message_id: string, status: 'UNREAD' }

// 列出未讀（自動釋放 IN_PROGRESS > 15 分鐘 → UNREAD）
// ⚠️ v1.1.0 安全強化：執行橫向越權檢驗。
// - 若指定 receiver，該 receiver 必須為當前平台連線之本地快取 agent_id（當前活躍角色）或其對應之 role 郵箱，否則拋出安全性錯誤。其返回結果應包含發送給該 agent_id、其 role?、以及發送給 'any' 且狀態為 'UNREAD' 的訊息。
// - 若 receiver 未指定或為 'all'，則自動列出該 sessionId 所綁定之所有活躍角色之未讀訊息的聯集。
export function listUnread(
  db: DatabaseSync,
  receiver: string | null,
  sessionId: string
): { messages: Message[], count: number }

// 原子搶鎖（BEGIN IMMEDIATE）
// ⚠️ v1.1.0 安全強化：嚴格執行當前活躍身份校驗。
// - 操作者 agent_id 必須與該 sessionId 當前活躍角色（即本地快取 agent_id）完全吻合，否則拒絕。
// - 訊息的接收者必須為該 agent_id（或其 role?、或 'any'），否則拒絕操作。
export function claimMessage(
  db: DatabaseSync,
  message_id: string,
  agent_id: string,
  sessionId: string
): { success: true, message_id: string }
 | { success: false, reason: string }

// ACK 確認完成（lock_owner 須吻合）
// ⚠️ v1.1.0 安全強化：嚴格執行當前活躍身份與搶鎖者吻合校驗。
// - 操作者 agent_id 必須與該 sessionId 當前活躍角色（即本地快取 agent_id）完全吻合，且必須為原始搶鎖者，否則拒絕。
export function ackMessage(
  db: DatabaseSync,
  message_id: string,
  agent_id: string,
  sessionId: string
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

// 以 session_id 查詢 agents 表中所有已註冊的活跃角色
export function getRegistrations(
  db: DatabaseSync,
  sessionId: string
): Array<{ agent_id: string, role: string, session_id: string }>

// 用 agent_id 查詢 registration（給 statusline fallback 用）
export function getRegistrationByAgentId(
  db: DatabaseSync,
  agentId: string
): { agent_id: string, role: string, session_id: string } | null

// 偵測 agent_id 被其他 session 占用
export function findAgentIdConflict(
  db: DatabaseSync,
  agentId: string,
  sessionId: string
): { agent_id: string, session_id: string, role: string } | null

// 換角色時處理孤兒訊息：
// 1. 找舊 agent_id 所有 UNREAD 訊息
// 2. 對每個傳送者發 SYSTEM channel 通知
// 3. 將孤兒訊息標記為 ORPHANED
// 回傳孤兒訊息數量
export function handleOrphanedMessages(
  db: DatabaseSync,
  oldAgentId: string,
  newAgentId: string
): number

// Upsert agent registration
// ⚠️ v1.1.0 支援多重角色註冊與平台前綴自動補全：
// - 參數 agentId 與 role 可接受逗號（半形 , 或全形 ，）、頓號（、）、分號（; 或 ；）、斜線（/）、加號（+）或空格等分隔的多個字串（如 agentId = "PJM/PDM/SA"）。
// - 當 agentId 內含上述分隔符號時，系統內部必須使用正規表達式（如 `/[,\/\\+，、；;\s]+/`）正確分割並提取多個角色名稱。
// - 平台前綴補全：若提取出的角色代碼不含當前平台前綴（"AGY-" 或 "CC-"），應根據當前 session_id 自動補全前綴（如 "PJM" 補全為 "AGY-PJM"），並自動將該角色（如 "PJM"）作為該 row 的 role。
// - 在 DB 中，不再以 session_id 為 UNIQUE key 做覆寫，而是以 agent_id 作為 PRIMARY KEY 進行 upsert。
// - 若 role 未單獨傳入，預設從拆分後的 agent_id 去除平台前綴後填入（例如 AGY-PJM 的 role 為 PJM）。
// - forced=true 時強制接管：僅更新已被其他 session 占用的 agent_id 的綁定，不影響該舊 session 的其他角色。同時必須找出被搶角色原本所屬的舊 session 並同步修正其快取 JSON 檔中的活躍列表與主身份（若舊 session 被接管後已無活躍角色，則直接將其快取檔物理刪除），以防越權與狀態不一致。
// - 回傳註冊結果清單或主身份資訊。
export function registerAgent(
  db: DatabaseSync,
  sessionId: string,
  agentId: string,
  role?: string,
  forced?: boolean
): { success: true, registered_agents: Array<{ agent_id: string, role: string }>, session_id: string, orphans_notified?: number }
 | { success: false, reason: string }

// 查詢 agent 狀態（給 statusline 用）
// - display 格式改為各角色個別並列顯示，以空格區隔（不使用 | 符號）：主身份（當前活躍角色）固定排在首位且其前置加上 ▶ 標示，其餘角色依序並列（例如：▶🔴1·AGY-PJM  🟢0·AGY-PDM  🔴3·AGY-SA）。
// - unread 為該 sessionId 下所有活躍角色未讀數之總和。
// - registered_agents 回傳該 session 登記的所有活躍角色資訊。
export function getAgentStatus(
  db: DatabaseSync,
  sessionId: string
): {
  agent_id: string, // 首選/主角色
  role: string | null,
  unread: number,
  display: string,
  registered_agents: Array<{ agent_id: string, role: string | null, unread: number }>
} | null

// 🧹 v1.1.0 快取清理：自動清理 .memory/agent-sessions/ 目錄下的過期 JSON 檔案
// 對各平台（cc- / agy-）保留最新修改時間的一個 fallback 檔案，其餘檔案依據聚合對比標準進行清理：
// - 孤兒檔案（DB 無對應角色）且 mtime > 5 分鐘，一律刪除。
// - 關聯的所有角色均為 offline 且 last_seen > 24 小時，一律刪除。
export function cleanExpiredAgentSessionCache(
  db: DatabaseSync,
  sessionDir: string
): void
```

