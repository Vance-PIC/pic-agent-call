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

    const wtSession = process.env.WT_SESSION || null;

    let db;
    try {
        db = new DatabaseSync(dbPath);
        db.exec('PRAGMA busy_timeout = 3000');
    } catch (_) {
        process.exit(0);
    }

    try {
        // 一道：session_id 直查
        const reg = db.prepare(
            'SELECT agent_id, term_key FROM agents WHERE session_id = ?'
        ).get(sessionId);
        if (reg) {
            // 順帶 patch：session 已登記但 term_key 尚未寫入，且有 WT_SESSION → 補寫
            if (wtSession && !reg.term_key) {
                try {
                    db.prepare('UPDATE agents SET term_key = ? WHERE session_id = ? AND term_key IS NULL')
                      .run(wtSession, sessionId);
                } catch (_) {}
            }
            db.close(); process.exit(0);
        }

        // 二道：WT_SESSION 查 agents.term_key（v1.1.2+，force-register 後 session 換了仍能找到）
        if (wtSession) {
            const regByWt = db.prepare(
                'SELECT agent_id FROM agents WHERE term_key = ? LIMIT 1'
            ).get(wtSession);
            if (regByWt) { db.close(); process.exit(0); }
        }
        db.close();

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
