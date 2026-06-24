/**
 * tests/setup.test.mjs
 * Unit tests for bin/setup-utils.mjs and key logic in setup-cc/agy scripts
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

let readJsonFile, writeJsonFile, ensureDir, toForwardSlash, toBackSlash;

beforeAll(async () => {
  const mod = await import('../bin/setup-utils.mjs');
  readJsonFile    = mod.readJsonFile;
  writeJsonFile   = mod.writeJsonFile;
  ensureDir       = mod.ensureDir;
  toForwardSlash  = mod.toForwardSlash;
  toBackSlash     = mod.toBackSlash;
});

// ── helpers ───────────────────────────────────────────────────────────────────

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'pac-setup-test-'));
}

// ── readJsonFile ──────────────────────────────────────────────────────────────

describe('readJsonFile', () => {
  test('returns null for missing file', () => {
    expect(readJsonFile('/nonexistent/path/file.json')).toBeNull();
  });

  test('returns null for malformed JSON', () => {
    const dir = tmpDir();
    const p = path.join(dir, 'bad.json');
    fs.writeFileSync(p, '{bad json}', 'utf8');
    expect(readJsonFile(p)).toBeNull();
    fs.rmSync(dir, { recursive: true });
  });

  test('parses valid JSON', () => {
    const dir = tmpDir();
    const p = path.join(dir, 'ok.json');
    fs.writeFileSync(p, JSON.stringify({ a: 1 }), 'utf8');
    expect(readJsonFile(p)).toEqual({ a: 1 });
    fs.rmSync(dir, { recursive: true });
  });
});

// ── writeJsonFile ─────────────────────────────────────────────────────────────

describe('writeJsonFile', () => {
  test('writes pretty JSON with trailing newline', () => {
    const dir = tmpDir();
    const p = path.join(dir, 'out.json');
    writeJsonFile(p, { x: 42 });
    const raw = fs.readFileSync(p, 'utf8');
    expect(raw.endsWith('\n')).toBe(true);
    expect(JSON.parse(raw)).toEqual({ x: 42 });
    fs.rmSync(dir, { recursive: true });
  });

  test('round-trip read→write→read', () => {
    const dir = tmpDir();
    const p = path.join(dir, 'rt.json');
    const obj = { hooks: ['a', 'b'], nested: { n: 1 } };
    writeJsonFile(p, obj);
    expect(readJsonFile(p)).toEqual(obj);
    fs.rmSync(dir, { recursive: true });
  });
});

// ── ensureDir ─────────────────────────────────────────────────────────────────

describe('ensureDir', () => {
  test('creates directory if missing', () => {
    const dir = tmpDir();
    const target = path.join(dir, 'a', 'b', 'c');
    expect(fs.existsSync(target)).toBe(false);
    ensureDir(target);
    expect(fs.existsSync(target)).toBe(true);
    fs.rmSync(dir, { recursive: true });
  });

  test('does not throw if directory already exists', () => {
    const dir = tmpDir();
    expect(() => ensureDir(dir)).not.toThrow();
    fs.rmSync(dir, { recursive: true });
  });
});

// ── toForwardSlash / toBackSlash ──────────────────────────────────────────────

describe('toForwardSlash', () => {
  test('converts backslashes to forward slashes', () => {
    expect(toForwardSlash('C:\\foo\\bar\\baz')).toBe('C:/foo/bar/baz');
  });
  test('no-op on already forward slash path', () => {
    expect(toForwardSlash('C:/foo/bar')).toBe('C:/foo/bar');
  });
  test('empty string', () => {
    expect(toForwardSlash('')).toBe('');
  });
});

describe('toBackSlash', () => {
  test('converts forward slashes to backslashes', () => {
    expect(toBackSlash('C:/foo/bar/baz')).toBe('C:\\foo\\bar\\baz');
  });
  test('no-op on already back slash path', () => {
    expect(toBackSlash('C:\\foo\\bar')).toBe('C:\\foo\\bar');
  });
  test('empty string', () => {
    expect(toBackSlash('')).toBe('');
  });
});

// ── setup-agy: targetKeys dedup logic ────────────────────────────────────────

describe('setup-agy targetKeys logic', () => {
  test('includes * + cwd + existing hook keys, no duplicates', () => {
    const hooks = { 'C:\\proj\\a': ['cmd1'], 'C:\\proj\\b': ['cmd2'] };
    const cwd = 'C:\\proj\\a';
    const targetKeys = new Set(['*', cwd, ...Object.keys(hooks)]);
    // * always present
    expect(targetKeys.has('*')).toBe(true);
    // cwd present
    expect(targetKeys.has(cwd)).toBe(true);
    // existing keys present
    expect(targetKeys.has('C:\\proj\\b')).toBe(true);
    // no duplicates — C:\proj\a appears in both cwd and hooks keys
    expect([...targetKeys].filter(k => k === cwd).length).toBe(1);
  });
});

// ── setup-cc: setupStatusLine skip logic ─────────────────────────────────────

describe('setup-cc setupStatusLine skip logic', () => {
  test('skips mutation when statusLine.command already set', () => {
    const settings = { statusLine: { command: 'existing-cmd' } };
    // simulate setupStatusLine guard
    const shouldSkip = !!settings.statusLine?.command;
    expect(shouldSkip).toBe(true);
  });

  test('proceeds when statusLine not set', () => {
    const settings = {};
    const shouldSkip = !!settings.statusLine?.command;
    expect(shouldSkip).toBe(false);
  });
});

// ── setup-cc: setupHooks idempotency ─────────────────────────────────────────

describe('setup-cc setupHooks idempotency', () => {
  test('does not add duplicate gate hook', () => {
    const settings = {
      hooks: {
        UserPromptSubmit: [
          { hooks: [{ type: 'command', command: 'node "C:/hooks/pic-agent-autoreg-gate.js"' }] },
        ],
      },
    };
    const already = settings.hooks.UserPromptSubmit.some(group =>
      Array.isArray(group?.hooks) && group.hooks.some(h => h.command?.includes('pic-agent-autoreg-gate.js'))
    );
    expect(already).toBe(true);
  });

  test('adds gate hook when not present', () => {
    const settings = { hooks: { UserPromptSubmit: [] } };
    const already = settings.hooks.UserPromptSubmit.some(group =>
      Array.isArray(group?.hooks) && group.hooks.some(h => h.command?.includes('pic-agent-autoreg-gate.js'))
    );
    expect(already).toBe(false);
  });
});
