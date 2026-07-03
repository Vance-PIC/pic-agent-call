#!/usr/bin/env node
// bin/register.mjs — Option D Lite v2 前台短行程 Registration Adapter
// 只負責環境捕獲與呼叫共享 registerAgent()，禁止直連 SQLite（SDD-Spec.md §5.3）
'use strict';

import { setup } from '../src/db.mjs';
import { registerAgent, resolveSessionId } from '../src/status.mjs';

function parseArgs(argv) {
    const args = { agentId: null, force: false, role: null, timeout: undefined };
    const rest = [];
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--force') { args.force = true; continue; }
        if (a === '--role') { args.role = argv[++i]; continue; }
        if (a === '--timeout') { args.timeout = Number(argv[++i]); continue; }
        rest.push(a);
    }
    args.agentId = rest[0] || null;
    return args;
}

function fail(reason, message) {
    process.stderr.write(JSON.stringify({ success: false, reason, message }) + '\n');
    process.exit(1);
}

async function main() {
    const { agentId, force, role, timeout } = parseArgs(process.argv.slice(2));

    if (!agentId) {
        fail('invalid_agent_id_format', '缺少 agent_id 參數。用法：node bin/register.mjs <agent_id> [--force] [--role <role>] [--timeout <minutes>]');
        return;
    }

    let target = process.env.PIC_TERM_KEY;
    if (!target) {
        target = process.env.WT_SESSION;
        if (target) {
            process.stderr.write('[WARN] PIC_TERM_KEY 未設定，fallback 使用 WT_SESSION。建議設定 PIC_TERM_KEY 作為主要視窗識別碼。\n');
        }
    }
    if (!target) {
        fail('term_key_required', '無法取得 PIC_TERM_KEY 或 WT_SESSION，請確認當前終端機環境變數已注入。');
        return;
    }

    const { db } = setup();
    const sessionId = resolveSessionId();

    const result = await registerAgent(db, sessionId, agentId, role || undefined, force, target, timeout);

    if (!result.success) {
        fail(result.reason, `註冊失敗：${result.reason}`);
        return;
    }

    process.stdout.write(JSON.stringify({
        success: true,
        registered_agents: result.registered_agents,
        term_key: result.term_key,
        forced: result.forced,
    }) + '\n');
    process.exit(0);
}

main().catch((err) => {
    fail('unexpected_error', err?.message || String(err));
});
