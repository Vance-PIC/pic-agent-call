# Project Rules — pic-agent-call

## MCP Tools Permission Policy
- 使用者已於 2026-06-21 09:27 授權：當 AI 代理人呼叫 `pic-agent-call` MCP 伺服器的所有工具時，皆無須再次詢問使用者，一律預先自動允許。

## Unit Testing Guidelines
- **防範家目錄環境污染 (Home Directory Pollution)**：在編寫或執行涉及讀取使用者家目錄（如 `os.homedir()`、`~/.gemini`）的測試時，必須在測試環境或特定 Test Case 中 mock/stub 家目錄路徑（例如將其設為 nonexistent 虛擬路徑），以防止實體主機中的實際快取或設定干擾測試斷言。

## Pre-action Message Check Gate (動作前訊息稽核門禁)
- **觸發時機**：在呼叫任何「寫入/修改檔案工具」（如 `replace_file_content`, `write_to_file`）或「指令執行工具」（如 `run_command`）**之前**。
- **稽核動作**：AI 必須先主動呼叫 `agent_status` MCP 工具。
- **防守手煞車**：若 `agent_status` 回傳的 `unread > 0`，**嚴禁執行後續寫入或指令**。AI 必須立刻呼叫 `channel_list_unread` 讀取所有未讀訊息並優先處理（或回覆），直到 `unread` 歸零後，方可繼續原定的寫入或指令動作。
