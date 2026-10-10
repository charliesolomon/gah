#!/usr/bin/env bash
#
# check-help.sh — what a session may use reads the same everywhere it is shown
# (#142). No network and no model: --help starts no session, and /help is a
# command, run through RPC mode.
#
#   1. A checkout: --help counts the skills folder the way pi loads it, and
#      /help in a session shows the same value for every row.
#   2. The shared host (GAH_LAUNCHER_KIND=host, one --skill per skill): --help
#      counts the skills under their folder and lists no usage, options or
#      examples; /help agrees with it and sends people to their administrator.
#   3. gah-launch --help, sandboxed: the account's manifest decides the rows,
#      nothing is synced or created, and headless options are refused with it.
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT" || exit 2
[ -f vendor/pi/packages/coding-agent/dist/cli.js ] || { echo "no built CLI: run make build first" >&2; exit 2; }

WORK="$(mktemp -d)"
cleanup() { if [ -n "${KEEP:-}" ]; then echo "work dir kept: $WORK"; else rm -rf "$WORK"; fi; }
trap cleanup EXIT
unset GAH_ALLOW_TOOLS GAH_SKILLS_DIR GAH_KB_DIR GAH_LAUNCHER_KIND GAH_SCAFFOLD_COMMANDS GAH_SESSION_SKILLS_DIR \
	GAH_SKILLS_UPDATE_FAILED GAH_SETUP_SKILLS GAH_SETUP_SKILLS_DIR

fail=0
check() {
	local label="$1" ok="$2"
	if [ "$ok" = "1" ]; then echo "✓ $label"; else echo "✗ $label" >&2; fail=1; fi
}
has() { grep -qF -- "$2" <<<"$1" && echo 1 || echo 0; }
hasnt() { grep -qF -- "$2" <<<"$1" && echo 0 || echo 1; }

skill() { # parent name: a folder holding one skill pi will load
	mkdir -p "$1/$2"
	printf -- '---\nname: %s\ndescription: %s. Use when testing.\n---\nBody.\n' "$2" "$2" >"$1/$2/SKILL.md"
}

# A row's value, from --help or /help: the line starts with two spaces and the
# label, then the value after the padding. Colour is stripped in case it is forced.
row() { sed 's/\x1b\[[0-9;]*m//g' <<<"$1" | sed -n "s/^  $2  *//p" | head -1; }
agree() { # label page session
	local p s
	p="$(row "$2" "$1")"
	s="$(row "$3" "$1")"
	check "/help and --help agree on $1: $p" "$([ -n "$p" ] && [ "$p" = "$s" ] && echo 1 || echo 0)"
}

# The text /help sent, from the RPC event stream on stdin.
cat >"$WORK/notify.mjs" <<'JS'
let input = "";
process.stdin.on("data", (d) => (input += d));
process.stdin.on("end", () => {
	for (const line of input.split("\n")) {
		let e;
		try { e = JSON.parse(line); } catch { continue; }
		if (e.type === "extension_ui_request" && e.method === "notify" && /^This session/.test(e.message)) {
			process.stdout.write(e.message);
			return;
		}
	}
	process.exitCode = 1;
});
JS
session_help() { # launcher and its arguments
	printf '%s\n' '{"type":"prompt","message":"/help"}' |
		timeout 60 "$@" --mode rpc --no-session 2>>"$WORK/rpc.err" | node "$WORK/notify.mjs"
}

# What a launcher would set, for --help and the session alike.
export GAH_AUDIT_LOG="$WORK/audit.log" GAH_CODING_AGENT_DIR="$WORK/agent" GAH_PROVIDERS_FILE="$WORK/providers.json" \
	GAH_BUILTIN_MODELS="anthropic/claude-*" GAH_ALLOWED_HOSTS="127.0.0.1" GAH_ALLOW_MODELS_JSON=0 \
	GAH_SKIP_SETUP=1 GAH_ALLOW_NO_SKILLS=1

echo "-- a checkout --"
SK="$WORK/repo/skills"
skill "$SK" brief
skill "$SK" triage
skill "$SK/group" nested
page="$(GAH_SKILLS_DIR="$SK" ./bin/gah --help </dev/null 2>&1)"
check "--help counts the skills folder the way pi loads it, nested skills included" "$(has "$page" "$SK (3 skills)")"
check "and lists the command-line options" "$(has "$page" "Options:")"
session="$(GAH_SKILLS_DIR="$SK" session_help ./bin/gah)"
check "/help runs in a session" "$([ -n "$session" ] && echo 1 || echo 0)"
for label in Tools Models Network Skills "Audit log"; do agree "$label" "$page" "$session"; done
check "/help leaves out an endpoints file that is absent" "$(hasnt "$session" "Endpoints file")"
check "and points to gah --help for the options" "$(has "$session" "gah --help")"

echo
echo "-- the shared host, through bin/gah --"
MINE="$WORK/my-skills"
skill "$MINE" notes
printf '{ "providers": [] }\n' >"$GAH_PROVIDERS_FILE"
host_args=(--no-skills --skill "$MINE/notes" --skill "$SK/brief" --skill "$SK/triage")
page="$(GAH_LAUNCHER_KIND=host ./bin/gah "${host_args[@]}" --help </dev/null 2>&1)"
check "--help counts skills passed one by one under their folder, a lone one by its path" \
	"$(has "$page" "$MINE/notes, $SK (2 skills)")"
for text in "Usage:" "Options:" "Examples:" "Environment:" "--continue" "--help --verbose"; do
	check "it lists no $text" "$(hasnt "$page" "$text")"
done
check "it says where to look instead" "$(has "$page" "In a session, /help")"
session="$(GAH_LAUNCHER_KIND=host session_help ./bin/gah "${host_args[@]}")"
for label in Tools Models "Endpoints file" Network Skills "Audit log"; do agree "$label" "$page" "$session"; done
check "/help sends people to their administrator" "$(has "$session" "administrator")"

echo
echo "-- gah-launch --help, sandboxed --"
if ! stat -c %U / >/dev/null 2>&1; then
	echo "  (no GNU stat here — skipping; the host launcher needs Linux)"
else
	# The launcher's three host-specific lines, pointed into the sandbox: the
	# build, the configuration directory and the manifest's required owner.
	# Each must match exactly once, so a change to the launcher fails loudly here.
	TU="$(id -un)"
	LAUNCH="$WORK/gah-launch"
	node -e '
		const fs = require("node:fs");
		const [src, dst, home, conf, user] = process.argv.slice(1);
		let s = fs.readFileSync(src, "utf8");
		for (const [from, to] of [
			[`GAH_HOME="/opt/gah"`, `GAH_HOME="${home}"`],
			[`CONF_DIR="/etc/gah"`, `CONF_DIR="${conf}"`],
			[`[ "$owner" = "root" ]`, `[ "$owner" = "${user}" ]`],
		]) {
			if (s.split(from).length !== 2) { console.error(`expected once in gah-launch: ${from}`); process.exit(1); }
			s = s.replace(from, to);
		}
		fs.writeFileSync(dst, s, { mode: 0o755 });
	' deploy/host/gah-launch "$LAUNCH" "$REPO_ROOT" "$WORK/etc" "$TU"
	check "the sandboxed launcher differs from the real one in three lines" \
		"$([ "$(diff deploy/host/gah-launch "$LAUNCH" | grep -c '^>')" = 3 ] && echo 1 || echo 0)"

	# An account whose checkout has no .git: a launch would try to clone the
	# (missing) repository, so any sync attempt shows up as a warning.
	ACCT="$WORK/home"
	skill "$ACCT/.gah/skills-repo/skills" brief
	skill "$ACCT/.gah/skills-repo/skills" triage
	skill "$ACCT/.gah/my-skills" notes
	mkdir -p "$WORK/etc/users.d"
	cat >"$WORK/etc/users.d/$TU.conf" <<CONF
SKILLS_REPO="$WORK/no-such-remote.git"
GAH_BUILTIN_MODELS="amazon-bedrock/us.anthropic.*"
GAH_ALLOWED_HOSTS="bedrock-runtime.us-west-1.amazonaws.com"
CONF
	# Through a pseudo-terminal when `script` exists, as an administrator would
	# run it: a launch turns echo off and clears the screen only on a terminal.
	cat >"$WORK/launch.sh" <<SH
#!/usr/bin/env bash
exec env -i PATH="$PATH" HOME="$ACCT" USER="$TU" TERM=xterm bash "$LAUNCH" "\$@"
SH
	chmod +x "$WORK/launch.sh"
	launch() {
		if command -v script >/dev/null 2>&1; then
			timeout 60 script -qec "$WORK/launch.sh $*" /dev/null </dev/null 2>&1
		else
			timeout 60 "$WORK/launch.sh" "$@" </dev/null 2>&1
		fi
	}
	out="$(launch --help)"
	check_rc=$?
	check "gah-launch --help exits 0" "$([ "$check_rc" -eq 0 ] && echo 1 || echo 0)"
	check "it prints the host page" "$(has "$out" "On this host")"
	check "with the account's models, from its manifest" "$(has "$out" "amazon-bedrock/us.anthropic.*")"
	check "and its network hosts" "$(has "$out" "bedrock-runtime.us-west-1.amazonaws.com")"
	check "and its skills: the personal one by path, the shared ones by folder" \
		"$(has "$out" "$ACCT/.gah/my-skills/notes, $ACCT/.gah/skills-repo/skills (2 skills)")"
	check "it synced nothing" "$(grep -qE 'clone failed|update failed|not updated' <<<"$out" && echo 0 || echo 1)"
	check "it created no work directory" "$([ ! -e "$ACCT/work" ] && echo 1 || echo 0)"
	check "and did not clear the screen" "$(grep -q $'\033\\[2J' <<<"$out" && echo 0 || echo 1)"
	out="$(launch --help --print prompts/job.md)"
	check_rc=$?
	check "--help with headless options is refused" \
		"$([ "$check_rc" -eq 2 ] && [ "$(has "$out" "--help takes no other options")" = 1 ] && echo 1 || echo 0)"
fi

echo
if [ "$fail" -eq 0 ]; then echo "check-help: OK"; else echo "check-help: FAILED" >&2; [ -s "$WORK/rpc.err" ] && sed -n 1,20p "$WORK/rpc.err" >&2; fi
exit "$fail"
