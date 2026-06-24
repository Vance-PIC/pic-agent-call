#!/usr/bin/env node
// CC/AGY statusbar hook：查詢當前 agent 身份與未讀數，輸出一行
// v1.1.0：多角色並列顯示，格式 ▶🔴1·CC-PG1  🟢0·CC-SA1
// v1.1.1：直接以 session ID 查 DB，禁止掃描 agent-sessions/ fallback
// v1.1.2：agents.term_key 存 WT_SESSION；statusline 優先用 WT_SESSION 查 DB
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

const envSessionId = resolveSessionId(callerType);

// 決定查詢用的 session_id 與 primaryAgentId
// 順序：WT_SESSION 查 agents.term_key → envSessionId 查 agents.session_id
let querySessionId = envSessionId;
let primaryAgentId = null;

const wtSession = process.env.WT_SESSION;
if (wtSession) {
    try {
        const regByWt = db.prepare(
            'SELECT agent_id, session_id FROM agents WHERE term_key = ? ORDER BY created_at ASC LIMIT 1'
        ).get(wtSession);
        if (regByWt?.session_id) {
            querySessionId = regByWt.session_id;
            primaryAgentId = regByWt.agent_id;
        }
    } catch (_) {}
}

let regs = getRegistrations(db, querySessionId);
if ((!regs || regs.length === 0) && querySessionId !== envSessionId) {
    regs = getRegistrations(db, envSessionId);
    if (regs && regs.length > 0) querySessionId = envSessionId;
}

if (!regs || regs.length === 0) {
    exitNoAgent();
}

const status = getAgentStatus(db, querySessionId, primaryAgentId);
if (!status) {
    exitNoAgent();
}

process.stdout.write(status.display + '\n');
process.exit(0);
