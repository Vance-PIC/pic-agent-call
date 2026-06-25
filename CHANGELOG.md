# Changelog

All notable changes to `@pic-ai/pic-agent-call` are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

---

## [1.1.3] - 2026-06-25

### Changed
- `bin/agent-statusline.mjs`: 主查詢改為直接以 `WT_SESSION` 查 `agents.term_key`（`getRegistrationsByTermKey`），跳過 session_id 中間層；AGY 或無 WT_SESSION 環境才 fallback 至 session_id
- `bin/agent-statusline.mjs`: fallback 路徑補設 `primaryAgentId = regs[0].agent_id`，確保 ▶ 標示在 AGY/無 WT_SESSION 環境正確顯示
- `src/status.mjs`: `getRegistrations()` SELECT 補入 `term_key` 欄位；新增 `getRegistrationsByTermKey(db, termKey)` API
- `src/status.mjs`: 修正 `_parseAgentIds()` 死碼 — `isCc` 判斷從 `sessionId.startsWith('cc-')` 改為 `process.env.CLAUDE_CODE_SESSION_ID === sessionId`
- `src/status.mjs`: `_parseAgentIds()` prefix fallback 從 `CLAUDE_CODE_SESSION_ID ? 'CC-' : 'AGY-'` 改為 `!CLAUDE_CODE_SESSION_ID ? 'AGY-' : 'CC-'`，修正 MCP context 下 AGY 短名稱永遠補 `CC-` 的錯誤
- `hooks/pic-agent-autoreg-gate.js`: Block 訊息加入 `session=<8碼>` 與 `WT_SESSION=<8碼>` 診斷資訊、原因說明與 register_agent 範例

### Removed
- `bin/server.mjs`: 移除 `resolveTermKey()`、`writeAgentSessionCache()`、`readPrimaryAgentIdFromCache()` 三個 file-cache 函式
- `bin/server.mjs`: 移除 `register_agent` handler 中 agent-sessions/ 檔案快取寫入邏輯
- `src/status.mjs`: 移除 `cleanExpiredAgentSessionCache()`、`PREFIXES`、`MS_*` 常數（agent-sessions/ 檔案快取機制整體廢棄）
- `tests/status.test.mjs`: 刪除 tests 22-29（`cleanExpiredAgentSessionCache()` describe block）

### Fixed
- `hooks/pic-agent-autoreg-gate.js`: 一道 UPDATE term_key、二道 UPDATE session_id 語意正確實作（前版二道僅放行未更新 DB）；一道、二道包進 `BEGIN IMMEDIATE` transaction，防止 statusline 高頻呼叫造成 race condition
- `hooks/pic-agent-autoreg-gate.js`: prompt 過濾從 `includes('register_agent')` 改為 `/^register[_ ]agent\b/`，防止說明性 prompt 誤放行 gate
- `src/status.mjs`: `registerAgent()` non-force 多角色改為先全部 pre-check 再全部 INSERT，防止部分角色衝突時前段已登記角色殘留 DB（partial registration bug）
- `src/status.mjs`: `getRegistrations()` / `getRegistrationsByTermKey()` ORDER BY 改為 `updated_at DESC, created_at ASC`，修正 primary 角色（▶）永遠指向最早登記角色的回歸；語義：最後 register/活躍的角色為 primary，同時登記時依輸入順序
- `bin/msg-statusline-wrapper.mjs`: 移除 `process.stdin.on('data/end')` 依賴，改為直接讀取 `process.env.ANTIGRAVITY_CONVERSATION_ID` / `process.env.PWD`；修正 AGY CLI 不關閉 stdin 導致 1500ms timeout 掛起問題；`quotaScript` spawn 移除 `input` 傳遞（quota script 不需要 stdin）

### Added
- `scripts/setup-terminal-key.ps1`: 非 Windows Terminal 環境補設 `WT_SESSION` 到 PowerShell profile
- `docs/wt-session-term-key.md`: WT_SESSION / term_key 機制文件

---

## [1.1.2] - 2026-06-24

### Fixed
- `agent-statusline.mjs`: 優先用 `WT_SESSION` 查 `agents.term_key` 修正 `--force` 後 statusline 消失
- `register_agent`: 加 `wt_session` 可選參數，直接寫入 DB `term_key` 欄（跨 CC 重啟不變）
- `statusline-wrapper.sh`: 改用 `cat` 讀 stdin（修正 Git Bash 啟動慢 timeout 問題）

### Changed
- `getRegistration`: delegate to `getRegistrations()[0] ?? null`（消除重複 SQL）
- `getAgentsByPlatformStatus`: 移出 `db.prepare()` 出 `.map()`；pool receiver `'all'` → `'any'`
- 抽出 `bin/setup-utils.mjs` 共用 `readJsonFile`/`writeJsonFile`/`ensureDir`；`setup-agy` 修正缺少 trailing `\n`

---

## [1.1.1] - 2026-06-24

### Fixed
- `package.json` bin entries: `setup-statusline` renamed to `setup-agy-statusline`; added `setup-cc-statusline`

> Patch to correct bin mapping broken by the rename in v1.1.0. No functional changes.

---

## [1.1.0] - 2026-06-24

### Highlights
重大改版：實作**多角色（multi-role）** session 概念，AGY/CC 安裝體驗全面改善，statusline 大幅重構。

### Added
- **Multi-role session**: `register_agent` 支援逗號/頓號分隔的複合角色 ID（例如 `PG1,QA1`），同一視窗可身兼多職
- **`register_agent --force`**: 強制接管已存在的 agent_id，解決跨 session 身份衝突
- **`setup-cc-statusline`**: CC 一鍵安裝腳本，自動偵測 Git Bash、append 模式不覆蓋既有 wrapper.sh、自動掛載 autoreg-gate hook
- **`setup-agy-statusline`** (原 `setup-statusline`): AGY 一鍵安裝腳本，部署 `msg-statusline-wrapper.mjs` 並寫入 settings.json
- **`agent-statusline.mjs`**: 直接查詢 SQLite DB 取得 agent 身份，不依賴跨視窗 cache 掃描
- **`msg-statusline-wrapper.mjs`**: AGY 專用包裝器，讀 stdin JSON 取 conversation_id，整合 quota statusline
- **`bin/statusline-wrapper.sh`**: CC 專用 bash wrapper，coralline + pic-agent-call 並行執行，降低延遲
- **`hooks/pic-agent-autoreg-gate.js`**: 套件內含 autoreg-gate hook 模板
- **Heartbeat 機制**: 自動偵測離線 agent，避免 statusline 顯示已下線身份
- **Session cache 自動清理**: 方案 G — 定期清除過期 session cache，防止污染
- **TypeScript 型別定義 `index.d.ts`**: 完整 API 型別宣告

### Changed
- **Statusline 格式**: 主要角色顯示黃色 `▶` 標示，多角色並列顯示
- **`register_agent` 回傳**: 含 `isPrimary` 欄位，標示主要角色
- **Channel security**: 訊息送達驗證強化（Spec 9/10）
- **DB query 重構**: statusline 直接查 DB，移除舊 term-key 檔案掃描邏輯

### Fixed
- 跨 LLM 視窗身份污染：不同 terminal 顯示他人身份
- CC session ID 不一致：重啟後 statusline 正確顯示
- `_parseAgentIds` 分隔符號支援：支援逗號、頓號、空格

### Known Issues
- `register_agent --force` 後 CC statusline 消失，需重啟 CC 視窗才恢復（下版修正）

### Removed
- `bin/statusline.mjs`（舊版，已由 `agent-statusline.mjs` 取代）

---

## [1.0.4] - 2026-06-11

- feat(statusline): `🟢/🔴·agent_id` 格式，查無身份顯示 `NO AGENT`
- fix(server): `resolveTermKey` 正確區分 CC 與 AGY 前綴

---

## [1.0.3] and earlier

See git history.
