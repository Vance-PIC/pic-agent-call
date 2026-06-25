#!/usr/bin/env bash
# CC statusline wrapper — coralline + pic-agent-call 並行執行
# pic-agent-call statusline
input=$(timeout 2 cat 2>/dev/null || true)
cwd=$(printf '%s' "$input" | jq -r '.workspace.current_dir // .cwd // ""' 2>/dev/null || true)

_tmp=$(mktemp -d)

# coralline — 背景跑
_coralline="$HOME/.claude/coralline/statusline.sh"
if [ -f "$_coralline" ]; then
  printf '%s' "$input" | bash "$_coralline" > "$_tmp/coralline" 2>/dev/null &
  _coralline_pid=$!
fi

# pic-agent-call — 背景跑
_pac_bin_dev="${cwd}/bin/agent-statusline.mjs"
_pac_bin_global="$HOME/AppData/Roaming/npm/node_modules/@pic-ai/pic-agent-call/bin/agent-statusline.mjs"
_pac_bin=""
if [ -n "$PIC_AGENT_DEV" ] && [ -f "$_pac_bin_dev" ]; then _pac_bin="$_pac_bin_dev"
elif [ -f "$_pac_bin_global" ]; then _pac_bin="$_pac_bin_global"
fi
if [ -n "$_pac_bin" ]; then
  _pac_db=""
  if [ -n "$cwd" ] && [ -f "${cwd}/.memory/memory-graph.db" ]; then _pac_db="${cwd}/.memory/memory-graph.db"; fi
  CLAUDE_CODE_SESSION_ID="$CLAUDE_CODE_SESSION_ID" WT_SESSION="$WT_SESSION" MEMORY_DB_PATH="$_pac_db" node "$_pac_bin" > "$_tmp/pac" 2>/dev/null &
  _pac_pid=$!
fi

# 等兩個都跑完
[ -n "$_coralline_pid" ] && wait "$_coralline_pid"
[ -n "$_pac_pid" ]       && wait "$_pac_pid"

# 輸出：coralline 第一行，pac 第二行（CC 渲染多行 statusline）
[ -f "$_tmp/coralline" ] && cat "$_tmp/coralline"
if [ -f "$_tmp/pac" ]; then
  _pac_tag=$(cat "$_tmp/pac")
  case "$_pac_tag" in "NO AGENT"|""|*"[未登記]"*|*"[DB ERR]"*) ;; *) printf '%s\n' "$_pac_tag" ;; esac
fi

rm -rf "$_tmp"
