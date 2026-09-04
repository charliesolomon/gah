#!/usr/bin/env bash
#
# check-tool-surface.sh — assert that the model is offered exactly the tools the
# policy allows.
#
# The allowlist in policy.ts is only half of the control: upstream decides which
# registered tools are *active*, and by default that is read/bash/edit/write.
# Until #35, GAH blocked bash but still offered it, and allowed ls but never
# offered it. Nothing in a normal session shows the offered set, so this runs
# bin/gah in print mode against scripts/mock-openai.mjs, which records the tool
# definitions in each request, and compares.
#
# Needs a built bin/gah and a free localhost port. No real endpoint, no keys.
# GAH_CLI=/path/to/package/bundle/cli.js checks an assembled deployment package
# instead of bin/gah: node runs that file with --no-extensions and its baked
# gah-policy/ loads via patch 0020. Quoted, so paths with spaces work.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

WORK="$(mktemp -d)"
# Under Git Bash on Windows, node gets Windows paths in arguments (converted
# automatically) but not in environment variables: /tmp/tmp.X reaches it as a
# path it cannot create. Hand it the native form for everything passed by env.
if command -v cygpath >/dev/null 2>&1; then WORK_NATIVE="$(cygpath -w "$WORK")"; else WORK_NATIVE="$WORK"; fi
MOCK_PID=""
trap '[ -n "$MOCK_PID" ] && kill "$MOCK_PID" 2>/dev/null || true; rm -rf "$WORK"' EXIT

# Any free port: a fixed one collides with a mock left over from an earlier,
# interrupted run, and the failure then looks like "no request reached the mock".
MOCK_LOG="$WORK_NATIVE/requests.log" MOCK_PORT=0 node scripts/mock-openai.mjs >"$WORK/mock.out" 2>&1 &
MOCK_PID=$!
PORT=""
for _ in $(seq 1 50); do
	PORT=$(sed -n 's/^mock-openai listening on //p' "$WORK/mock.out" 2>/dev/null)
	[ -n "$PORT" ] && break
	sleep 0.1
done
if [ -z "$PORT" ]; then
	echo "mock endpoint did not start:" >&2; cat "$WORK/mock.out" >&2; exit 2
fi

mkdir -p "$WORK/agent"
cat > "$WORK/agent/models.json" <<JSON
{ "providers": { "mock": { "name": "mock", "api": "openai-completions",
  "baseUrl": "http://127.0.0.1:$PORT/v1", "apiKey": "x",
  "models": [ { "id": "m1", "input": ["text"] } ] } } }
JSON

# Runs one print-mode prompt through bin/gah and prints the tool names the
# mock saw, comma-joined. Extra args go to bin/gah.
offered() {
	# One retry: an isolated miss was seen once on a loaded machine and did not
	# reproduce; a flaky guard is worse than none.
	for _attempt in 1 2; do
		: > "$WORK/requests.log"
		(
			export GAH_CODING_AGENT_DIR="$WORK_NATIVE/agent" GAH_ALLOW_MODELS_JSON=1 GAH_BUILTIN_MODELS='' \
				GAH_ALLOWED_HOSTS=127.0.0.1 GAH_ALLOW_NO_SKILLS=1 GAH_AUDIT_LOG="$WORK_NATIVE/audit.log"
			if [ -n "${GAH_CLI:-}" ]; then
				timeout 90 node "$GAH_CLI" --no-extensions -p --no-session --model mock/m1 "$@" "hi"
			else
				timeout 90 ./bin/gah -p --no-session --model mock/m1 "$@" "hi"
			fi
		) >"$WORK/probe.log" 2>&1 || true
		[ -s "$WORK/requests.log" ] && break
	done
	if [ ! -s "$WORK/requests.log" ]; then
		# Say why, or CI reports a bare miss for a crash at import time.
		{ echo "--- last probe output (tail) ---"; tail -n 15 "$WORK/probe.log" 2>/dev/null; echo "--------------------------------"; } >&2
		echo "(no request reached the mock)"
		return
	fi
	node -e 'const l=require("fs").readFileSync(process.argv[1],"utf8").trim().split("\n").pop();console.log(JSON.parse(l).tools.join(","))' "$WORK/requests.log"
}

fail=0
check() {
	local label="$1" expected="$2" got="$3"
	if [ "$got" = "$expected" ]; then
		echo "✓ $label: $got"
	else
		echo "✗ $label: expected [$expected], got [$got]" >&2
		fail=1
	fi
}

check "default launch offers exactly the allowlist" "read,grep,find,ls,edit,write" "$(offered)"
check "GAH_ALLOW_TOOLS=bash adds bash, nothing else" "read,grep,find,ls,edit,write,bash" "$(GAH_ALLOW_TOOLS=bash offered)"
# --tools restricts which tools are registered at all, so the policy can only
# activate what is left: the flag can narrow the set but never widen it past
# the allowlist (bash is dropped, grep/find/ls cannot be added back).
check "--tools narrows but cannot widen past the policy" "read,edit,write" "$(offered --tools read,bash,edit,write)"

grep -q '"reason":"active_tools"' "$WORK/audit.log" && echo "✓ active tool set is audited" || { echo "✗ no active_tools audit line" >&2; fail=1; }

[ "$fail" -eq 0 ] && echo "tool surface: OK"
exit "$fail"
