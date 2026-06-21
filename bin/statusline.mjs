#!/usr/bin/env node
// CC statusbar hook 用：查詢當前 session 的 agent 身份與未讀數，輸出一行，exit 0
import { setup } from '../src/db.mjs';
import { resolveSessionId, getRegistration, getAgentStatus } from '../src/status.mjs';

let db;
try {
    ({ db } = setup());
} catch (_) {
    process.stdout.write('NO AGENT\n');
    process.exit(0);
}

const sessionId = resolveSessionId();
const reg = getRegistration(db, sessionId);

if (!reg) {
    process.stdout.write('NO AGENT\n');
} else {
    const status = getAgentStatus(db, sessionId);
    const agentId = status?.agent_id ?? reg.agent_id;
    const unread = status?.unread ?? 0;
    const icon = unread > 0 ? '🔴' : '🟢';
    process.stdout.write(`${icon}${unread}·${agentId}\n`);
}

process.exit(0);
