# Storage Port Definitions (TypeScript / ES Module)

This file defines the programming interfaces (ports) for `pic-agent-call 2.0` storage decoupling. 

Implementations MUST map these logical signatures into their runtime context without exposing query-language details (such as SQL statements or ORM entities) to the coordination services.

---

## 1. Data Transfer Objects (DTOs)

```typescript
export interface AgentRegistration {
  agent_id: string;
  role: string | null;
  session_id: string | null;
  term_key: string;
  status: 'active' | 'attached' | 'offline';
  agent_timeout_sec: number;
  poll_interval_sec: number;
  last_seen: string | null; // ISO-8601 string representation
  created_at: string;
  updated_at: string;
}

export interface ChannelMessage {
  message_id: string;
  sender: string;
  receiver: string;
  priority: number;
  status: 'UNREAD' | 'IN_PROGRESS' | 'READ' | 'ORPHANED';
  lock_owner: string | null;
  lock_time: string | null;
  message: string;
  created_at: string;
  updated_at: string;
}

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
  payload_hash: string;
  created_at: string;
  updated_at: string;
}

export interface MemoryEntity {
  name: string;
  entityType: string;
  description: string | null;
  version: number;
  created_at: string;
  updated_at: string;
  last_written_by: string;
}

export interface MemoryRelation {
  from_entity: string;
  to_entity: string;
  relationType: string;
  created_at: string;
  last_written_by: string;
}

export interface MemoryObservation {
  id: number;
  entity_name: string;
  observation: string;
  created_at: string;
  last_written_by: string;
}

export interface MemoryGraph {
  entities: Array<{
    name: string;
    entityType: string;
    observations: string[];
  }>;
  relations: Array<{
    from: string;
    to: string;
    relationType: string;
  }>;
}

export interface StorageHealth {
  status: 'healthy' | 'unhealthy' | 'degraded';
  resolvedPath: string;
  stats?: {
    entities: number;
    relations: number;
    observations: number;
  };
  error?: string;
}
```

---

## 2. Storage Provider Interface

```typescript
export interface StorageProvider {
  agents: AgentStore;
  channels: ChannelStore;
  tasks: TaskStore;
  memories: MemoryStore;

  /**
   * Configure and initialize connection pools, run checks, and execute schema migrations.
   */
  initialize(): Promise<void>;

  /**
   * Run health diagnostics on the storage backend.
   */
  healthCheck(): Promise<StorageHealth>;

  /**
   * Gracefully close connections and flush any pending write tasks.
   */
  close(): Promise<void>;
}
```

---

## 3. Repositories (Store Interfaces)

### 3.1 Agent Store (`AgentStore`)
```typescript
export interface AgentStore {
  findAgentById(agentId: string): Promise<AgentRegistration | null>;
  
  findActiveAgentByTermKey(termKey: string): Promise<AgentRegistration | null>;
  
  findRegistrationsBySession(sessionId: string): Promise<AgentRegistration[]>;
  
  findRegistrationsByTermKey(termKey: string): Promise<AgentRegistration[]>;

  /**
   * Atomically save or update agent registrations, enforcing the status invariants.
   * If forced = true, conflicts are overridden.
   */
  saveRegistration(
    sessionId: string,
    agentId: string,
    role: string | null,
    forced: boolean,
    termKey: string,
    timeoutMin: number
  ): Promise<{
    success: boolean;
    registered_agents: Array<{ agent_id: string; role: string | null }>;
    session_id: string;
    forced: boolean;
    term_key: string;
    orphans_notified?: number;
  }>;

  deactivateSessionAgentsExcept(
    sessionId: string,
    termKey: string,
    activeAgentIds: string[]
  ): Promise<void>;

  sweepTimedOutAgents(): Promise<void>;

  purgeOfflineAgentsHistory(purgeThresholdMin: number): Promise<void>;

  updateHeartbeat(sessionId: string): Promise<void>;
}
```

### 3.2 Channel Store (`ChannelStore`)
```typescript
export interface ChannelStore {
  /**
   * Append a message to the coordination channel.
   * Supports 'all' broadcast (fanning out to all active agents except sender).
   */
  appendMessage(
    receiver: string,
    message: string,
    sender: string,
    priority?: number
  ): Promise<{
    message_id: string | null;
    status: 'UNREAD' | 'NO_ACTIVE_RECEIVERS';
    count?: number;
    message_ids?: string[];
  }>;

  findUnreadMessages(receivers: string[]): Promise<ChannelMessage[]>;

  /**
   * Atomically claim a message and set status = 'IN_PROGRESS'.
   */
  claimMessage(
    messageId: string,
    agentId: string
  ): Promise<{
    success: boolean;
    message_id?: string;
    reason?: string;
  }>;

  /**
   * Acknowledge a message and set status = 'READ'.
   */
  ackMessage(
    messageId: string,
    agentId: string
  ): Promise<{
    success: boolean;
    message_id?: string;
    reason?: string;
  }>;

  releaseExpiredClaims(timeoutMin: number): Promise<void>;
  
  resolveActiveAgentsByTarget(target: string): Promise<AgentRegistration[]>;
}
```

### 3.3 Task Store (`TaskStore`)
```typescript
export interface TaskStore {
  /**
   * Create a new task. Enforces idempotency against payload_hash.
   */
  createTask(
    feature: string,
    assignTo: string,
    payload: string,
    type?: 'task' | 'final',
    relayTo?: string
  ): Promise<{
    task_id: string;
    status: 'pending' | 'claimed' | 'completed' | 'failed';
    type: 'task' | 'final';
    idempotent: boolean;
  }>;

  findPendingTasks(assignTo?: string): Promise<Task[]>;

  /**
   * Atomically claim a task.
   */
  claimTask(
    taskId: string,
    agentId: string
  ): Promise<{
    success: boolean;
    task_id?: string;
    claimed_by?: string;
    claimed_at?: string;
    reason?: string;
  }>;

  completeTask(
    taskId: string,
    result: string
  ): Promise<{
    success: boolean;
    task_id: string;
    status?: 'completed';
    completed_at?: string;
    reason?: string;
  }>;

  failTask(
    taskId: string,
    failReason: string
  ): Promise<{
    success: boolean;
    task_id: string;
    status?: 'failed';
    reason?: string;
  }>;

  findTaskById(taskId: string): Promise<Task | null>;

  releaseExpiredTaskClaims(timeoutSeconds: number): Promise<void>;
}
```

### 3.4 Memory Store (`MemoryStore`)
```typescript
export interface MemoryStore {
  saveObservation(
    entityName: string,
    observationText: string
  ): Promise<void>;

  findEntityByName(entityName: string): Promise<{
    name: string;
    entityType: string;
    description: string | null;
    version: number;
    observations: string[];
    relations: Array<{ to_entity: string; relationType: string }>;
  } | null>;

  saveEntities(entities: Array<{
    name: string;
    entityType: string;
    observations?: string[];
  }>): Promise<void>;

  saveRelations(relations: Array<{
    from: string;
    to: string;
    relationType: string;
  }>): Promise<void>;

  readGraph(): Promise<MemoryGraph>;

  searchNodes(query: string): Promise<MemoryGraph>;
}
```
