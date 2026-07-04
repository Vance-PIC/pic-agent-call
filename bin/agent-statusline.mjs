#!/usr/bin/env node
// CC/AGY statusbar hook：查詢當前 agent 身份與未讀數，輸出一行
// v1.1.0：多角色並列顯示，格式 ▶🔴1·CC-PG1  🟢0·CC-SA1
// v1.1.1：直接以 session ID 查 DB，禁止掃描 agent-sessions/ fallback
// v1.1.2：agents.term_key 存 WT_SESSION；statusline 優先用 WT_SESSION 查 DB
// v1.3.0：還原 PIC_TERM_KEY 優先，移除 AGY 平台分支（SDD-Spec.md §9）；
//         PIC_TERM_KEY 為 CLI 子行程天然繼承之 trusted term_key，與 register_agent 同源
import { setup } from '../src/db.mjs';
import { resolveSessionId, getAgentStatus } from '../src/status.mjs';

function exitNoAgent() { process.stdout.write('NO AGENT\n'); process.exit(0); }

let db;
try {
    ({ db } = setup());
} catch (_) {
    exitNoAgent();
}

const target = process.env.PIC_TERM_KEY || resolveSessionId() || '';

if (!target) exitNoAgent();

let status;
try {
    status = getAgentStatus(db, target);
} catch (_) {}

if (!status || !status.registered) exitNoAgent();

process.stdout.write(status.display + '\n');
process.exit(0);
