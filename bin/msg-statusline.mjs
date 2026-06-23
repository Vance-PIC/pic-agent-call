#!/usr/bin/env node
// CC/AGY statusbar hook：查詢當前 agent 身份與未讀數，輸出一行
// v1.1.0：多角色並列顯示，格式 ▶🔴1·CC-PG1  🟢0·CC-SA1
// v1.1.1：直接以 session ID 查 DB，禁止掃描 agent-sessions/ fallback
import fs from 'node:fs';
import path from 'node:path';
import { setup } from '../src/db.mjs';
import { resolveSessionId, getRegistrations, getAgentStatus } from '../src/status.mjs';

function exitNoAgent() { process.stdout.write('NO AGENT\n'); process.exit(0); }

let db, dbPath;
try {
    ({ db, dbPath } = setup());
} catch (_) {
    exitNoAgent();
}

const callerType = process.env.CLAUDE_CODE_SESSION_ID ? 'cc'
    : process.env.ANTIGRAVITY_CONVERSATION_ID ? 'agy'
    : null;

const sessionId = resolveSessionId(callerType);
const regs = getRegistrations(db, sessionId);

if (!regs || regs.length === 0) {
    exitNoAgent();
}

// 從自己的 term_key.json 定點讀主身份（不掃最新，避免跨 terminal 污染）
let primaryAgentId = null;
if (callerType) {
    try {
        const prefix = callerType === 'cc' ? 'cc-' : 'agy-';
        const termKey = `${prefix}${sessionId.substring(0, 8)}`;
        const cacheFile = path.join(path.dirname(dbPath), 'agent-sessions', `${termKey}.json`);
        if (fs.existsSync(cacheFile)) {
            const data = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
            if (data.agent_id) primaryAgentId = data.agent_id;
        }
    } catch (_) {}
}

const status = getAgentStatus(db, sessionId, primaryAgentId);
if (!status) {
    exitNoAgent();
}

process.stdout.write(status.display + '\n');
process.exit(0);
