#!/usr/bin/env node
// 狀態列整合包裝器：拼裝 Quota 狀態與 Agent 訊息狀態（quota + agent 並行執行）
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const TIMEOUT_MS = 1500;
const isValidAgentTag = t => t && t !== 'NO AGENT' && !t.includes('[未登記]') && !t.includes('[DB ERR]');

function spawnNode(args, opts) {
  return new Promise((resolve) => {
    const child = execFile(process.execPath, args, { encoding: 'utf8', timeout: TIMEOUT_MS, ...opts }, (err, stdout) => {
      resolve(err ? '' : stdout);
    });
    if (opts?.input) { child.stdin.write(opts.input); child.stdin.end(); }
  });
}

const chunks = [];
process.stdin.on('data', d => chunks.push(d));
process.stdin.on('end', async () => {
  const input = Buffer.concat(chunks).toString();
  let parsed = {};
  try { parsed = JSON.parse(input); } catch (_) {}

  const convId = parsed?.conversation_id ?? parsed?.conversationId ?? process.env.ANTIGRAVITY_CONVERSATION_ID ?? '';
  const cwd = parsed?.workspace?.current_dir ?? parsed?.cwd ?? '';
  const bin = path.join(__dirname, 'msg-statusline.mjs');
  const quotaScript = path.join(homedir(), '.gemini', 'antigravity-cli', 'plugins', 'antigravity-cli-statusline', 'scripts', 'statusline-quota.mjs');
  const dbCandidate = cwd ? path.join(cwd, '.memory', 'memory-graph.db') : '';
  const memoryDbPath = dbCandidate && existsSync(dbCandidate) ? dbCandidate : (process.env.MEMORY_DB_PATH || '');

  // 1 + 2 並行執行
  const [quotaOut, agentOut] = await Promise.all([
    existsSync(quotaScript)
      ? spawnNode([quotaScript], { input })
      : Promise.resolve(''),
    spawnNode([bin], {
      input,
      cwd: cwd || undefined,
      env: { ...process.env, ANTIGRAVITY_CONVERSATION_ID: convId, MEMORY_DB_PATH: memoryDbPath },
    }),
  ]);

  // 3. 輸出
  const quotaLines = quotaOut ? quotaOut.trimEnd().split('\n') : [];
  const agentTag = isValidAgentTag(agentOut.trim()) ? agentOut.trim() : '';
  if (quotaLines.length) process.stdout.write(quotaLines.join('\n') + '\n');
  if (agentTag) process.stdout.write(agentTag + '\n');
});
