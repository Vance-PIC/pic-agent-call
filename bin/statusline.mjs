#!/usr/bin/env node
// CC statusbar hook 用：查詢當前 session 的 agent 身份與未讀數，輸出一行，exit 0
import { setup } from '../src/db.mjs';
import { resolveSessionId, getRegistration, getAgentStatus } from '../src/status.mjs';

let db;
try {
    ({ db } = setup());
} catch (_) {
    process.stdout.write('[DB ERR]\n');
    process.exit(0);
}

const sessionId = resolveSessionId();
const reg = getRegistration(db, sessionId);

if (!reg) {
    process.stdout.write('[未登記]\n');
} else {
    const status = getAgentStatus(db, sessionId);
    process.stdout.write((status?.display ?? '[未知]') + '\n');
}

process.exit(0);
