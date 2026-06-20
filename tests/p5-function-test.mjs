/**
 * P5 功能測試腳本 — MCP JSON-RPC over stdio
 * 啟動 bin/server.mjs，逐一送出 MCP 請求並驗證回應
 */
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..');
const EVIDENCE_DIR = path.join(PROJECT_ROOT, 'evidence');
const LOG_FILE = path.join(EVIDENCE_DIR, 'P5-function-test.log');

// 使用暫存 DB，避免汙染正式資料
const TEMP_DB = path.join(os.tmpdir(), `p5-test-${Date.now()}.db`);
const TEMP_JSON = path.join(os.tmpdir(), `p5-test-${Date.now()}.json`);

const REQUEST_TIMEOUT_MS = 5000;
const lines = [];

function log(line) {
    console.log(line);
    lines.push(line);
}

// ── 啟動 server ───────────────────────────────────────────────────────────────

function startServer() {
    return new Promise((resolve, reject) => {
        const child = spawn(process.execPath, ['bin/server.mjs'], {
            cwd: PROJECT_ROOT,
            stdio: ['pipe', 'pipe', 'pipe'],
            env: {
                ...process.env,
                MEMORY_DB_PATH: TEMP_DB,
                MEMORY_JSON_PATH: TEMP_JSON,
            },
        });

        let started = false;

        child.stderr.on('data', (chunk) => {
            const msg = chunk.toString();
            if (!started && msg.includes('已啟動')) {
                started = true;
                resolve(child);
            }
        });

        child.on('error', reject);

        child.on('exit', (code) => {
            if (!started) reject(new Error(`Server exited prematurely (code ${code})`));
        });

        // 最長等 8 秒
        setTimeout(() => {
            if (!started) reject(new Error('Server start timeout'));
        }, 8000);
    });
}

// ── 單次請求 / 回應 ──────────────────────────────────────────────────────────

function sendRequest(child, rl, req) {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Request timeout')), REQUEST_TIMEOUT_MS);

        rl.once('line', (raw) => {
            clearTimeout(timer);
            try { resolve(JSON.parse(raw)); }
            catch (e) { reject(new Error(`Bad JSON: ${raw}`)); }
        });

        child.stdin.write(JSON.stringify(req) + '\n');
    });
}

// ── 斷言輔助 ────────────────────────────────────────────────────────────────

function getText(resp) {
    try { return resp?.result?.content?.[0]?.text ?? ''; }
    catch { return ''; }
}

function getJsonResult(resp) {
    try { return JSON.parse(getText(resp)); }
    catch { return null; }
}

// ── 測試執行 ────────────────────────────────────────────────────────────────

async function runTests() {
    const results = [];
    let child, rl;

    try {
        child = await startServer();
    } catch (err) {
        log(`[P5] FATAL: 無法啟動 server — ${err.message}`);
        return;
    }

    rl = createInterface({ input: child.stdout });

    async function test(name, req, check) {
        try {
            const resp = await sendRequest(child, rl, req);
            const ok = check(resp);
            const label = ok ? 'PASS' : 'FAIL';
            log(`[P5] ${name.padEnd(30)} ${label}`);
            results.push({ name, ok, resp });
        } catch (err) {
            log(`[P5] ${name.padEnd(30)} FAIL  (${err.message})`);
            results.push({ name, ok: false, err: err.message });
        }
    }

    // 1. initialize
    await test('initialize', {
        jsonrpc: '2.0', id: 1, method: 'initialize',
        params: {
            protocolVersion: '2024-11-05',
            capabilities: {},
            clientInfo: { name: 'p5-test', version: '1.0' },
        },
    }, (r) => r?.result?.serverInfo?.name === 'pic-agent-call');

    // 2. tools/list — 需 >= 20 個 tools
    await test('tools/list (>= 20)', {
        jsonrpc: '2.0', id: 2, method: 'tools/list', params: {},
    }, (r) => {
        const count = r?.result?.tools?.length ?? 0;
        log(`[P5]   → tools count: ${count}`);
        return count >= 20;
    });

    // 3. stats
    await test('stats', {
        jsonrpc: '2.0', id: 3, method: 'tools/call',
        params: { name: 'stats', arguments: {} },
    }, (r) => {
        const t = getText(r);
        return t.includes('Entities') || t.includes('entities');
    });

    // 4. add-observation
    await test('add-observation', {
        jsonrpc: '2.0', id: 4, method: 'tools/call',
        params: {
            name: 'add-observation',
            arguments: { entityName: 'p5-test', observationText: '功能測試' },
        },
    }, (r) => {
        const t = getText(r);
        return t.includes('✅') || t.toLowerCase().includes('success') || t.includes('p5-test');
    });

    // 5. query-entity — 確認包含 '功能測試'
    await test('query-entity', {
        jsonrpc: '2.0', id: 5, method: 'tools/call',
        params: { name: 'query-entity', arguments: { entityName: 'p5-test' } },
    }, (r) => getText(r).includes('功能測試'));

    // 6. register_agent
    await test('register_agent', {
        jsonrpc: '2.0', id: 6, method: 'tools/call',
        params: {
            name: 'register_agent',
            arguments: { agent_id: 'TEST-P5', role: 'QA' },
        },
    }, (r) => {
        const j = getJsonResult(r);
        return j?.success === true || j?.conflict === true || !!j?.agent_id;
    });

    // 7. agent_status
    await test('agent_status', {
        jsonrpc: '2.0', id: 7, method: 'tools/call',
        params: { name: 'agent_status', arguments: {} },
    }, (r) => {
        const j = getJsonResult(r);
        return typeof j?.registered === 'boolean';
    });

    // 8. create_task — 取得 task_id
    let taskId = null;
    await test('create_task', {
        jsonrpc: '2.0', id: 8, method: 'tools/call',
        params: {
            name: 'create_task',
            arguments: { feature: 'p5', assign_to: 'TEST', payload: '{"test":true}' },
        },
    }, (r) => {
        const j = getJsonResult(r);
        taskId = j?.task_id ?? null;
        return !!taskId;
    });

    // 9. channel_send
    let msgId = null;
    await test('channel_send', {
        jsonrpc: '2.0', id: 9, method: 'tools/call',
        params: {
            name: 'channel_send',
            arguments: { sender: 'P5', receiver: 'TEST', message: 'ping' },
        },
    }, (r) => {
        const j = getJsonResult(r);
        msgId = j?.message_id ?? null;
        return !!msgId;
    });

    // 10. channel_list_unread
    await test('channel_list_unread', {
        jsonrpc: '2.0', id: 10, method: 'tools/call',
        params: { name: 'channel_list_unread', arguments: { receiver: 'TEST' } },
    }, (r) => {
        const j = getJsonResult(r);
        const count = Array.isArray(j) ? j.length : (j?.messages?.length ?? 0);
        log(`[P5]   → unread count: ${count}`);
        return count >= 1;
    });

    // ── 總結 ────────────────────────────────────────────────────────────────
    const pass = results.filter((r) => r.ok).length;
    const total = results.length;
    log('[P5] ================================');
    log(`[P5] ${pass}/${total} PASS`);

    // 清理
    child.stdin.end();
    child.kill();
    rl.close();

    // 清除暫存 DB
    try { fs.unlinkSync(TEMP_DB); } catch { /* ignore */ }
    try { fs.unlinkSync(TEMP_JSON); } catch { /* ignore */ }

    return { pass, total };
}

// ── Main ─────────────────────────────────────────────────────────────────────

const result = await runTests();

// 寫 evidence
if (!fs.existsSync(EVIDENCE_DIR)) fs.mkdirSync(EVIDENCE_DIR, { recursive: true });
const header = `P5 Function Test — ${new Date().toISOString()}\n${'='.repeat(50)}\n`;
fs.writeFileSync(LOG_FILE, header + lines.join('\n') + '\n');
console.log(`\n[P5] Evidence saved: ${LOG_FILE}`);

// exit code
process.exit(result && result.pass === result.total ? 0 : 1);
