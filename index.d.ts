import type { DatabaseSync } from 'node:sqlite';

// ── src/db.mjs ────────────────────────────────────────────────────────────────

export const IDENTITY: string;

export function resolveMemoryPaths(): { dbPath: string; jsonPath: string };

export function initDatabase(dbPath: string, jsonPath: string): DatabaseSync;

export function setup(options?: { dbPath?: string }): {
  db: DatabaseSync;
  dbPath: string;
  jsonPath: string;
};

export function syncDbToJson(db: DatabaseSync, jsonPath: string): void;

export function withRetry(fn: () => any, maxRetries?: number): Promise<any>;

// ── src/memory.mjs ────────────────────────────────────────────────────────────

export interface Entity {
  name: string;
  entityType: string;
  observations: string[];
}

export interface Relation {
  from: string;
  to: string;
  relationType: string;
}

export function addObservation(
  db: DatabaseSync,
  jsonPath: string,
  entityName: string,
  observationText: string
): Promise<void>;

export function queryEntity(
  db: DatabaseSync,
  entityName: string
): (Entity & { description?: string; version: number; relations: Relation[] }) | null;

export function getStats(
  db: DatabaseSync,
  dbPath: string
): { entities: number; relations: number; observations: number; dbPath: string };

export function createEntities(
  db: DatabaseSync,
  jsonPath: string,
  entities: Array<{ name: string; entityType: string; observations?: string[] }>
): Promise<void>;

export function addObservations(
  db: DatabaseSync,
  jsonPath: string,
  observations: Array<{ entityName: string; contents: string[] }>
): Promise<void>;

export function createRelations(
  db: DatabaseSync,
  jsonPath: string,
  relations: Array<{ from: string; to: string; relationType: string }>
): Promise<void>;

export function readGraph(db: DatabaseSync): { entities: Entity[]; relations: Relation[] };

export function searchNodes(
  db: DatabaseSync,
  query: string
): { entities: Entity[]; relations: Relation[] };

// ── src/channel.mjs ───────────────────────────────────────────────────────────

export interface Message {
  message_id: string;
  sender: string;
  receiver: string;
  priority: number;
  status: string;
  lock_owner: string | null;
  lock_time: string | null;
  message: string;
  created_at: string;
  updated_at: string;
}

export function sendMessage(
  db: DatabaseSync,
  receiver: string,   // 具體名稱 | pool? | 'any' | 'all'
  message: string,
  sender: string,
  sessionId?: string,
  priority?: number
): Promise<
  | { message_id: string; status: 'UNREAD' }
  | { message_id: string; status: 'UNREAD'; count: number; message_ids: string[] }
  | { message_id: null; status: 'NO_ACTIVE_RECEIVERS'; count: 0 }
>;

export function listUnread(
  db: DatabaseSync,
  receiver: string | null,
  sessionId?: string
): { messages: Message[]; count: number };

export function claimMessage(
  db: DatabaseSync,
  message_id: string,
  agent_id: string,
  sessionId?: string
): { success: true; message_id: string } | { success: false; reason: string };

export function ackMessage(
  db: DatabaseSync,
  message_id: string,
  agent_id: string,
  sessionId?: string
): { success: true; message_id: string } | { success: false; reason: string };

// ── src/tasks.mjs ─────────────────────────────────────────────────────────────

export interface Task {
  task_id: string;
  feature: string;
  assign_to: string;
  payload: string;
  type: 'task' | 'final';
  status: 'pending' | 'claimed' | 'completed' | 'failed';
  claimed_by: string | null;
  claimed_at: string | null;
  completed_at: string | null;
  result: string | null;
  fail_reason: string | null;
  relay_to: string | null;
  created_at: string;
  updated_at: string;
}

export function initAgentsTable(db: DatabaseSync): void;

export function createTask(
  db: DatabaseSync,
  feature: string,
  assign_to: string,
  payload: string,
  type?: 'task' | 'final',
  relay_to?: string
): Promise<
  | { task_id: string; status: string; type: string; idempotent: boolean }
  | { success: false; reason: string }
>;

export function listPendingTasks(
  db: DatabaseSync,
  assign_to?: string
): { tasks: Task[]; count: number };

export function claimTask(
  db: DatabaseSync,
  task_id: string,
  agent_id: string
): { success: true; task_id: string; claimed_by: string; claimed_at: string }
 | { success: false; reason: string; current_status?: string; claimed_by?: string };

export function completeTask(
  db: DatabaseSync,
  task_id: string,
  result: string
): Promise<
  | { success: true; task_id: string; status: 'completed'; completed_at: string }
  | { success: false; reason: string }
>;

export function failTask(
  db: DatabaseSync,
  task_id: string,
  fail_reason: string
): Promise<
  | { success: true; task_id: string; status: 'failed' }
  | { success: false; reason: string }
>;

export function getTask(
  db: DatabaseSync,
  task_id: string
): Task | { success: false; reason: 'not_found' | 'validation_error' };

// ── src/status.mjs ────────────────────────────────────────────────────────────

export function resolveSessionId(callerType?: 'cc' | 'agy' | null): string;

export function getRegistration(
  db: DatabaseSync,
  sessionId: string
): { agent_id: string; role: string; session_id: string } | null;

export function getRegistrations(
  db: DatabaseSync,
  sessionId: string
): Array<{ agent_id: string; role: string; session_id: string }>;

export function getRegistrationByAgentId(
  db: DatabaseSync,
  agentId: string
): { agent_id: string; role: string; session_id: string } | null;

export function findAgentIdConflict(
  db: DatabaseSync,
  agentId: string,
  sessionId: string
): { agent_id: string; session_id: string; role: string } | null;

export function handleOrphanedMessages(
  db: DatabaseSync,
  oldAgentId: string,
  newAgentId: string
): number;

export function registerAgent(
  db: DatabaseSync,
  sessionId: string,
  agentId: string,
  role?: string,
  forced?: boolean
):
  | { success: true; registered_agents: Array<{ agent_id: string; role: string | null }>; session_id: string; forced?: boolean; orphans_notified?: number }
  | { success: false; reason: string; conflict?: { agent_id: string; session_id: string; role: string } };

export function getAgentStatus(
  db: DatabaseSync,
  sessionId: string,
  primaryAgentId?: string | null
): {
  agent_id: string;
  role: string | null;
  unread: number;
  display: string;
  registered_agents: Array<{ agent_id: string; role: string | null; unread: number }>;
} | null;

export function getAgentsByPlatformStatus(
  db: DatabaseSync,
  platformPrefix: string
): Array<{ agent_id: string; role: string | null; status: string; unread: number }>;

export function cleanExpiredAgentSessionCache(db: DatabaseSync, sessionDir: string): void;
