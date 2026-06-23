#!/usr/bin/env bash
# CC statusline wrapper for pic-agent-call
# Reads JSON from stdin, queries agent identity, outputs one status line.
input=$(cat)
cwd=$(printf '%s' "$input" | jq -r '.workspace.current_dir // .cwd // ""')

# coralline statusline (若存在)
_coralline="$HOME/.claude/coralline/statusline.sh"
if [ -f "$_coralline" ]; then
  printf '%s' "$input" | bash "$_coralline"
fi

# PIC_AGENT_DEV=1 → use local source tree; else use global npm install
if [ -n "$PIC_AGENT_DEV" ]; then
  _bin="${cwd}/bin/msg-statusline.mjs"
else
  _bin="$(npm root -g 2>/dev/null)/@pic-ai/pic-agent-call/bin/msg-statusline.mjs"
fi

if [ -f "$_bin" ]; then
  _db_path=""
  if [ -n "$cwd" ] && [ -f "${cwd}/.memory/memory-graph.db" ]; then
    _db_path="${cwd}/.memory/memory-graph.db"
  fi
  _brain=$(CLAUDE_CODE_SESSION_ID="$CLAUDE_CODE_SESSION_ID" MEMORY_DB_PATH="$_db_path" node "$_bin" 2>/dev/null)
  case "$_brain" in "NO AGENT"|""|*"[未登記]"*|*"[DB ERR]"*) ;; *) printf '%s\n' "$_brain" ;; esac
fi
