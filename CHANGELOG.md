# Changelog

All notable changes to `@pic-ai/pic-agent-call` are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

---

## [1.1.2] - 2026-06-24

### Fixed
- `msg-statusline.mjs`: 優先用 `WT_SESSION` 查 `agents.term_key` 修正 `--force` 後 statusline 消失
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
- **`msg-statusline.mjs`**: 直接查詢 SQLite DB 取得 agent 身份，不依賴跨視窗 cache 掃描
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
- `bin/statusline.mjs`（舊版，已由 `msg-statusline.mjs` 取代）

---

## [1.0.4] - 2026-06-11

- feat(statusline): `🟢/🔴·agent_id` 格式，查無身份顯示 `NO AGENT`
- fix(server): `resolveTermKey` 正確區分 CC 與 AGY 前綴

---

## [1.0.3] and earlier

See git history.
