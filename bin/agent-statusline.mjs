#!/usr/bin/env node
// CC/AGY statusbar hook：查詢當前 agent 身份與未讀數，輸出一行
// v1.1.0：多角色並列顯示，格式 ▶🔴1·CC-PG1  🟢0·CC-SA1
// v1.1.1：直接以 session ID 查 DB，禁止掃描 agent-sessions/ fallback
// v1.1.2：agents.term_key 存 WT_SESSION；statusline 優先用 WT_SESSION 查 DB
import { setup } from '../src/db.mjs';
import { resolveSessionId, getRegistrationsByTermKey, getRegistrations, getAgentStatus } from '../src/status.mjs';

function exitNoAgent() { process.stdout.write('NO AGENT\n'); process.exit(0); }

let db, dbPath;
try {
    ({ db, dbPath } = setup());
} catch (_) {
    exitNoAgent();
}

const termKey = process.env.PIC_TERM_KEY || process.env.WT_SESSION;

// 主查詢：term_key（PIC_TERM_KEY / WT_SESSION）直查，跳過 session_id 中間層
let regs = null;
let querySessionId = null;

if (termKey) {
    try {
        regs = getRegistrationsByTermKey(db, termKey);
        if (regs && regs.length > 0) querySessionId = regs[0].session_id;
    } catch (_) {}
}

// fallback：term_key 查不到，改用 session_id 查（AGY 或無 term_key 環境）
if (!regs || regs.length === 0) {
    const callerType = process.env.CLAUDE_CODE_SESSION_ID ? 'cc'
        : process.env.ANTIGRAVITY_CONVERSATION_ID ? 'agy'
        : null;
    querySessionId = resolveSessionId(callerType);
    try {
        regs = getRegistrations(db, querySessionId);
    } catch (_) {}
}

if (!regs || regs.length === 0) {
    exitNoAgent();
}

// primaryAgentId 不傳入，由 getAgentStatus 自行從 DB status='active' 判斷
const status = getAgentStatus(db, querySessionId);
if (!status) {
    exitNoAgent();
}

process.stdout.write(status.display + '\n');
process.exit(0);
