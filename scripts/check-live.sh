#!/usr/bin/env bash
#
# check-live.sh — does this deployment's configured model accept a real tool call?
#
# On demand, in a specific deployment environment. Never in CI: it needs that
# environment's credentials, reaches its providers, and costs cents.
#
# Every other check in this repo is offline, so none of them can see what a
# provider does with the request we send it. #108 is the case that proved it:
# pi 0.86 started asking for strict tool schemas, our seed data said Bedrock's
# Claude models support them, Bedrock forwarded the field to a backend that
# rejects it, and every session failed on its first turn while all four CI
# checks on the sync passed.
#
# WHAT IT TESTS is decided by the environment, not by this script: it asks
# bin/gah which models this environment may use (`--list-models`), under the
# environment's own GAH_BUILTIN_MODELS, approved endpoints (GAH_PROVIDERS_FILE)
# and credentials, and tests exactly those. Nothing here widens the allowlist,
# opens egress or supplies credentials. Named models only narrow the set; a
# model the environment is not configured for is refused, not tested.
#
# Each model gets one print-mode session asking it to call a tool, because a
# request without tools would not have caught #108. The session runs through
# the full path a real one takes: launcher, policy pack, tool declarations,
# provider adapter, egress allowlist, the provider itself.
#
# Usage:
#   scripts/check-live.sh [--env FILE] [provider/model ...]
#   make check-live [ENV=FILE] [MODELS="provider/model ..."]
#
#   --env FILE   Source a host manifest first (/etc/gah/users.d/<user>.conf),
#                exactly as deploy/host/gah-launch does, to check what that
#                user's sessions are configured for. Without it, the current
#                shell's environment is the configuration.
#
# The tool call is audited to a scratch log, not the deployment's own, so the
# assertion does not depend on what else is in that log.
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

ENV_FILE=""
WANT=()
while [ $# -gt 0 ]; do
	case "$1" in
		--env) ENV_FILE="${2:-}"; shift 2 ;;
		--env=*) ENV_FILE="${1#--env=}"; shift ;;
		-h|--help) sed -n '2,39p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
		*) WANT+=("$1"); shift ;;
	esac
done

if [ -n "$ENV_FILE" ]; then
	[ -r "$ENV_FILE" ] || { echo "check-live: cannot read $ENV_FILE" >&2; exit 2; }
	# Same semantics as gah-launch: shell assignments, then exported, because
	# `source` alone does not export and bin/gah reads these from its environment.
	set -a
	# shellcheck source=/dev/null
	source "$ENV_FILE"
	set +a
fi

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
mkdir -p "$WORK/cwd" && printf 'marker\n' >"$WORK/cwd/check-live-marker.txt"

# The environment's configured models, as gah itself sees them.
listing="$(GAH_ALLOW_NO_SKILLS=1 GAH_SKIP_SETUP=1 ./bin/gah --list-models </dev/null 2>&1)"
mapfile -t CONFIGURED < <(printf '%s\n' "$listing" | awk 'NR > 1 && NF >= 2 && $1 != "provider" { print $1 "/" $2 }')
if [ ${#CONFIGURED[@]} -eq 0 ]; then
	echo "check-live: this environment has no models configured, so there is nothing to check." >&2
	printf '%s\n' "$listing" | head -3 | sed 's/^/    /' >&2
	echo "    Configure one (GAH_BUILTIN_MODELS with its credentials, or GAH_PROVIDERS_FILE), or pass --env <manifest>." >&2
	exit 2
fi

MODELS=()
if [ ${#WANT[@]} -eq 0 ]; then
	MODELS=("${CONFIGURED[@]}")
else
	for w in "${WANT[@]}"; do
		if printf '%s\n' "${CONFIGURED[@]}" | grep -qxF "$w"; then
			MODELS+=("$w")
		else
			echo "check-live: $w is not configured in this environment; not testing it." >&2
			echo "    Configured here: ${CONFIGURED[*]}" >&2
			exit 2
		fi
	done
fi

echo "Checking ${#MODELS[@]} configured model(s)${ENV_FILE:+ from $ENV_FILE}:"
fail=0
for spec in "${MODELS[@]}"; do
	audit="$WORK/audit-${RANDOM}${RANDOM}.log"
	out="$(
		cd "$WORK/cwd" &&
			GAH_ALLOW_NO_SKILLS=1 GAH_SKIP_SETUP=1 GAH_AUDIT_LOG="$audit" \
				timeout 180 "$REPO_ROOT/bin/gah" -p --no-session --model "$spec" \
				"Call the ls tool on the current directory. Then reply with the single word DONE." \
				</dev/null 2>&1
	)"
	code=$?
	called="$(grep -c '"tool":"ls"' "$audit" 2>/dev/null || true)"
	if [ "$code" -eq 0 ] && [ "${called:-0}" -gt 0 ] && printf '%s' "$out" | grep -q 'DONE'; then
		echo "✓ $spec: tool call accepted, ran, and the reply came back"
	else
		fail=1
		echo "✗ $spec (exit $code, ls calls audited: ${called:-0})" >&2
		printf '%s\n' "$out" | tail -8 | sed 's/^/    /' >&2
	fi
done

echo
if [ "$fail" -eq 0 ]; then echo "live providers: OK"; else echo "live providers: FAILED" >&2; fi
exit "$fail"
