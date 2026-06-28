#!/usr/bin/env node
// 狀態列整合包裝器：拼裝 Quota 狀態與 Agent 訊息狀態（quota + agent 並行執行）
import { execFile } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import readline from 'node:readline';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const TIMEOUT_MS = 1500;

function spawnNode(args, opts) {
  return new Promise((resolve) => {
    const child = execFile(process.execPath, args, { encoding: 'utf8', timeout: TIMEOUT_MS, ...opts }, (err, stdout) => {
      resolve(err ? '' : stdout);
    });
    if (opts?.input) { child.stdin.write(opts.input); child.stdin.end(); }
  });
}

const getMetadata = () => new Promise((resolve) => {
  const rl = readline.createInterface({ input: process.stdin, terminal: false });
  let resolved = false;
  rl.on('line', (line) => { resolved = true; rl.close(); resolve(line); });
  setTimeout(() => { if (!resolved) { rl.close(); resolve(''); } }, 50);
});

const stdinData = await getMetadata();

// 從 env 直接讀取，不依賴 stdin
let convId = process.env.ANTIGRAVITY_CONVERSATION_ID ?? '';

// ⚠️ [修正 v1.1.4]：若 env 中無 conversation_id，從 stdinData (metadata) 中動態解析以打破 AGY 平台初始化死結
if (!convId && stdinData) {
  try {
    const meta = JSON.parse(stdinData);
    if (meta?.conversation_id) {
      convId = meta.conversation_id;
    }
  } catch (_) {}
}

const cwd = process.env.PWD ?? process.cwd();
const bin = path.join(__dirname, 'agent-statusline.mjs');
const quotaScript = path.join(homedir(), '.gemini', 'antigravity-cli', 'plugins', 'antigravity-cli-statusline', 'scripts', 'statusline-quota.mjs');
const dbCandidate = cwd ? path.join(cwd, '.memory', 'memory-graph.db') : '';
const memoryDbPath = dbCandidate && existsSync(dbCandidate) ? dbCandidate : (process.env.MEMORY_DB_PATH || '');

let quotaOut = '';
let agentOut = '';

function outputAndExit() {
  const quotaLines = quotaOut ? quotaOut.trimEnd().split('\n') : [];
  const agentTag = agentOut.trim();
  if (quotaLines.length) process.stdout.write(quotaLines.join('\n') + '\n');
  if (agentTag && agentTag !== 'NO AGENT') process.stdout.write(agentTag + '\n');
  process.exit(0);
}

// ⚠️ [修正 v1.1.4]：設定 300ms 總安全防線，避免 quotaScript hang 住導致整個 statusline bar 空白
const safetyTimeout = setTimeout(() => {
  outputAndExit();
}, 300);

try {
  const [qOut, aOut] = await Promise.all([
    existsSync(quotaScript)
      ? spawnNode([quotaScript], { input: stdinData })
      : Promise.resolve(''),
    spawnNode([bin], {
      cwd: cwd || undefined,
      env: { ...process.env, ANTIGRAVITY_CONVERSATION_ID: convId, MEMORY_DB_PATH: memoryDbPath },
    }),
  ]);
  quotaOut = qOut;
  agentOut = aOut;
  clearTimeout(safetyTimeout);
  outputAndExit();
} catch (_) {
  clearTimeout(safetyTimeout);
  outputAndExit();
}
