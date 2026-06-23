#!/usr/bin/env node
// 一鍵安裝/設定 Antigravity 狀態列 Hook
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const wrapperPath = path.join(__dirname, 'msg-statusline-wrapper.mjs');
const wrapperCmd = `node "${wrapperPath.replace(/\\/g, '/')}"`;

function readJsonFile(filePath) {
  if (!fs.existsSync(filePath)) return null;
  try { return JSON.parse(fs.readFileSync(filePath, 'utf8')); } catch (_) { return null; }
}

function writeJsonFile(filePath, data) {
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
}

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function setupSettings(geminiDir) {
  const settingsPath = path.join(geminiDir, 'settings.json');
  const settings = readJsonFile(settingsPath) || {};

  const slConfig = { enabled: true, type: 'command', command: wrapperCmd };

  // ui.footer (舊版 Antigravity CLI)
  if (!settings.ui) settings.ui = {};
  if (!settings.ui.footer) settings.ui.footer = {};
  Object.assign(settings.ui.footer, slConfig);

  // 移除已停用的 watchdog-countdown
  if (Array.isArray(settings.ui.footer.items)) {
    settings.ui.footer.items = settings.ui.footer.items.filter(i => i !== 'watchdog-countdown');
  }

  // statusLine (新版)
  if (!settings.statusLine) settings.statusLine = {};
  Object.assign(settings.statusLine, slConfig);

  writeJsonFile(settingsPath, settings);
  console.log(`[OK] settings: ${settingsPath}`);
}

function setupTrustedHooks(geminiDir) {
  const hooksPath = path.join(geminiDir, 'trusted_hooks.json');
  const hooks = readJsonFile(hooksPath) || {};

  const fwdCmd = `statusLine:${wrapperCmd}`;
  const winCmd = `statusLine:node "${wrapperPath.replace(/\//g, '\\')}"`;
  const entries = [fwdCmd, winCmd];

  let changed = false;
  // 必須對 '*'、當前 CWD、以及 trusted_hooks.json 中所有已存在的專案 Key 都寫入信任設定。
  // 因為在 Windows Antigravity 下，安全性檢查若發現當前專案 Key 存在，便會完全忽略 '*' 的設定。
  const targetKeys = new Set(['*', process.cwd()]);
  for (const k in hooks) {
    targetKeys.add(k);
  }

  for (const key of targetKeys) {
    if (!Array.isArray(hooks[key])) hooks[key] = [];
    for (const entry of entries) {
      if (!hooks[key].includes(entry)) {
        hooks[key].push(entry);
        changed = true;
      }
    }
  }

  if (changed) {
    writeJsonFile(hooksPath, hooks);
    console.log(`[OK] trusted_hooks: ${hooksPath}`);
  }
}

function setup() {
  const geminiDir = path.join(os.homedir(), '.gemini');
  ensureDir(geminiDir);
  setupSettings(geminiDir);
  setupTrustedHooks(geminiDir);
  console.log('[DONE] 狀態列設定完成，請重啟終端機。');
}

setup();
