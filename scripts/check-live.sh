#!/usr/bin/env bash
#
# check-live.sh — one real, tool-bearing request per model, through bin/gah.
#
# Every other check in this repo is offline, so none of them can see what a
# provider does with the request we send it. #108 is the case that proved it:
# pi 0.86 started asking for strict tool schemas, our seed data said Bedrock's
# Claude models support them, Bedrock forwarded the field to a backend that
# rejects it, and every session failed on its first turn -- while all four CI
# checks on the sync passed.
#
# This drives the whole path a session takes (launcher, policy pack, tool
# declarations, provider adapter, the provider itself) and asks the model to
# call a tool, because a request without tools would not have caught #108.
#
# Needs real credentials for each provider named, and costs a few cents. Not in
# CI. Run it before merging a vendor sync (docs/WORKFLOW.md), or after touching
# packages/policy-pack/model-data.
#
# Usage:
#   scripts/check-live.sh [provider/model ...]
#   make check-live [MODELS="amazon-bedrock/us.anthropic.claude-sonnet-5 ..."]
#
# With no arguments it checks the Bedrock model the shared host runs. pi only
# treats Bedrock as configured when it sees an explicit signal (AWS_PROFILE,
# AWS_ACCESS_KEY_ID + AWS_SECRET_ACCESS_KEY, AWS_BEARER_TOKEN_BEDROCK, or an ECS
# role), not a bare ~/.aws/credentials, so this sets AWS_PROFILE=default when
# none of those is present. Set AWS_REGION to the region the host uses.
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

MODELS=("$@")
[ ${#MODELS[@]} -gt 0 ] || MODELS=("amazon-bedrock/us.anthropic.claude-sonnet-5")

if [ -z "${AWS_PROFILE:-}${AWS_ACCESS_KEY_ID:-}${AWS_BEARER_TOKEN_BEDROCK:-}${AWS_CONTAINER_CREDENTIALS_RELATIVE_URI:-}${AWS_CONTAINER_CREDENTIALS_FULL_URI:-}" ] &&
	[ -f "$HOME/.aws/credentials" ]; then
	export AWS_PROFILE=default
fi

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
mkdir -p "$WORK/cwd" && printf 'marker\n' >"$WORK/cwd/check-live-marker.txt"

fail=0
for spec in "${MODELS[@]}"; do
	provider="${spec%%/*}"
	audit="$WORK/audit-$$-${RANDOM}.log"
	# The egress allowlist has its own check; here the question is only whether
	# the provider accepts what we send, so the network is left open.
	out="$(
		cd "$WORK/cwd" &&
			GAH_ALLOW_NO_SKILLS=1 GAH_SKIP_SETUP=1 GAH_ALLOWED_HOSTS='*' \
				GAH_BUILTIN_MODELS="$spec" GAH_AUDIT_LOG="$audit" \
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
		[ "$provider" = "amazon-bedrock" ] && [ -z "${AWS_REGION:-}${AWS_DEFAULT_REGION:-}" ] &&
			echo "    (no AWS_REGION set; relying on the AWS config file's region)" >&2
	fi
done

echo
if [ "$fail" -eq 0 ]; then echo "live providers: OK"; else echo "live providers: FAILED" >&2; fi
exit "$fail"
