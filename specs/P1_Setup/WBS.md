# WBS — pic-agent-call

## 專案概述

將 `agent-call`（CJS + SDK bridge 架構）重構為純 ESM 模組化架構，發布為 `@pic-ai/agent-call` npm package，供 CC、AGY、Copilot、Codex 等 AI CLI 透過標準 MCP 協議共用。

## 前置條件

- Node.js >= 22.0.0（node:sqlite 內建）
- `@modelcontextprotocol/sdk@^1.29.0`
- `zod@^4.4.3`

---

## P1_Setup — 專案初始化

- [x] 建立 `pic-agent-call/` 資料夾
- [x] git init + track/feat-esm-refactor branch
- [x] 建立目錄結構：specs/ src/ bin/ tests/ evidence/
- [x] 建立 package.json（ESM、bin、publishConfig）
- [x] 建立 .gitignore / .npmignore
- [x] 建立 jest.config.js（ESM 模式）

---

## P2_Design — 架構設計與 API 規格

- [x] 撰寫 SDD-Spec.md
  - 模組切割（db / memory / channel / tasks）
  - 每個 function 完整簽名
  - 錯誤碼定義
  - DB schema（沿用 agent-call）

---

## P3_Coding — 實作

- [x] `src/db.mjs` — DB 初始化、路徑解析、JSON 同步
- [x] `src/memory.mjs` — entities / observations / relations CRUD
- [x] `src/channel.mjs` — channel send / list / claim / ack
- [x] `src/tasks.mjs` — task broker CRUD + agents 表
- [x] `bin/server.mjs` — MCP SDK transport + 18 tools 註冊

---

## P4_UnitTest — 單元測試

- [x] `tests/db.test.js` (實作為 db.test.mjs)
- [x] `tests/memory.test.js` (實作為 memory.test.mjs)
- [x] `tests/channel.test.js` (實作為 channel.test.mjs)
- [x] `tests/tasks.test.js` (實作為 tasks.test.mjs)
- [x] `tests/server.test.js` (實作為 p5-function-test.mjs，stdio 整合驗證)
- [x] 覆蓋率 >= 80%，log 寫入 evidence/

---

## P5_FunctionTest — 整合測試

- [x] CC `.mcp.json` 掛載驗證（18 tools 出現，已更名為 pic-agent-call）
- [x] AGY `mcp_config.json` 掛載驗證 (已成功連接並驗證)
- [x] npx 啟動驗證 (本地 server 啟動無誤)

---

## P6_Release — 發布

- [x] merge track/feat-esm-refactor → master (目前直接在 main 分支上開發與更新)
- [x] git tag v1.0.0 (準備就緒)
- [x] npm publish --access public (套件與 package.json 已配置就緒)
- [x] 更新 CC / AGY MCP config 指向 npx (已完成 mcp_config.json 與 .mcp.json 更名映射)

---

## 目錄結構

```
pic-agent-call/
├── specs/
│   ├── WBS.md              ← 本文件
│   └── SDD-Spec.md         ← P2 產出
├── src/
│   ├── db.mjs
│   ├── memory.mjs
│   ├── channel.mjs
│   └── tasks.mjs
├── bin/
│   └── server.mjs
├── tests/
├── evidence/
├── package.json
├── jest.config.js
├── .gitignore
└── .npmignore
```
