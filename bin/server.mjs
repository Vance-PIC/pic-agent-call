#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { resolveMemoryPaths, initDatabase } from '../src/db.mjs';
import * as memory from '../src/memory.mjs';
import * as channel from '../src/channel.mjs';
import * as tasks from '../src/tasks.mjs';
import {
    resolveSessionId,
    getRegistration,
    findAgentIdConflict,
    registerAgent,
    getAgentStatus,
    cleanExpiredAgentSessionCache,
} from '../src/status.mjs';

const { dbPath, jsonPath } = resolveMemoryPaths();
let db;
try {
    db = initDatabase(dbPath, jsonPath);
    process.stderr.write(`[pic-agent-call] DB: ${dbPath}\n`);
} catch (err) {
    process.stderr.write(`[pic-agent-call] DB init failed: ${err.message}\n`);
    process.exit(1);
}

const server = new McpServer({ name: 'pic-agent-call', version: '1.0.0' });

function text(str) { return { content: [{ type: 'text', text: String(str) }] }; }
function textJson(obj) { return text(JSON.stringify(obj, null, 2)); }
function errResult(msg) { return { content: [{ type: 'text', text: msg }], isError: true }; }

// ── Memory 客製化 ──────────────────────────────────────────────────────────────

server.tool('add-observation',
    '【客製化】向指定記憶實體寫入觀測紀錄。實體不存在時自動建立，並同步更新 JSON 快照。',
    { entityName: z.string().min(1).max(100).describe('記憶實體名稱'),
      observationText: z.string().min(1).max(2000).describe('觀測文字內容') },
    async ({ entityName, observationText }) => {
        await memory.addObservation(db, jsonPath, entityName.trim(), observationText.trim());
        return text(`✅ 已成功將 Observations 同步至 Memory 實體：${entityName.trim()}`);
    }
);

server.tool('query-entity',
    '【客製化】查詢指定記憶實體的完整資訊，含屬性、關係及所有歷程觀測紀錄。',
    { entityName: z.string().min(1).describe('要查詢的記憶實體名稱') },
    async ({ entityName }) => {
        const r = memory.queryEntity(db, entityName.trim());
        if (!r) return errResult(`❌ 找不到實體：${entityName.trim()}`);
        return textJson(r);
    }
);

server.tool('stats',
    '【客製化】取得 SQLite 資料庫統計資訊，包括 Entities、Relations、Observations 筆數與路徑。',
    {},
    async () => {
        const s = memory.getStats(db, dbPath);
        return text([
            '====================================',
            '🧠 SQLite Memory MCP 大腦統計資訊',
            '====================================',
            `- 知識實體 (Entities)    : ${s.entities}`,
            `- 關係節點 (Relations)   : ${s.relations}`,
            `- 觀察記錄 (Observations): ${s.observations}`,
            `- 資料庫路徑             : ${s.dbPath}`,
            '====================================',
        ].join('\n'));
    }
);

// ── Memory 官方相容 ────────────────────────────────────────────────────────────

server.tool('create_entities',
    '【官方相容】建立多個新的知識實體。同名實體已存在則忽略。',
    { entities: z.array(z.object({ name: z.string(), entityType: z.string(), observations: z.array(z.string()).optional() })) },
    async ({ entities }) => {
        await memory.createEntities(db, jsonPath, entities);
        return text(`✅ 已成功建立 ${entities.length} 個實體。`);
    }
);

server.tool('add_observations',
    '【官方相容】向多個已存在的知識實體添加新的觀測記錄。實體不存在則失敗。',
    { observations: z.array(z.object({ entityName: z.string(), contents: z.array(z.string()) })) },
    async ({ observations }) => {
        await memory.addObservations(db, jsonPath, observations);
        return text('✅ 已成功為指定的實體新增觀測值。');
    }
);

server.tool('create_relations',
    '【官方相容】在兩個實體之間建立單向關聯關係。實體不存在會自動建立臨時實體。',
    { relations: z.array(z.object({ from: z.string(), to: z.string(), relationType: z.string() })) },
    async ({ relations }) => {
        await memory.createRelations(db, jsonPath, relations);
        return text(`✅ 已成功建立 ${relations.length} 個實體關聯。`);
    }
);

server.tool('read_graph',
    '【官方相容】讀取並匯出當前完整的知識圖譜（含所有實體、觀測紀錄及關係）。',
    {},
    async () => textJson(memory.readGraph(db))
);

server.tool('search_nodes',
    '【官方相容】模糊搜尋知識圖譜。範圍涵蓋實體名稱、類型及觀測紀錄內容。',
    { query: z.string().describe('要搜尋的關鍵字') },
    async ({ query }) => textJson(memory.searchNodes(db, query))
);

// ── Task-Broker ────────────────────────────────────────────────────────────────

server.tool('create_task',
    '【task-broker】建立任務記錄。相同 feature+payload 的任務具備冪等保護，不會重複建立。',
    { feature: z.string().min(1).max(100), assign_to: z.string().min(1).max(50),
      payload: z.string().max(65536), type: z.enum(['task','final']).optional(),
      relay_to: z.string().max(50).optional() },
    async (args) => {
        const r = await tasks.createTask(db, args.feature, args.assign_to, args.payload, args.type, args.relay_to);
        return { content: [{ type: 'text', text: JSON.stringify(r) }], ...(r.success === false ? { isError: true } : {}) };
    }
);

server.tool('list_pending_tasks',
    '【task-broker】列出待處理（pending）任務。自動釋放逾時（>30 分鐘）的 claimed 任務。',
    { assign_to: z.string().optional() },
    async (args) => textJson(tasks.listPendingTasks(db, args.assign_to))
);

server.tool('claim_task',
    '【task-broker】原子操作領取任務，防搶單。BEGIN IMMEDIATE 交易確保排他性。',
    { task_id: z.string(), agent_id: z.string().min(1).max(100) },
    async (args) => {
        const r = tasks.claimTask(db, args.task_id, args.agent_id);
        return { content: [{ type: 'text', text: JSON.stringify(r) }], ...(r.success === false ? { isError: true } : {}) };
    }
);

server.tool('complete_task',
    '【task-broker】標記任務完成並寫回執行結果。任務須為 claimed 狀態。',
    { task_id: z.string(), result: z.string().max(65536) },
    async (args) => {
        const r = await tasks.completeTask(db, args.task_id, args.result);
        return { content: [{ type: 'text', text: JSON.stringify(r) }], ...(r.success === false ? { isError: true } : {}) };
    }
);

server.tool('fail_task',
    '【task-broker】標記任務失敗並記錄原因。任務須為 claimed 狀態。',
    { task_id: z.string(), fail_reason: z.string().max(1000) },
    async (args) => {
        const r = await tasks.failTask(db, args.task_id, args.fail_reason);
        return { content: [{ type: 'text', text: JSON.stringify(r) }], ...(r.success === false ? { isError: true } : {}) };
    }
);

server.tool('get_task',
    '【task-broker】查詢單一任務的完整詳情（不含 payload_hash）。',
    { task_id: z.string() },
    async (args) => {
        const r = tasks.getTask(db, args.task_id);
        return { content: [{ type: 'text', text: JSON.stringify(r) }], ...(r.success === false ? { isError: true } : {}) };
    }
);

// ── Channel ───────────────────────────────────────────────────────────────────

server.tool('channel_send',
    '【channel】傳送訊息給指定 AI 視窗或 pool。',
    { sender: z.string(), receiver: z.string(), message: z.string(),
      priority: z.number().min(1).max(10).optional() },
    async (args) => {
        const sessionId = resolveSessionId();
        return textJson(await channel.sendMessage(db, args.receiver, args.message, args.sender, sessionId, args.priority));
    }
);

server.tool('channel_list_unread',
    '【channel】列出指定接收者的未讀訊息。自動釋放逾時 IN_PROGRESS（>15 分鐘）。',
    { receiver: z.string() },
    async (args) => textJson(channel.listUnread(db, args.receiver))
);

server.tool('channel_claim',
    '【channel】原子搶鎖：將 UNREAD 訊息標記為 IN_PROGRESS。',
    { message_id: z.string(), agent_id: z.string() },
    async (args) => {
        const r = channel.claimMessage(db, args.message_id, args.agent_id);
        return { content: [{ type: 'text', text: JSON.stringify(r) }], ...(r.success === false ? { isError: true } : {}) };
    }
);

server.tool('channel_ack',
    '【channel】確認完成：將 IN_PROGRESS 訊息標記為 READ。只有搶鎖者才能 ACK。',
    { message_id: z.string(), agent_id: z.string() },
    async (args) => {
        const r = channel.ackMessage(db, args.message_id, args.agent_id);
        return { content: [{ type: 'text', text: JSON.stringify(r) }], ...(r.success === false ? { isError: true } : {}) };
    }
);

// ── Agent 身份管理 ────────────────────────────────────────────────────────────

function resolveTermKey() {
    const sessionId = resolveSessionId();
    if (sessionId.startsWith('cc-')) return `cc-${sessionId.slice(3, 11)}`;
    if (sessionId.startsWith('agy-')) return `agy-${sessionId.slice(4, 12)}`;
    if (sessionId.length === 36) {
        if (process.env.CLAUDE_CODE_SESSION_ID) return `cc-${sessionId.slice(0, 8)}`;
        return `agy-${sessionId.slice(0, 8)}`;
    }
    return `ppid-${process.ppid}`;
}

function writeAgentSessionCache(agentId, termKey) {
    try {
        const sessionDir = path.join(path.dirname(dbPath), 'agent-sessions');
        fs.mkdirSync(sessionDir, { recursive: true });
        const filePath = path.join(sessionDir, `${termKey}.json`);
        fs.writeFileSync(filePath, JSON.stringify({ agent_id: agentId, term_key: termKey, ts: new Date().toISOString() }), 'utf8');
        cleanExpiredAgentSessionCache(db, sessionDir);
    } catch (_) {}
}

server.tool('register_agent',
    '【agent】登記或更新當前 AI 視窗的身份（agent_id + role）。session_id 自動從環境變數讀取。若 agent_id 已被其他 session 占用，回傳 conflict 資訊供 AI 詢問 user。換角色時自動處理孤兒訊息並通知原始發送者。',
    {
        agent_id: z.string().min(1).max(50).describe('代理人識別碼，例如 CC-PG1'),
        role: z.string().max(50).optional().describe('角色標籤，例如 PG、SA、DevOps'),
        force: z.boolean().optional().describe('強制接管：true 時直接覆寫 DB 中的 session_id，忽略 conflict 檢查'),
    },
    async ({ agent_id, role, force }) => {
        const sessionId = resolveSessionId();

        // 檢查 agent_id 是否被其他 session 占用
        const conflict = findAgentIdConflict(db, agent_id, sessionId);
        if (conflict && !force) {
            return textJson({
                conflict: true,
                occupied_by_session: conflict.session_id,
                current_role: conflict.role,
                debug_sessionId: sessionId,
                debug_homedir: os.homedir(),
                message: `agent_id "${agent_id}" 已被另一個 session（${conflict.session_id}）占用。請選擇其他 agent_id，或確認該 session 是否已失效。若確定舊 session 已死，可用 force=true 強制接管。`,
            });
        }

        const result = registerAgent(db, sessionId, agent_id, role, force && !!conflict);

        // 同步寫入本地快取（供 statusline hook 識別身分）
        const termKey = resolveTermKey();
        writeAgentSessionCache(agent_id, termKey);

        return textJson({ ...result, term_key: termKey });
    }
);

server.tool('agent_status',
    '【agent】查詢當前 AI 視窗的身份與未讀訊息數量。session_id 自動讀取。',
    {},
    async () => {
        const sessionId = resolveSessionId();
        const reg = getRegistration(db, sessionId);

        if (!reg) {
            return textJson({
                registered: false,
                session_id: sessionId,
                message: '尚未登記身份，請呼叫 register_agent',
            });
        }

        const status = getAgentStatus(db, sessionId);
        return textJson({
            registered: true,
            ...status,
            session_id: sessionId,
        });
    }
);

// ── 啟動 ──────────────────────────────────────────────────────────────────────
const transport = new StdioServerTransport();
await server.connect(transport);
process.stderr.write('[pic-agent-call] 已啟動，等待連線...\n');
