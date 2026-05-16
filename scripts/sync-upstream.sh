#!/usr/bin/env bash
#
# sync-upstream.sh — vendor and update upstream PI as a git subtree.
#
# Usage:
#   scripts/sync-upstream.sh init  [<ref>]   First-time vendor (default: main)
#   scripts/sync-upstream.sh pull  [<ref>]   Pull a new upstream ref
#   scripts/sync-upstream.sh status          Show current vendored ref
#
# After init/pull, run scripts/apply-patches.sh to re-apply the patch series.
#
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
UPSTREAM_URL="${UPSTREAM_URL:-https://github.com/earendil-works/pi.git}"
UPSTREAM_REMOTE="${UPSTREAM_REMOTE:-pi-upstream}"
SUBTREE_PREFIX="vendor/pi"
STATE_FILE="$REPO_ROOT/.sync-state"

cd "$REPO_ROOT"

ensure_remote() {
  if ! git remote get-url "$UPSTREAM_REMOTE" >/dev/null 2>&1; then
    git remote add "$UPSTREAM_REMOTE" "$UPSTREAM_URL"
  fi
  git fetch --tags "$UPSTREAM_REMOTE"
}

record_state() {
  local ref="$1"
  local sha
  sha=$(git rev-parse "$UPSTREAM_REMOTE/$ref" 2>/dev/null || git rev-parse "$ref")
  printf 'ref=%s\nsha=%s\nsynced=%s\n' "$ref" "$sha" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$STATE_FILE"
}

cmd_init() {
  local ref="${1:-main}"
  if [ -d "$SUBTREE_PREFIX" ]; then
    echo "vendor/pi already exists. Use 'pull' instead." >&2
    exit 1
  fi
  ensure_remote
  echo "→ Adding subtree at $SUBTREE_PREFIX from $UPSTREAM_REMOTE/$ref"
  git subtree add --prefix="$SUBTREE_PREFIX" "$UPSTREAM_REMOTE" "$ref" --squash
  record_state "$ref"
  echo "✓ Vendored upstream at $ref"
  echo "  Next: scripts/apply-patches.sh"
}

cmd_pull() {
  local ref="${1:?usage: sync-upstream.sh pull <ref>}"
  if [ ! -d "$SUBTREE_PREFIX" ]; then
    echo "vendor/pi missing. Run 'init' first." >&2
    exit 1
  fi
  ensure_remote
  echo "→ Pulling $UPSTREAM_REMOTE/$ref into $SUBTREE_PREFIX"
  git subtree pull --prefix="$SUBTREE_PREFIX" "$UPSTREAM_REMOTE" "$ref" --squash
  record_state "$ref"
  echo "✓ Synced upstream to $ref"
  echo "  Next: scripts/apply-patches.sh"
}

cmd_status() {
  if [ -f "$STATE_FILE" ]; then
    cat "$STATE_FILE"
  else
    echo "no sync state recorded"
  fi
}

case "${1:-}" in
  init)   shift; cmd_init   "$@" ;;
  pull)   shift; cmd_pull   "$@" ;;
  status) shift; cmd_status "$@" ;;
  *) sed -n '1,15p' "$0"; exit 2 ;;
esac
