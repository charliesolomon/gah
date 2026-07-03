#!/usr/bin/env bash
#
# watch-session.sh — live-tail a GAH agent's session transcript on jump.
#
# Usage: watch-session.sh [agent-user] [new|latest]
#   agent-user  jump.grace.cloud account to watch (default: testagent)
#   new         wait for a session file created after the watcher starts (default)
#   latest      attach to the most recent existing session immediately
#
# Streams the session JSONL through render-session.py so the whole
# user/assistant/tool exchange reads as a conversation. Requires ssh access
# to jump (Host "jump" in ~/.ssh/config) with passwordless sudo.
#
set -euo pipefail

AGENT_USER="${1:-testagent}"
MODE="${2:-new}"
HERE="$(cd "$(dirname "$0")" && pwd)"

ssh jump "sudo env AGENT_USER='$AGENT_USER' MODE='$MODE' bash -s" <<'REMOTE' | python3 -u "$HERE/render-session.py"
set -u
DIR="/home/$AGENT_USER/.gah/agent/sessions"
START=$(date +%s)
while :; do
  f=$(find "$DIR" -name '*.jsonl' -printf '%T@ %p\n' 2>/dev/null | sort -n | tail -1 | cut -d' ' -f2-)
  if [ -n "$f" ]; then
    if [ "$MODE" = "latest" ] || [ "$(stat -c %Y "$f")" -ge "$START" ]; then
      break
    fi
  fi
  sleep 1
done
printf '{"type":"_watching","file":"%s"}\n' "$f"
exec tail -n +1 -F "$f"
REMOTE
