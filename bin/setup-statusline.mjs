#!/usr/bin/env node
// 一鍵安裝/設定 Antigravity 狀態列 Hook
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const wrapperPath = path.join(__dirname, 'msg-statusline-wrapper.mjs');

function setup() {
  console.log('🚀 開始進行 Antigravity (AGY) 狀態列一鍵設定...');

  const geminiDir = path.join(os.homedir(), '.gemini');
  if (!fs.existsSync(geminiDir)) {
    try {
      fs.mkdirSync(geminiDir, { recursive: true });
    } catch (e) {
      console.error(`❌ 無法建立目錄 ${geminiDir}:`, e.message);
      process.exit(1);
    }
  }

  const settingsPath = path.join(geminiDir, 'settings.json');
  let settings = {};

  if (fs.existsSync(settingsPath)) {
    try {
      settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    } catch (e) {
      console.warn('⚠️ 讀取 settings.json 失敗，將會覆寫或重新建立:', e.message);
    }
  }

  // 初始化 ui.footer 結構
  if (!settings.ui) settings.ui = {};
  if (!settings.ui.footer) settings.ui.footer = {};
  
  // 設定狀態列為啟用並使用 node 執行 wrapper 絕對路徑
  settings.ui.footer.enabled = true;
  settings.ui.footer.type = 'command';
  settings.ui.footer.command = `node "${wrapperPath.replace(/\\/g, '/')}"`;

  // 移出已停用的 watchdog-countdown，並確保預設顯示項目完整
  if (settings.ui.footer.items) {
    settings.ui.footer.items = settings.ui.footer.items.filter(item => item !== 'watchdog-countdown');
  } else {
    // 預設顯示項目
    settings.ui.footer.items = [
      'project-path',
      'git-branch',
      'model-name',
      'quota',
      'context-used',
      'token-count',
      'memory-usage'
    ];
  }

  // 強制設定為 powerline 風格以達到最佳美觀效果
  if (!settings.ui.footer.style) {
    settings.ui.footer.style = 'powerline';
  }

  try {
    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2), 'utf8');
    console.log(`✅ 已成功更新設定檔: ${settingsPath}`);
  } catch (e) {
    console.error('❌ 寫入 settings.json 失敗:', e.message);
    process.exit(1);
  }

  // 寫入信任 Hook (trusted_hooks.json)
  const trustedHooksPath = path.join(geminiDir, 'trusted_hooks.json');
  let trustedHooks = [];
  if (fs.existsSync(trustedHooksPath)) {
    try {
      trustedHooks = JSON.parse(fs.readFileSync(trustedHooksPath, 'utf8'));
    } catch (_) {}
  }

  const normalizedWrapperPath = wrapperPath.replace(/\\/g, '/');
  if (!trustedHooks.includes(normalizedWrapperPath)) {
    trustedHooks.push(normalizedWrapperPath);
    try {
      fs.writeFileSync(trustedHooksPath, JSON.stringify(trustedHooks, null, 2), 'utf8');
      console.log(`✅ 已將 wrapper 加入安全性信任清單: ${trustedHooksPath}`);
    } catch (e) {
      console.warn('⚠️ 無法自動加入信任清單，您可能需要手動在 trusted_hooks.json 中將其加入:', e.message);
    }
  }

  console.log('\n🎉 Antigravity 狀態列一鍵設定完成！請重啟終端機以套用變更。');
}

setup();
