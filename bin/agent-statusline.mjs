#!/usr/bin/env node
// CC/AGY statusbar hook：查詢當前 agent 身份與未讀數，輸出一行
// v1.1.0：多角色並列顯示，格式 ▶🔴1·CC-PG1  🟢0·CC-SA1
// v1.1.1：直接以 session ID 查 DB，禁止掃描 agent-sessions/ fallback
// v1.1.2：agents.term_key 存 WT_SESSION；statusline 優先用 WT_SESSION 查 DB
// v1.2.2：target 多態定位，優先 PIC_TERM_KEY，fallback session_id
import { setup } from '../src/db.mjs';
import { resolveSessionId, getAgentStatus } from '../src/status.mjs';

function exitNoAgent() { process.stdout.write('NO AGENT\n'); process.exit(0); }

let db;
try {
    ({ db } = setup());
} catch (_) {
    exitNoAgent();
}

// target 優先序：PIC_TERM_KEY → session_id（AGY/CC 環境變數）
const target = process.env.PIC_TERM_KEY
    || resolveSessionId(process.env.CLAUDE_CODE_SESSION_ID ? 'cc' : process.env.ANTIGRAVITY_CONVERSATION_ID ? 'agy' : null)
    || '';

if (!target) exitNoAgent();

let status;
try {
    status = getAgentStatus(db, target);
} catch (_) {}

if (!status || !status.registered) exitNoAgent();

process.stdout.write(status.display + '\n');
process.exit(0);
