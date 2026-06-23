#!/usr/bin/env node
// CC/AGY statusbar hook：查詢當前 agent 身份與未讀數，輸出一行
// v1.1.0：多角色並列顯示，格式 ▶🔴1·CC-PG1  🟢0·CC-SA1
import fs from 'node:fs';
import path from 'node:path';
import { setup } from '../src/db.mjs';
import { resolveSessionId, getRegistrations, getRegistrationByAgentId, getAgentStatus } from '../src/status.mjs';

let db, dbPath;
try {
    ({ db, dbPath } = setup());
} catch (_) {
    process.stdout.write('NO AGENT\n');
    process.exit(0);
}

const callerType = process.env.CLAUDE_CODE_SESSION_ID ? 'cc'
    : process.env.ANTIGRAVITY_CONVERSATION_ID ? 'agy'
    : null;

const sessionId = resolveSessionId(callerType);
let regs = getRegistrations(db, sessionId);

const sessionDir = path.join(path.dirname(dbPath), 'agent-sessions');
const prefixes = callerType === 'cc' ? ['cc-']
    : callerType === 'agy' ? ['agy-']
    : ['cc-', 'agy-'];

// fallback：掃 agent-sessions/ 取最新符合 callerType prefix 的快取檔
let primaryAgentIdFromCache = null;
if (!regs || regs.length === 0) {
    try {
        if (fs.existsSync(sessionDir)) {
            const files = fs.readdirSync(sessionDir)
                .filter(f => prefixes.some(p => f.startsWith(p)) && f.endsWith('.json'));
            let newest = null, newestMtime = 0;
            for (const f of files) {
                const fp = path.join(sessionDir, f);
                const mt = fs.statSync(fp).mtimeMs;
                if (mt > newestMtime) { newestMtime = mt; newest = fp; }
            }
            if (newest) {
                const data = JSON.parse(fs.readFileSync(newest, 'utf8'));
                if (data.agent_id) {
                    const fallbackReg = getRegistrationByAgentId(db, data.agent_id);
                    if (fallbackReg) {
                        regs = getRegistrations(db, fallbackReg.session_id);
                        primaryAgentIdFromCache = data.agent_id;
                    }
                }
            }
        }
    } catch (_) {}
}

if (!regs || regs.length === 0) {
    process.stdout.write('NO AGENT\n');
    process.exit(0);
}

// 若未從 fallback 讀出，嘗試從本 session 的快取讀 primary（最新修改時間的對應快取）
if (!primaryAgentIdFromCache) {
    try {
        if (fs.existsSync(sessionDir)) {
            const files = fs.readdirSync(sessionDir)
                .filter(f => prefixes.some(p => f.startsWith(p)) && f.endsWith('.json'));
            for (const f of files) {
                const fp = path.join(sessionDir, f);
                const data = JSON.parse(fs.readFileSync(fp, 'utf8'));
                if (data.session_id === sessionId && data.agent_id) {
                    primaryAgentIdFromCache = data.agent_id;
                    break;
                }
            }
        }
    } catch (_) {}
}

const sid = regs[0].session_id;
const status = getAgentStatus(db, sid, primaryAgentIdFromCache);
if (!status) {
    process.stdout.write('NO AGENT\n');
    process.exit(0);
}

process.stdout.write(status.display + '\n');
process.exit(0);
