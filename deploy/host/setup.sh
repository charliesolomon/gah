#!/usr/bin/env bash
#
# setup.sh — bootstrap a shared GAH agent host (Debian/Ubuntu). Idempotent;
# re-run freely after changes. Run as root:
#
#   sudo GAH_REPO=git@github.com:charliesolomon/gah.git ./setup.sh
#
# What it does:
#   1. Installs prerequisites (git, tmux, Node >= 22).
#   2. Clones/updates + builds gah at /opt/gah (root-owned; agents get r-x).
#   3. Installs the launcher chain to /usr/local/bin and config to /etc/gah.
#   4. Creates the gah-agents group.
#
# It does NOT create user accounts (gah-adduser) or place AWS credentials
# (Phase 2). See README.md in this directory for the full runbook.
#
set -euo pipefail

GAH_HOME="${GAH_HOME:-/opt/gah}"
GAH_REPO="${GAH_REPO:-https://github.com/charliesolomon/gah.git}"
GAH_REF="${GAH_REF:-main}"
NODE_MIN_MAJOR=22
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

[ "$(id -u)" = 0 ] || { echo "setup.sh must run as root" >&2; exit 1; }

echo ">>> prerequisites"
apt-get update -qq
apt-get install -y -qq git tmux curl ca-certificates

node_major=0
if command -v node >/dev/null 2>&1; then
	node_major="$(node -v | sed 's/^v\([0-9]*\).*/\1/')"
fi
if [ "$node_major" -lt "$NODE_MIN_MAJOR" ]; then
	echo ">>> installing Node ${NODE_MIN_MAJOR}.x (found major: $node_major; upstream PI needs >= 22.19)"
	curl -fsSL "https://deb.nodesource.com/setup_${NODE_MIN_MAJOR}.x" | bash -
	apt-get install -y -qq nodejs
fi

echo ">>> gah build at $GAH_HOME (ref: $GAH_REF)"
if [ -d "$GAH_HOME/.git" ]; then
	git -C "$GAH_HOME" fetch --quiet origin
	git -C "$GAH_HOME" checkout --quiet "$GAH_REF"
	git -C "$GAH_HOME" pull --ff-only --quiet origin "$GAH_REF" 2>/dev/null || true
else
	git clone --branch "$GAH_REF" "$GAH_REPO" "$GAH_HOME"
fi
make -C "$GAH_HOME" install
make -C "$GAH_HOME" build-all
make -C "$GAH_HOME" smoke

echo ">>> launchers + config"
install -m 0755 "$HERE/gah-session" /usr/local/bin/gah-session
install -m 0755 "$HERE/gah-launch" /usr/local/bin/gah-launch
install -m 0755 "$HERE/gah-adduser" /usr/local/bin/gah-adduser
install -m 0755 "$HERE/gah-update" /usr/local/bin/gah-update
install -d -m 0755 /etc/gah /etc/gah/users.d
install -m 0644 "$HERE/tmux.conf" /etc/gah/tmux.conf
install -m 0644 "$HERE/users.d/agent.conf.example" /etc/gah/users.d/agent.conf.example

# gah-session is a login shell; register it so chsh & friends accept it.
grep -qx /usr/local/bin/gah-session /etc/shells || echo /usr/local/bin/gah-session >>/etc/shells

groupadd -f gah-agents

cat <<'EOF'

setup: OK

Next steps:
  1. (Once) Drop a read-only deploy key for the skills repo at
     /etc/gah/skills-deploy-key (root:gah-agents, mode 0640).
  2. Create agent accounts:  gah-adduser <username> [<pubkey-file>]
  3. Edit each /etc/gah/users.d/<username>.conf (skills repo, models, tools).
  4. Phase 2: place per-user IAM credentials in ~<user>/.aws/credentials.
EOF
