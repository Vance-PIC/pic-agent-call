# WT_SESSION → term_key 機制說明

## 背景

`WT_SESSION` 是 Windows Terminal 每個 **tab** 的固定 GUID，同一 tab 內無論 CC/AGY 重啟幾次都不變。`agents.term_key` 欄位儲存此值，作為跨 session 重啟的穩定識別鍵。

---

## agents.term_key 寫入時機

### 1. `register_agent` MCP 工具（主動寫入）

**誰呼叫：** AI 手動呼叫 `register_agent`，傳入 `wt_session` 可選參數。

```
register_agent(agent_id="CC-PG1", wt_session="6caa8cfa-...")
```

**行為：**
- `server.mjs` 把 `wt_session` 直接寫入 `agents.term_key`
- 同時以 `wt_session[:8]` 為 prefix 寫一份 `agent-sessions/` cache（供舊版相容）

**限制：** AI 必須記得傳 `wt_session` 參數。沒傳則 `term_key = null`。

---

### 2. `autoreg-gate.js` UserPromptSubmit Hook（CC 自動 patch）

**檔案：** `hooks/pic-agent-autoreg-gate.js`

**誰觸發：** CC 每次 UserPromptSubmit（每次送出 prompt 前）。

**邏輯：**
```
session_id 查到 agents → term_key IS NULL 且有 WT_SESSION → UPDATE agents SET term_key = WT_SESSION
```

**效果：** CC 視窗只要送出第一個 prompt，`term_key` 就自動補寫，不需 AI 手動傳參數。

**前提：** hook 須部署至 `~/.claude/hooks/pic-agent-autoreg-gate.js`（由 `setup-cc-statusline.mjs` 安裝）。

---

### 3. `msg-statusline.mjs`（CC + AGY 自動 patch）

**檔案：** `bin/msg-statusline.mjs`

**誰觸發：** statusline 每次刷新（CC 5s，AGY 依設定）。

**邏輯：**
```
getRegistrations(db, querySessionId) 有結果
→ 有任一筆 term_key IS NULL 且有 WT_SESSION
→ UPDATE agents SET term_key = WT_SESSION WHERE session_id = ? AND term_key IS NULL
```

**效果：** AGY 無 hook 機制，改由 statusline 本身補寫。CC 亦受益（雙重保險）。

---

## term_key 讀取時機

### `msg-statusline.mjs` 查詢優先順序

```
1. WT_SESSION → SELECT session_id FROM agents WHERE term_key = WT_SESSION
   → 找到 → 用此 session_id 查 registrations
   → 找不到 → fallback

2. CLAUDE_CODE_SESSION_ID / ANTIGRAVITY_CONVERSATION_ID → 直查 session_id
```

**為什麼需要兩道：** `force-register` 後 `session_id` 換新，但 CC 的 `CLAUDE_CODE_SESSION_ID` env var 仍是舊值（重啟才更新）。用 `term_key` 可跨 session 重啟找到正確記錄。

### `autoreg-gate.js` 驗證順序

```
1. session_id 直查 → 找到 → 放行（順帶 patch term_key）
2. WT_SESSION 查 term_key → 找到 → 放行（force-register 後 session 換了仍有效）
3. 都查不到 → warn：尚未登記
```

---

## 完整資料流

```
CC terminal 啟動
    │
    ├─ 使用者送 prompt
    │      └─ autoreg-gate hook
    │             ├─ session_id 查到 + term_key NULL → patch WT_SESSION 進 DB
    │             └─ 查不到 → warn
    │
    └─ statusline 刷新（每 5s）
           └─ msg-statusline.mjs
                  ├─ WT_SESSION 查 term_key → 取 session_id → 查 registrations
                  ├─ fallback：CLAUDE_CODE_SESSION_ID 直查
                  └─ regs 有結果 + term_key NULL → patch WT_SESSION

AGY terminal
    └─ statusline 刷新
           └─ msg-statusline-wrapper.mjs → msg-statusline.mjs
                  ├─ ANTIGRAVITY_CONVERSATION_ID 直查（AGY 不換 session）
                  └─ regs 有結果 + term_key NULL → patch WT_SESSION
```

---

## force-register 後的行為

```
force-register 前：agents.session_id = OLD, term_key = WT_SESSION_A
force-register 後：agents.session_id = NEW, term_key = WT_SESSION_A（保留）

→ statusline 用 WT_SESSION_A 查 term_key → 找到 NEW session_id → 正常顯示
→ autoreg-gate 二道防線同樣用 WT_SESSION 查 → 不誤判為未登記
```

---

## 已知限制

| 情境 | 結果 |
|------|------|
| AI 未傳 `wt_session` 且 prompt 前 hook 先跑 | hook 自動補寫，無影響 |
| AGY 視窗首次刷新 statusline 才補寫 | 第一次刷新前可能短暫顯示 NO AGENT |
| Windows Terminal 關閉 tab 重開 | 新 tab 有新 WT_SESSION，舊 term_key 留在 DB（offline record，不影響） |
| 非 Windows Terminal（無 WT_SESSION） | term_key 保持 null，降回 session_id 查詢（v1.1.1 以前的行為） |
