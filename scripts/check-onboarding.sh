#!/usr/bin/env bash
#
# check-onboarding.sh — gah starts without shared skills and helps finish setup
# from inside the session (#135). Against the mock endpoint, no real model:
#
#   1. A checkout with no skills starts. The model is told the session has no
#      shared skills (so it helps instead of declining), is pointed at
#      /setup-skills, and sees the built-in setup skills.
#   2. GAH_SKILLS_NUDGE=0 keeps the note but drops the pointer; with shared
#      skills loaded the note is gone.
#   3. The model can call gah_setup status, and what comes back names the
#      launcher and never a secret's value.
#   4. preflight.mjs (packages): direct route, proxy from the environment, the
#      deployment's suggested proxy, a proxy that wants a login, a refused key,
#      a missing key, and -- through a pseudo-terminal when `script` exists --
#      a key typed masked and stored 0600.
#
# The packaged launchers' own paths (update, skills fetch, store) need a GitLab
# and are exercised in a container; see docs/DEPLOY-LINUX.md.
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT" || exit 2

WORK="$(mktemp -d)"
if command -v cygpath >/dev/null 2>&1; then WORK_NATIVE="$(cygpath -w "$WORK")"; else WORK_NATIVE="$WORK"; fi
PIDS=()
cleanup() {
	for p in "${PIDS[@]}"; do kill "$p" 2>/dev/null || true; done
	if [ -n "${KEEP:-}" ]; then echo "work dir kept: $WORK"; else rm -rf "$WORK"; fi
}
trap cleanup EXIT
unset GAH_ALLOW_TOOLS GAH_ALLOW_NO_SKILLS GAH_SKILLS_NUDGE GAH_SKILLS_DIR GAH_KB_DIR GAH_LAUNCHER_KIND

fail=0
check() {
	local label="$1" ok="$2"
	if [ "$ok" = "1" ]; then echo "✓ $label"; else echo "✗ $label" >&2; fail=1; fi
}
has() { grep -qF -- "$2" <<<"$1" && echo 1 || echo 0; }
hasnt() { grep -qF -- "$2" <<<"$1" && echo 0 || echo 1; }

# Starts a mock on a free port; prints the port. Extra env goes before the call.
start_mock() {
	local log="$1"; shift
	: >"$WORK/$log.out"
	env "$@" MOCK_LOG="$WORK_NATIVE/$log" MOCK_PORT=0 MOCK_LOG_TEXT=1 node scripts/mock-openai.mjs >"$WORK/$log.out" 2>&1 &
	PIDS+=($!)
	local port=""
	for _ in $(seq 1 50); do
		port=$(sed -n 's/^mock-openai listening on //p' "$WORK/$log.out" 2>/dev/null)
		[ -n "$port" ] && break
		sleep 0.1
	done
	[ -n "$port" ] || { echo "mock did not start" >&2; cat "$WORK/$log.out" >&2; exit 2; }
	echo "$port"
}
providers() { # port tools-mode -> providers.json
	cat >"$WORK/providers.json" <<JSON
{ "providers": [ { "name": "mock", "baseUrl": "http://127.0.0.1:$1/v1", "api": "openai-completions",
  "apiKey": "x"${2:+, \"tools\": \"$2\"},
  "models": [ { "id": "m1", "name": "m1", "reasoning": false, "input": ["text"],
    "cost": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0 }, "contextWindow": 100000, "maxTokens": 4096 } ] } ] }
JSON
}
# One print-mode prompt through bin/gah; extra env as VAR=value arguments.
run_gah() {
	(
		export GAH_PROVIDERS_FILE="$WORK_NATIVE/providers.json" GAH_BUILTIN_MODELS='' GAH_ALLOW_MODELS_JSON=0 \
			GAH_ALLOWED_HOSTS=127.0.0.1 GAH_AUDIT_LOG="$WORK_NATIVE/audit.log" GAH_SKIP_SETUP=1 \
			GAH_CODING_AGENT_DIR="$WORK_NATIVE/agent"
		env "$@" timeout 90 ./bin/gah -p --no-session --model mock/m1 "what can you do?" </dev/null
	) >"$WORK/run.log" 2>&1
}
field() { node -e 'const l=require("fs").readFileSync(process.argv[1],"utf8").trim().split("\n");const r=JSON.parse(l[Number(process.argv[2])]);process.stdout.write(String(r[process.argv[3]]??""))' "$1" "$2" "$3"; }

echo "-- a checkout starts without shared skills --"
PORT="$(start_mock req1)"
providers "$PORT"
run_gah; rc=$?
check "bin/gah starts with no skills configured (exit $rc)" "$([ "$rc" -eq 0 ] && echo 1 || echo 0)"
check "and the request reached the model" "$([ -s "$WORK/req1" ] && echo 1 || echo 0)"
sys="$(field "$WORK/req1" 0 systemText 2>/dev/null)"
check "the model is told the session has no shared skills" "$(has "$sys" "## This session has no shared skills")"
check "and that this lifts 'ask when no skill fits'" "$(has "$sys" "help directly with general requests")"
check "and is told to suggest /setup-skills" "$(has "$sys" "mention once that typing /setup-skills")"
check "the built-in setup-skills skill is listed" "$(has "$sys" "<name>setup-skills</name>")"
check "and setup-gitlab" "$(has "$sys" "<name>setup-gitlab</name>")"
check "gah_setup is among the allowed tools" "$(has "$sys" '`gah_setup`')"

: >"$WORK/req1"
run_gah GAH_SKILLS_NUDGE=0
sys="$(field "$WORK/req1" 0 systemText 2>/dev/null)"
check "GAH_SKILLS_NUDGE=0 keeps the no-skills note" "$(has "$sys" "## This session has no shared skills")"
# The setup skill's own catalogue entry still names /setup-skills; what goes is
# the note's instruction to suggest it.
check "but drops the instruction to suggest /setup-skills" "$(hasnt "$sys" "mention once that typing /setup-skills")"

SK="$WORK/team-skills"
mkdir -p "$SK/skills/ticket-triage"
printf -- '---\nname: ticket-triage\ndescription: Triage a ticket. Use when testing.\n---\nTriage.\n' >"$SK/skills/ticket-triage/SKILL.md"
: >"$WORK/req1"
run_gah GAH_SKILLS_DIR="$SK/skills"
sys="$(field "$WORK/req1" 0 systemText 2>/dev/null)"
check "with shared skills loaded the note is gone" "$(hasnt "$sys" "## This session has no shared skills")"
check "and the shared skill is listed" "$(has "$sys" "<name>ticket-triage</name>")"

echo
echo "-- the model calls gah_setup status --"
PORT="$(start_mock req2 MOCK_MODE=prompted MOCK_TOOL=gah_setup 'MOCK_ARGS={"action":"status"}')"
providers "$PORT" prompted
run_gah GAH_GITLAB_TOKEN=test-value-never-shown-to-the-model GAH_KB_DIR=/nowhere
user2="$(field "$WORK/req2" 1 userText 2>/dev/null)"
check "a second request carries the tool result" "$(has "$user2" '<tool_result tool="gah_setup"')"
check "the status names the launcher" "$(has "$user2" '"launcher": "checkout"')"
check "and counts shared skills" "$(has "$user2" '"sharedSkillsLoaded": 0')"
check "and never a secret's value" "$(hasnt "$user2" "never-shown-to-the-model")"
check "the call is audited" "$(grep -q '"tool":"gah_setup"' "$WORK/audit.log" && echo 1 || echo 0)"

echo
echo "-- preflight.mjs --"
PF="$REPO_ROOT/templates/deploy/preflight.mjs"
# A model-list endpoint that accepts exactly "Bearer good", and a forward proxy
# (CONNECT and absolute-form) through which inference.invalid is reachable.
cat >"$WORK/keymock.mjs" <<'EOF'
import http from "node:http";
const s = http.createServer((req, res) => { res.writeHead(req.headers.authorization === "Bearer good" ? 200 : 401); res.end("{}"); });
s.listen(0, "127.0.0.1", () => console.log(`port ${s.address().port}`));
EOF
cat >"$WORK/proxy.mjs" <<'EOF'
import http from "node:http";
import net from "node:net";
const target = (h) => (h === "inference.invalid" ? "127.0.0.1" : h);
const s = http.createServer((req, res) => {
	if (process.env.PROXY_AUTH) { res.writeHead(407, { "proxy-authenticate": "Basic" }); return res.end(); }
	const u = new URL(req.url);
	const up = http.request({ host: target(u.hostname), port: u.port, path: u.pathname + u.search, method: req.method, headers: req.headers }, (r) => { res.writeHead(r.statusCode, r.headers); r.pipe(res); });
	up.on("error", () => { res.writeHead(502); res.end(); });
	req.pipe(up);
});
s.on("connect", (req, sock, head) => {
	if (process.env.PROXY_AUTH) return sock.end("HTTP/1.1 407 Proxy Authentication Required\r\nContent-Length: 0\r\n\r\n");
	const [h, p] = req.url.split(":");
	const up = net.connect(Number(p), target(h), () => { sock.write("HTTP/1.1 200 Connection Established\r\n\r\n"); up.write(head); up.pipe(sock); sock.pipe(up); });
	up.on("error", () => sock.end("HTTP/1.1 502 Bad Gateway\r\n\r\n"));
});
s.listen(0, "127.0.0.1", () => console.log(`port ${s.address().port}`));
EOF
bg_port() { # file [env...] -> port
	local f="$1"; shift
	env "$@" node "$WORK/$f" >"$WORK/$f.out" 2>&1 &
	PIDS+=($!)
	for _ in $(seq 1 50); do grep -q '^port ' "$WORK/$f.out" 2>/dev/null && break; sleep 0.1; done
	sed -n 's/^port //p' "$WORK/$f.out"
}
KEYPORT="$(bg_port keymock.mjs)"
PROXY="http://127.0.0.1:$(bg_port proxy.mjs)"
cp "$WORK/proxy.mjs" "$WORK/proxy407.mjs"
PROXY407="http://127.0.0.1:$(bg_port proxy407.mjs PROXY_AUTH=1)"

pf_providers() {
	echo "{\"providers\":[{\"name\":\"corp\",\"baseUrl\":\"$1\",\"api\":\"openai-completions\",\"apiKey\":\"\$CORP_KEY\",\"models\":[{\"id\":\"m\"}]}]}" >"$WORK/pf-providers.json"
}
preflight() { # [env...] -- [args...]; sets rc and out
	local envs=()
	while [ $# -gt 0 ] && [ "$1" != "--" ]; do envs+=("$1"); shift; done
	[ "${1:-}" = "--" ] && shift
	rm -f "$WORK/pf-out.json"
	env -u HTTPS_PROXY -u HTTP_PROXY -u https_proxy -u http_proxy -u NODE_USE_ENV_PROXY XDG_CONFIG_HOME="$WORK/cfg" GAH_CODING_AGENT_DIR="$WORK/pf-agent" "${envs[@]}" \
		node --no-warnings "$PF" --deploy "$WORK/pf-deploy.json" --providers "$WORK/pf-providers.json" \
		--state "$WORK/pf-state.json" --out "$WORK/pf-out.json" "$@" </dev/null >"$WORK/pf.log" 2>&1
	rc=$?
	out="$(cat "$WORK/pf-out.json" 2>/dev/null)"
}
echo '{}' >"$WORK/pf-deploy.json"
pf_providers "http://127.0.0.1:$KEYPORT/v1"
rm -f "$WORK/pf-state.json"; preflight CORP_KEY=good
check "direct route, accepted key: ready, no proxy" "$([ "$rc" -eq 0 ] && [ "$out" = '{"proxy":null}' ] && echo 1 || echo 0)"
preflight CORP_KEY=bad
check "a refused key without a terminal stops with code 3" "$([ "$rc" -eq 3 ] && echo 1 || echo 0)"
check "and says the key was refused" "$(has "$(cat "$WORK/pf.log")" "was refused (HTTP 401)")"
preflight
check "a missing key without a terminal stops with code 3" "$([ "$rc" -eq 3 ] && echo 1 || echo 0)"

pf_providers "http://inference.invalid:$KEYPORT/v1"
rm -f "$WORK/pf-state.json"; preflight CORP_KEY=good HTTPS_PROXY="$PROXY"
check "unreachable directly, reachable through HTTPS_PROXY" "$([ "$rc" -eq 0 ] && [ "$out" = "{\"proxy\":\"$PROXY\"}" ] && echo 1 || echo 0)"
preflight CORP_KEY=good
check "the next launch reuses the route without HTTPS_PROXY" "$([ "$rc" -eq 0 ] && [ "$out" = "{\"proxy\":\"$PROXY\"}" ] && echo 1 || echo 0)"
rm -f "$WORK/pf-state.json"; preflight CORP_KEY=good -- --system-proxy "$PROXY"
check "the system proxy the launcher found is tried" "$([ "$rc" -eq 0 ] && [ "$out" = "{\"proxy\":\"$PROXY\"}" ] && echo 1 || echo 0)"
echo "{\"inferenceProxy\":\"$PROXY\"}" >"$WORK/pf-deploy.json"
rm -f "$WORK/pf-state.json"; preflight CORP_KEY=good
check "the deployment's suggested proxy is tried" "$([ "$rc" -eq 0 ] && [ "$out" = "{\"proxy\":\"$PROXY\"}" ] && echo 1 || echo 0)"
echo '{}' >"$WORK/pf-deploy.json"
rm -f "$WORK/pf-state.json"; preflight CORP_KEY=good HTTPS_PROXY="$PROXY407"
check "a proxy that wants a login stops with code 4" "$([ "$rc" -eq 4 ] && echo 1 || echo 0)"
check "and says gah does not support it" "$(has "$(cat "$WORK/pf.log")" "does not support proxies that need one")"
rm -f "$WORK/pf-state.json"; preflight CORP_KEY=good
check "no route at all, without a terminal, stops with code 2" "$([ "$rc" -eq 2 ] && echo 1 || echo 0)"

if command -v script >/dev/null 2>&1 && script --version 2>/dev/null | grep -q util-linux; then
	pf_providers "http://127.0.0.1:$KEYPORT/v1"
	rm -rf "$WORK/cfg" "$WORK/pf-state.json" "$WORK/pf-out.json"
	(sleep 2; printf 'bad\r'; sleep 3; printf 'good\r') |
		env -u CORP_KEY XDG_CONFIG_HOME="$WORK/cfg" GAH_CODING_AGENT_DIR="$WORK/pf-agent" \
			script -qec "node --no-warnings '$PF' --deploy '$WORK/pf-deploy.json' --providers '$WORK/pf-providers.json' --state '$WORK/pf-state.json' --out '$WORK/pf-out.json'" /dev/null \
			>"$WORK/pf-tty.log" 2>&1
	tty_out="$(tr -d '\r' <"$WORK/pf-tty.log")"
	check "in a terminal, a missing key is asked for" "$(has "$tty_out" "gah needs an API key for corp")"
	check "what is typed is masked" "$(hasnt "$tty_out" "good")"
	check "a refused key is asked for again" "$(has "$tty_out" "that key was refused")"
	check "the accepted key is stored for the launcher" "$(grep -qx 'CORP_KEY=good' "$WORK/cfg/gah/secrets.env" 2>/dev/null && echo 1 || echo 0)"
	check "in a file only this user can read" "$([ "$(stat -c %a "$WORK/cfg/gah/secrets.env" 2>/dev/null)" = 600 ] && echo 1 || echo 0)"
	check "and the session can start" "$([ -s "$WORK/pf-out.json" ] && echo 1 || echo 0)"
else
	echo "(masked key entry: SKIPPED, no util-linux script)"
fi

echo
[ "$fail" -eq 0 ] && echo "onboarding: OK" || echo "onboarding: FAILED" >&2
exit "$fail"
