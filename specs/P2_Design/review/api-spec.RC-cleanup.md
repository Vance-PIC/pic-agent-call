# API Spec (L2) — pic-agent-call v1.2.2 RC Cleanup

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
// ⚠️ v1.1.0 安全與廣播強化 / v1.2.2 去 Session 直查：
// - sendMessage 改為直接驗證 sender 是否在 DB 中登記為活躍狀態，移除對 sessionId 的依賴。
// - 支援廣播與任意信箱類型：
//   - 若 receiver === 'all'，自動複製訊息並廣播分發給當前所有活躍狀態的 agent（status = 'active'，排除 sender 本身），各自寫入 receiver = 'agent_id' 的獨立記錄。
//   - 若 receiver === 'any'，直接寫入單筆 receiver = 'any' 記錄，採先搶先得機制。
export function sendMessage(
  db: DatabaseSync,
  receiver: string,   // 具體名稱 | pool? | any | all
  message: string,
  sender: string,     // 角色 ID
  priority?: number   // 1~10，預設 5
): { message_id: string, status: 'UNREAD' }

// 列出未讀（自動釋放 IN_PROGRESS > 15 分鐘 → UNREAD）
// ⚠️ v1.1.0 安全強化 / v1.2.2 優化：執行橫向越權檢驗與多態未讀查詢。
// - 增加必填參數 target (string)，移除對 sessionId 的依賴。
// - 內部以 target 執行多態解析獲取活躍角色，若指定了 receiver 則必須確認該 receiver 包含在該名單中，否則拋出 403。
export function listUnread(
  db: DatabaseSync,
  receiver: string | null,
  target: string
): { messages: Message[], count: number }

// 原子搶鎖（BEGIN IMMEDIATE）
// ⚠️ v1.1.0 安全強化 / v1.2.2 去 Session 化：
// - 操作者 agent_id 直接在 DB 中直查驗證其 status 是否為活躍（active/attached），不再比對 sessionId。
// - 訊息的接收者必須為該 agent_id（或其 role?、或 'any'），否則拒絕操作。
export function claimMessage(
  db: DatabaseSync,
  message_id: string,
  agent_id: string
): { success: true, message_id: string }
 | { success: false, reason: string }

// ACK 確認完成（lock_owner 須吻合）
// ⚠️ v1.1.0 安全強化 / v1.2.2 去 Session 化：
// - 操作者 agent_id 直接在 DB 中直查其活躍狀態（active/attached），不再比對 sessionId。
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
  assignTo?: string
): Promise<{ tasks: Task[], count: number }>

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
// callerType: 'cc' | 'agy' | null — 明確指定平台類型以決定讀哪個 env var；null 則自動偵測
export function resolveSessionId(callerType?: 'cc' | 'agy' | null): string

// 以 session_id 查詢 agents 表中所有已註冊的活躍角色
// 排序：created_at ASC 固定排序以避免狀態列 jitter；`status = active` 的角色以 `▶` 標示，但不依 active 狀態改變實體排序。
// active/attached/offline 三態取代舊 is_primary 欄位
export function getRegistrations(
  db: DatabaseSync,
  sessionId: string
): Array<{ agent_id: string, role: string, session_id: string, term_key: string | null, status: 'active' | 'attached' | 'offline' }>

// 以 session_id 查詢第一個已登記的活躍角色（向下相容單角色版本）
export function getRegistration(
  db: DatabaseSync,
  sessionId: string
): { agent_id: string, role: string, session_id: string, term_key: string | null } | null

// 以 term_key（PIC_TERM_KEY）查詢 agents 表中所有已註冊的活躍角色（v1.1.3 新增）
// statusline 優先使用此函式識別當前視窗的活躍角色；找不到才 fallback 至 getRegistrations
export function getRegistrationsByTermKey(
  db: DatabaseSync,
  termKey: string
): Array<{ agent_id: string, role: string, session_id: string, term_key: string }>

// 用 agent_id 查詢 registration（給 statusline fallback 用）
export function getRegistrationByAgentId(
  db: DatabaseSync,
  agentId: string
): { agent_id: string, role: string, session_id: string, term_key: string | null } | null

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
// 內部 transaction 專用 (無獨立 transaction / withRetry)
// @internal 僅供 registerAgent 內部 transaction 呼叫，不對外 export
function _handleOrphanedMessages(
  db: DatabaseSync,
  oldAgentId: string,
  newAgentId: string
): number
// 外部公開 API (自帶 withRetry 與 transaction 包裹)
export function handleOrphanedMessages(
  db: DatabaseSync,
  oldAgentId: string,
  newAgentId: string
): Promise<number>
// Upsert agent registration
// ⚠️ v1.1.0 支援多重角色 / v1.1.3 term_key 三道防線：
// - 參數 agentId 與 role 可接受逗號（半形 , 或全形 ，）、頓號（、）、分號（; 或 ；）、斜線（/）、加號（+）或空格等分隔的多個字串。
// - 系統內部使用正規表達式 `/[,\/\\+，、；;\s]+/` 分割為多個角色，各自執行三道防線 upsert 邏輯：
//   - 一道：session_id 命中 DB → UPDATE agents SET term_key = PIC_TERM_KEY（resume 換視窗）
//   - 二道：term_key（PIC_TERM_KEY）命中 DB → UPDATE agents SET session_id = <new_session_id>（同視窗新 session）
//   - 三道：兩者均不命中 → 若無 force，拋出 conflict 錯誤含診斷資訊
// - 平台前綴補全：不含 AGY-/CC- 前綴的角色代碼自動根據 session_id 類型補全。
// - forced=true 時強制接管：
//   1. 僅更新已被其他 session 占用的 agent_id 的 session_id 與 term_key 綁定，不影響舊 session 的其他角色。
//   2. **孤兒訊息精準判定**：只有當被強奪的 agent 原本綁定的 `term_key` 與當前傳入的 `termKey` **不同（跨 Terminal 視窗奪取）**時，
//      才將其 UNREAD 訊息孤兒化（ORPHANED）並通知發送者；若 `term_key` 相同（同視窗換 session 重新登記路徑），則保留訊息不予孤兒化。
//      3. **主角色指定**：將被 force 的 agent 設為 `status = 'active'`，同 session / term scope 內其他角色設為 `status = 'attached'`。
//      狀態列中角色順序固定依據註冊創建時間排序（created_at ASC），不隨主角色切換而位移。
// - 回傳註冊結果清單，含 forced 與 term_key 欄位。
export function registerAgent(
  db: DatabaseSync,
  sessionId: string,
  agentId: string,
  role?: string,
  forced?: boolean,
  target: string,     // 必填的視窗/定位標的 (v1.2.2)
  timeout?: number    // 存活超時時間（分鐘），預設為 1440 分鐘，寫入 DB 時自動乘以 60
): Promise<{ success: true, registered_agents: Array<{ agent_id: string, role: string }>, session_id: string, forced: boolean, term_key: string, orphans_notified?: number }
 | { success: false, reason: string }>


> RC Cleanup Note: `registerAgent(db, sessionId, agentId, role, forced, target, timeout)` 為 v1.2.2 相容簽名。下一版 SHOULD 改為 command object：`registerAgent(db, RegisterAgentCommand)`，避免 positional arguments 導致 `target` / `timeout` 誤傳。

---

## bin/register.mjs (Option D Lite v2 前台註冊 CLI)

前台短行程 CLI 註冊適配器，不直連 SQLite 執行 SQL，不直接寫 agents 表。

```bash
node bin/register.mjs <agent_id> [--force] [--role <role>] [--timeout <minutes>]
```

*   **職責與依賴**：
    1.  **環境捕獲**：自當前前台環境安全讀取 `process.env.PIC_TERM_KEY` 作為主要 `target`；僅在缺失時 MAY fallback 至 `process.env.WT_SESSION`，且必須輸出診斷警示。
    2.  **核心依賴**：動態載入並調用 `src/status.mjs` 中的 `registerAgent()` 共享應用服務。`src/status.mjs` 目前承擔 registration/status shared application module；未來可拆為獨立 `registration-service.mjs`。
    3.  **退出狀態**：
        - 註冊成功：以 `process.exit(0)` 退出。
        - 註冊失敗或參數驗證不合法：以 `process.exit(1)` 退出。

