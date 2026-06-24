#!/usr/bin/env node
// 共用工具函式，供 setup-cc-statusline.mjs 與 setup-agy-statusline.mjs 使用
import fs from 'node:fs';

export function readJsonFile(filePath) {
  if (!fs.existsSync(filePath)) return null;
  try { return JSON.parse(fs.readFileSync(filePath, 'utf8')); } catch (_) { return null; }
}

export function writeJsonFile(filePath, data) {
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + '\n', 'utf8');
}

export function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

export function toForwardSlash(p) { return p.replace(/\\/g, '/'); }
export function toBackSlash(p) { return p.replace(/\//g, '\\'); }
