#!/usr/bin/env node
/**
 * pic-agent-autoreg-gate.js
 * UserPromptSubmit hook: if session not registered as agent, block and prompt user.
 * Implements AGENTS.md Spec 8 "AI 啟動時自動與互動式引導註冊機制".
 */
'use strict';

const { DatabaseSync } = require('node:sqlite');
const fs   = require('node:fs');
const path = require('node:path');
const os   = require('node:os');

function resolveDbPath() {
    if (process.env.MEMORY_DB_PATH) return process.env.MEMORY_DB_PATH;
    const cwd = process.env.CLAUDE_PROJECT_DIR || process.cwd();
    const settingsPath = path.join(cwd, 'settings.local.json');
    if (fs.existsSync(settingsPath)) {
        try {
            const s = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
            if (s.memoryDbPath) return s.memoryDbPath;
        } catch (_) {}
    }
    const projectDb = path.join(cwd, '.memory', 'memory-graph.db');
    if (fs.existsSync(projectDb)) return projectDb;
    return path.join(os.homedir(), '.memory', 'memory-graph.db');
}

function main() {
    // 放行 register_agent 呼叫本身，避免雞生蛋問題
    try {
        const input = JSON.parse(fs.readFileSync(0, 'utf8'));
        const prompt = (input?.prompt || '').toLowerCase();
        if (prompt.includes('register_agent') || prompt.includes('register agent')) {
            process.exit(0);
        }
    } catch (_) {}

    const dbPath = resolveDbPath();
    if (!fs.existsSync(dbPath)) process.exit(0);

    const sessionId = process.env.CLAUDE_CODE_SESSION_ID
        || process.env.AGENT_SESSION_ID
        || null;
    if (!sessionId) process.exit(0);

    let db;
    try {
        db = new DatabaseSync(dbPath, { readonly: true });
    } catch (_) {
        process.exit(0);
    }

    try {
        const reg = db.prepare(
            'SELECT agent_id FROM agents WHERE session_id = ?'
        ).get(sessionId);
        db.close();

        if (reg) process.exit(0);

        // 二道防線：DB 找不到時，改以 term_key cache 檔確認（防 MCP server session ID 不同步）
        const termKey = `cc-${sessionId.substring(0, 8)}`;
        const cacheFile = path.join(path.dirname(dbPath), 'agent-sessions', `${termKey}.json`);
        if (fs.existsSync(cacheFile)) {
            try {
                const data = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
                if (data.session_id === sessionId && data.agent_id) process.exit(0);
            } catch (_) {}
        }

        const result = {
            decision: 'warn',
            reason: '[AUTO-REG] 此 session 尚未登記 Agent 身份。請先呼叫 register_agent（建議：CC-PG1/CC-SA1/CC-QA1 擇一），完成後再繼續任務。',
        };
        process.stdout.write(JSON.stringify(result) + '\n');
        process.exit(0);
    } catch (_) {
        try { db.close(); } catch (__) {}
        process.exit(0);
    }
}

main();
