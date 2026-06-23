#!/usr/bin/env node
// 狀態列整合包裝器：拼裝 Quota 狀態與 Agent 訊息狀態
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const TIMEOUT_MS = 1000;

const chunks = [];
process.stdin.on('data', d => chunks.push(d));
process.stdin.on('end', () => {
  const input = Buffer.concat(chunks).toString();
  let parsed = {};
  try { parsed = JSON.parse(input); } catch (_) {}

  // 1. quota statusline (Gemini/Antigravity 專用，非必要)
  let quotaLines = [];
  try {
    const quotaScript = path.join(homedir(), '.gemini', 'antigravity-cli', 'plugins', 'antigravity-cli-statusline', 'scripts', 'statusline-quota.mjs');
    if (existsSync(quotaScript)) {
      const out = execFileSync(process.execPath, [quotaScript], { input, encoding: 'utf8', timeout: TIMEOUT_MS });
      quotaLines = out.replace(/\n$/, '').split('\n');
    }
  } catch (e) {
    process.stderr.write(`[statusline-wrapper] quota error: ${e.message}\n`);
  }

  // 2. agent identity (pic-agent-call)
  const convId = parsed?.conversation_id ?? parsed?.conversationId ?? process.env.ANTIGRAVITY_CONVERSATION_ID ?? '';
  const cwd = parsed?.workspace?.current_dir ?? parsed?.cwd ?? '';
  const bin = path.join(__dirname, 'msg-statusline.mjs');

  let agentTag = '';
  if (existsSync(bin)) {
    try {
      const out = execFileSync(process.execPath, [bin], {
        input,
        encoding: 'utf8',
        cwd: cwd || undefined,
        timeout: TIMEOUT_MS,
        env: { ...process.env, ANTIGRAVITY_CONVERSATION_ID: convId },
      });
      const trimmed = out.trim();
      if (trimmed && trimmed !== 'NO AGENT' && !trimmed.includes('[未登記]') && !trimmed.includes('[DB ERR]')) {
        agentTag = trimmed;
      }
    } catch (e) {
      process.stderr.write(`[statusline-wrapper] agent error: ${e.message}\n`);
    }
  }

  // 3. 輸出：quota 各行原樣輸出，agent tag 獨立一行
  for (const line of quotaLines) {
    process.stdout.write(line + '\n');
  }
  if (agentTag) {
    process.stdout.write(agentTag + '\n');
  }
});
