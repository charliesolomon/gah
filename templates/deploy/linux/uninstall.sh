#!/usr/bin/env bash
# uninstall.sh - remove a GAH deployment package installed by install.sh for the
# current Linux user.
#
#   ~/.local/share/gah/uninstall.sh [--purge] [--keep-secrets]
#
# The twin of Uninstall-Gah.ps1. Removes every installed package under
# ~/.local/share/gah (with the skills cache, downloads, current.txt and the
# launcher stub), the applications-menu entry, the `gah` command (or the `gg`
# of older packages), the PATH line the installer may have added to ~/.bashrc,
# and ~/.config/gah/secrets.env
# (unless --keep-secrets). Leaves the agent's own state in ~/.gah (auth.json
# with /login keys, audit log, sessions) unless --purge. Idempotent.
set -euo pipefail

PURGE=0 KEEP=0
for a in "$@"; do
	case "$a" in
		--purge) PURGE=1 ;;
		--keep-secrets) KEEP=1 ;;
		-h | --help) sed -n '2,13p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
		*) echo "uninstall.sh: unknown argument $a" >&2; exit 2 ;;
	esac
done

ROOT="${XDG_DATA_HOME:-$HOME/.local/share}/gah"
APPS="${XDG_DATA_HOME:-$HOME/.local/share}/applications"
SECRETS="${XDG_CONFIG_HOME:-$HOME/.config}/gah/secrets.env"
ok() { echo "  OK: $*"; }

echo
echo "Uninstalling GAH for $(id -un)"
echo

# --- Applications menu entries -------------------------------------------------------
for f in "$APPS"/*.desktop; do
	[ -f "$f" ] && grep -qx 'X-GAH-Deployment=true' "$f" && { rm -f "$f"; ok "removed $(basename "$f")"; }
done

# --- gah command and the PATH line ------------------------------------------------------
for cmd in gah gg; do
	if [ -f "$HOME/.local/bin/$cmd" ] && grep -qF '# gah deployment command' "$HOME/.local/bin/$cmd"; then
		rm -f "$HOME/.local/bin/$cmd"; ok "removed the $cmd command"
	fi
done
if [ -f "$HOME/.bashrc" ] && grep -qF '# gah deployment path' "$HOME/.bashrc"; then
	grep -vF '# gah deployment path' "$HOME/.bashrc" >"$HOME/.bashrc.gah-tmp" || true
	cat "$HOME/.bashrc.gah-tmp" >"$HOME/.bashrc"; rm -f "$HOME/.bashrc.gah-tmp"
	ok "removed the PATH line from ~/.bashrc"
fi

# --- Stored secrets ----------------------------------------------------------------------
if [ "$KEEP" -eq 0 ]; then
	if [ -f "$SECRETS" ]; then rm -f "$SECRETS"; ok "removed $SECRETS (GitLab token, API keys)"; fi
	rmdir "$(dirname "$SECRETS")" 2>/dev/null || true
else
	ok "kept $SECRETS (--keep-secrets)"
fi

# --- The install root ----------------------------------------------------------------------
# This script usually runs from inside the folder it is about to delete; bash
# has already read it, and a current directory inside it only needs leaving.
case "$PWD/" in "$ROOT"/*) cd "$HOME" ;; esac
if [ -d "$ROOT" ]; then rm -rf "${ROOT:?}"; ok "removed $ROOT (packages, skills cache, downloads)"
else ok "nothing installed at $ROOT"; fi

# --- Agent state ---------------------------------------------------------------------------
STATE="$HOME/.gah"
if [ "$PURGE" -eq 1 ]; then
	[ -d "$STATE" ] && { rm -rf "$STATE"; ok "removed $STATE (auth.json, audit log, sessions)"; }
elif [ -d "$STATE" ]; then
	ok "kept $STATE (API keys from /login, audit log, sessions); rerun with --purge to remove it"
fi

echo
echo "Done. The gah command is gone; a new terminal no longer has the PATH line."
