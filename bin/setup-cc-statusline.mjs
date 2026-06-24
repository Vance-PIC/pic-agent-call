#!/usr/bin/env node
// 一鍵安裝/設定 Claude Code 狀態列與 autoreg-gate hook
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readJsonFile, writeJsonFile, ensureDir } from './setup-utils.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function resolveGitBash() {
  const candidates = [
    'C:\\Program Files\\Git\\bin\\bash.exe',
    'C:\\Program Files (x86)\\Git\\bin\\bash.exe',
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  // 嘗試 which bash
  try {
    const result = execFileSync('where', ['bash'], { encoding: 'utf8' }).trim().split('\n')[0].trim();
    if (result && fs.existsSync(result)) return result;
  } catch (_) {}
  return null;
}

function setupStatusLine(claudeDir, wrapperShDest) {
  const settingsPath = path.join(claudeDir, 'settings.json');
  const settings = readJsonFile(settingsPath) || {};

  // 已有 statusLine.command → 保留不改（wrapper.sh 已 append，不需要再改指令）
  if (settings.statusLine?.command) {
    console.log(`[SKIP] statusLine 已存在，保留原設定`);
    return;
  }

  const bashExe = resolveGitBash();
  if (!bashExe) {
    console.error('[WARN] 找不到 Git Bash，statusLine 設定略過。請手動設定 bash 路徑。');
    return;
  }

  const bashCmd = `"${bashExe}" --norc --noprofile "${wrapperShDest}"`;
  settings.statusLine = { type: 'command', command: bashCmd, refreshInterval: 5 };

  writeJsonFile(settingsPath, settings);
  console.log(`[OK] statusLine → ${settingsPath}`);
  console.log(`     command: ${bashCmd}`);
}

function setupHooks(claudeDir, gateSrc) {
  const hooksDir = path.join(claudeDir, 'hooks');
  ensureDir(hooksDir);

  const gateDest = path.join(hooksDir, 'pic-agent-autoreg-gate.js');
  fs.copyFileSync(gateSrc, gateDest);
  console.log(`[OK] hook → ${gateDest}`);

  const gateCmd = `node "${gateDest.replace(/\\/g, '/')}"`;
  const settingsPath = path.join(claudeDir, 'settings.json');
  const settings = readJsonFile(settingsPath) || {};

  if (!settings.hooks) settings.hooks = {};

  // UserPromptSubmit
  if (!Array.isArray(settings.hooks.UserPromptSubmit)) settings.hooks.UserPromptSubmit = [];
  const already = settings.hooks.UserPromptSubmit.some(group =>
    Array.isArray(group?.hooks) && group.hooks.some(h => h.command?.includes('pic-agent-autoreg-gate.js'))
  );
  if (!already) {
    settings.hooks.UserPromptSubmit.push({
      hooks: [{ type: 'command', command: gateCmd }],
    });
    console.log(`[OK] UserPromptSubmit hook 已加入`);
  } else {
    console.log(`[SKIP] UserPromptSubmit hook 已存在`);
  }

  writeJsonFile(settingsPath, settings);
}

const PIC_MARKER = '# pic-agent-call statusline';
const PIC_BLOCK = `
${PIC_MARKER}
_pac_bin_dev="${'$'}{cwd}/bin/msg-statusline.mjs"
_pac_bin_global="$(npm root -g 2>/dev/null)/@pic-ai/pic-agent-call/bin/msg-statusline.mjs"
if [ -n "$PIC_AGENT_DEV" ] && [ -f "$_pac_bin_dev" ]; then _pac_bin="$_pac_bin_dev"
elif [ -f "$_pac_bin_global" ]; then _pac_bin="$_pac_bin_global"
fi
if [ -n "$_pac_bin" ]; then
  _pac_db=""
  if [ -n "$cwd" ] && [ -f "\${cwd}/.memory/memory-graph.db" ]; then _pac_db="\${cwd}/.memory/memory-graph.db"; fi
  _pac_tag=$(CLAUDE_CODE_SESSION_ID="$CLAUDE_CODE_SESSION_ID" MEMORY_DB_PATH="$_pac_db" node "$_pac_bin" 2>/dev/null)
  case "$_pac_tag" in "NO AGENT"|""|*"[未登記]"*|*"[DB ERR]"*) ;; *) printf '%s\\n' "$_pac_tag" ;; esac
fi
`;

function copyWrapperSh(claudeDir) {
  const src = path.join(__dirname, 'statusline-wrapper.sh');
  const dest = path.join(claudeDir, 'statusline-wrapper.sh');
  if (!fs.existsSync(src)) {
    console.error(`[ERR] 找不到 ${src}`);
    process.exit(1);
  }

  if (fs.existsSync(dest)) {
    const existing = fs.readFileSync(dest, 'utf8');
    if (existing.includes(PIC_MARKER)) {
      console.log(`[SKIP] wrapper 已含 pic-agent-call block`);
      return dest;
    }
    // append 到既有 wrapper 末尾
    fs.appendFileSync(dest, PIC_BLOCK, 'utf8');
    console.log(`[OK] pic-agent-call block appended → ${dest}`);
  } else {
    fs.copyFileSync(src, dest);
    console.log(`[OK] wrapper → ${dest}`);
  }
  return dest;
}

function setup() {
  const claudeDir = path.join(os.homedir(), '.claude');
  ensureDir(claudeDir);

  const gateSrc = path.join(__dirname, '..', 'hooks', 'pic-agent-autoreg-gate.js');
  if (!fs.existsSync(gateSrc)) {
    console.error(`[ERR] 找不到 hook 模板：${gateSrc}`);
    process.exit(1);
  }

  const wrapperShDest = copyWrapperSh(claudeDir);
  setupStatusLine(claudeDir, wrapperShDest);
  setupHooks(claudeDir, gateSrc);

  console.log('\n[DONE] CC 狀態列設定完成，請重啟 Claude Code。');
  console.log('  開發模式：設定 PIC_AGENT_DEV=1 改用本地 source tree。');
}

setup();
