#!/usr/bin/env node
// Gemini/Antigravity 狀態列整合包裝器：拼裝 Quota 狀態與 Agent 訊息狀態
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const chunks = [];
process.stdin.on('data', d => chunks.push(d));
process.on('exit', () => { process.exitCode = 0; });
process.stdin.on('end', () => {
  const input = Buffer.concat(chunks).toString();
  let parsed = {};
  try { parsed = JSON.parse(input); } catch (_) {}

  // 1. quota statusline
  try {
    const quotaScript = path.join(homedir(), '.gemini', 'antigravity-cli', 'plugins', 'antigravity-cli-statusline', 'scripts', 'statusline-quota.mjs');
    if (existsSync(quotaScript)) {
      const out = execFileSync(process.execPath, [quotaScript], { input, encoding: 'utf8', timeout: 250 });
      process.stdout.write(out);
    }
  } catch (_) {}

  // 2. brain (agent identity)
  const convId = parsed?.conversation_id ?? parsed?.conversationId ?? process.env.ANTIGRAVITY_CONVERSATION_ID ?? '';
  const cwd = parsed?.workspace?.current_dir ?? parsed?.cwd ?? '';
  
  // 同目錄下即為 msg-statusline.mjs
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = path.dirname(__filename);
  const bin = path.join(__dirname, 'msg-statusline.mjs');

  if (existsSync(bin)) {
    try {
      const out = execFileSync(process.execPath, [bin], {
        input,
        encoding: 'utf8',
        cwd: cwd || undefined,
        timeout: 150,
        env: { ...process.env, ANTIGRAVITY_CONVERSATION_ID: convId },
      });
      const trimmed = out.trim();
      if (trimmed && trimmed !== 'NO AGENT' && !trimmed.includes('[未登記]') && !trimmed.includes('[DB ERR]')) {
        process.stdout.write(out);
      }
    } catch (_) {}
  }
});
