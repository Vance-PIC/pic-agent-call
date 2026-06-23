#!/usr/bin/env node
// CC statusbar hook 用：查詢當前 agent 身份與未讀數，輸出一行，exit 0
// 策略：先嘗試 session ID 匹配，失敗則讀 agent-sessions/ 最新 cc-*.json 取 agent_id
import fs from 'node:fs';
import path from 'node:path';
import { setup } from '../src/db.mjs';
import { resolveSessionId, getRegistration, getAgentStatus } from '../src/status.mjs';

let db, dbPath;
try {
    ({ db, dbPath } = setup());
} catch (_) {
    process.stdout.write('NO AGENT\n');
    process.exit(0);
}

// 嘗試 session ID 直查
const sessionId = resolveSessionId();
let reg = getRegistration(db, sessionId);

// fallback：掃 agent-sessions/cc-*.json 取最新檔的 agent_id，再用 agent_id 查 DB
if (!reg) {
    try {
        const sessionDir = path.join(path.dirname(dbPath), 'agent-sessions');
        if (fs.existsSync(sessionDir)) {
            const files = fs.readdirSync(sessionDir)
                .filter(f => f.startsWith('cc-') && f.endsWith('.json'));
            let newest = null;
            let newestMtime = 0;
            for (const f of files) {
                const fp = path.join(sessionDir, f);
                const mt = fs.statSync(fp).mtimeMs;
                if (mt > newestMtime) { newestMtime = mt; newest = fp; }
            }
            if (newest) {
                const data = JSON.parse(fs.readFileSync(newest, 'utf8'));
                if (data.agent_id) {
                    reg = db.prepare(
                        'SELECT agent_id, role, session_id FROM agents WHERE agent_id = ?'
                    ).get(data.agent_id) || null;
                }
            }
        }
    } catch (_) {}
}

if (!reg) {
    process.stdout.write('NO AGENT\n');
} else {
    const status = getAgentStatus(db, reg.session_id);
    const agentId = status?.agent_id ?? reg.agent_id;
    const unread = status?.unread ?? 0;
    const icon = unread > 0 ? '🔴' : '🟢';
    process.stdout.write(`${icon}${unread}·${agentId}\n`);
}

process.exit(0);
