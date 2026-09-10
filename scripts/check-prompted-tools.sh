#!/usr/bin/env bash
#
# check-prompted-tools.sh — assert that a provider marked "tools": "prompted"
# gets tool use through a gateway that refuses native tool calls (#42).
#
# scripts/mock-openai.mjs in MOCK_MODE=prompted answers 400 to any request
# carrying a `tools` field or a tool-role message, replies to the first request
# with a ```tool block calling $MOCK_TOOL, and says "done" once the history
# holds a <tool_result>. bin/gah runs one print-mode prompt against it with a
# providers.json that marks the mock provider prompted, and this checks:
#   - the wire never carried tools or tool roles, and the prompt carried the protocol;
#   - the parsed call reached the policy: `ls` is audited as allowed;
#   - a `write` to a protected path is audited as blocked and the file is not
#     written, i.e. the policy sees prompted calls exactly as native ones;
#   - a gateway that ends the stream with "length" before the closing fence
#     (MOCK_CUT=1, seen on #74) still gets its whole call executed;
#   - with "toolsPrompt": "user" the request carries no system message at all
#     and the person's turn holds the system prompt plus the protocol (#81).
#     (A tool outside the allowlist is not active at all, so upstream answers
#     "not found" before any policy hook; that path is the same for native
#     calls and is not what this checks.)
#
# Needs a built bin/gah and a free localhost port. No real endpoint, no keys.
# KEEP=1 leaves the work directory behind and prints its path.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

WORK="$(mktemp -d)"
if command -v cygpath >/dev/null 2>&1; then WORK_NATIVE="$(cygpath -w "$WORK")"; else WORK_NATIVE="$WORK"; fi
MOCK_PID=""
cleanup() {
	[ -n "$MOCK_PID" ] && kill "$MOCK_PID" 2>/dev/null || true
	if [ -n "${KEEP:-}" ]; then echo "work dir kept: $WORK"; else rm -rf "$WORK"; fi
}
trap cleanup EXIT

fail=0
check() {
	local label="$1" ok="$2"
	if [ "$ok" = "1" ]; then echo "✓ $label"; else echo "✗ $label" >&2; fail=1; fi
}

# Starts the mock for one scenario and runs gah once. $1 = tool the mock
# calls, $2 = its arguments as a JSON object, $3 = 1 to cut the reply before
# the closing fence, $4 = toolsPrompt placement (system or user).
scenario() {
	local tool="$1" args="${2:-}" cut="${3:-0}" placement="${4:-system}"
	[ -n "$args" ] || args='{"path":"."}'
	[ -n "$MOCK_PID" ] && { kill "$MOCK_PID" 2>/dev/null || true; MOCK_PID=""; }
	: > "$WORK/mock.out"; : > "$WORK/requests.log"; : > "$WORK/audit.log"
	MOCK_LOG="$WORK_NATIVE/requests.log" MOCK_PORT=0 MOCK_MODE=prompted MOCK_TOOL="$tool" MOCK_ARGS="$args" MOCK_CUT="$cut" \
		node scripts/mock-openai.mjs >"$WORK/mock.out" 2>&1 &
	MOCK_PID=$!
	local port=""
	for _ in $(seq 1 50); do
		port=$(sed -n 's/^mock-openai listening on //p' "$WORK/mock.out" 2>/dev/null)
		[ -n "$port" ] && break
		sleep 0.1
	done
	if [ -z "$port" ]; then echo "mock endpoint did not start:" >&2; cat "$WORK/mock.out" >&2; exit 2; fi

	cat > "$WORK/providers.json" <<JSON
{ "providers": [ { "name": "mock", "baseUrl": "http://127.0.0.1:$port/v1", "api": "openai-completions",
  "apiKey": "x", "tools": "prompted", "toolsPrompt": "$placement",
  "models": [ { "id": "m1", "name": "m1", "reasoning": false, "input": ["text"],
    "cost": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0 }, "contextWindow": 100000, "maxTokens": 4096 } ] } ] }
JSON
	(
		export GAH_PROVIDERS_FILE="$WORK_NATIVE/providers.json" GAH_BUILTIN_MODELS='' GAH_ALLOW_MODELS_JSON=0 \
			GAH_ALLOWED_HOSTS=127.0.0.1 GAH_ALLOW_NO_SKILLS=1 GAH_AUDIT_LOG="$WORK_NATIVE/audit.log"
		# stdin closed: print mode reads a piped stdin when there is one, and
		# under some runners that pipe never ends.
		timeout 90 ./bin/gah -p --no-session --model mock/m1 "list the current directory" </dev/null
	) >"$WORK/probe.log" 2>&1 || true
	if [ ! -s "$WORK/requests.log" ]; then
		{ echo "--- probe output (tail) ---"; tail -n 20 "$WORK/probe.log"; echo "---------------------------"; } >&2
		echo "✗ no request reached the mock" >&2; fail=1; return 1
	fi
}

# field <line-number> <json-field>: value of a field in the Nth request log line
field() { node -e 'const l=require("fs").readFileSync(process.argv[1],"utf8").trim().split("\n");const o=JSON.parse(l[Number(process.argv[2])-1]??"{}");const v=o[process.argv[3]];console.log(Array.isArray(v)?v.join(","):String(v))' "$WORK/requests.log" "$1" "$2"; }
requests() { grep -c . "$WORK/requests.log"; }

echo "-- allowlisted tool (ls) --"
if scenario ls; then
	check "first request carried no tools field"            "$([ "$(field 1 hasTools)" = false ] && echo 1 || echo 0)"
	check "first request carried the text protocol"         "$([ "$(field 1 protocolInPrompt)" = true ] && echo 1 || echo 0)"
	check "a second request followed the tool call"          "$([ "$(requests)" -ge 2 ] && echo 1 || echo 0)"
	check "second request carried the result as text, no tool role" "$([ "$(field 2 hasResult)" = true ] && [ "$(field 2 hasToolRoles)" = false ] && echo 1 || echo 0)"
	check "policy audited the prompted call to ls as allowed" "$(grep -q '"kind":"allowed".*"tool":"ls"' "$WORK/audit.log" && echo 1 || echo 0)"
	check "the reply reached the user"                        "$(grep -q 'done' "$WORK/probe.log" && echo 1 || echo 0)"
fi

echo "-- stream ends with length before the closing fence --"
if scenario ls '{"path":"."}' 1; then
	check "the whole call still ran (ls audited as allowed)"   "$(grep -q '"kind":"allowed".*"tool":"ls"' "$WORK/audit.log" && echo 1 || echo 0)"
	check "the result went back and the reply reached the user" "$([ "$(requests)" -ge 2 ] && [ "$(field 2 hasResult)" = true ] && grep -q 'done' "$WORK/probe.log" && echo 1 || echo 0)"
fi

echo "-- toolsPrompt user: system prompt and protocol travel in the person's turn --"
if scenario ls '{"path":"."}' 0 user; then
	check "first request carried no system message"           "$([ "$(field 1 roles)" = "user" ] && echo 1 || echo 0)"
	check "the person's turn carried the protocol"            "$([ "$(field 1 protocolInUser)" = true ] && echo 1 || echo 0)"
	check "the call ran and the reply reached the user"        "$(grep -q '"kind":"allowed".*"tool":"ls"' "$WORK/audit.log" && grep -q 'done' "$WORK/probe.log" && echo 1 || echo 0)"
fi

echo "-- write to a protected path --"
# .env is a protected path fragment in policy.ts; the file lives in the work dir.
if scenario write "{\"path\":\"$WORK_NATIVE/blocked.env\",\"content\":\"x\"}"; then
	check "policy blocked the prompted write"                "$(grep -q '"kind":"blocked","reason":"protected_path","tool":"write"' "$WORK/audit.log" && echo 1 || echo 0)"
	check "the file was not written"                         "$([ ! -e "$WORK/blocked.env" ] && echo 1 || echo 0)"
	check "the refusal went back to the model as a result"   "$([ "$(requests)" -ge 2 ] && [ "$(field 2 hasResult)" = true ] && echo 1 || echo 0)"
fi

[ "$fail" -eq 0 ] && echo "prompted tools: OK"
exit "$fail"
