#!/usr/bin/env bash
#
# check-no-builtins.sh — assert that none of upstream's built-in extensions load.
#
# pi 0.99 ships MCP, codemode, tool search and llama.cpp as built-in extensions,
# enabled unless extensions are off. MCP runs stdio servers as child processes,
# which the egress allowlist (0011) never sees. bin/gah passes --no-extensions,
# and patch 0020 sets the same for a baked package; upstream's loader then drops
# the built-ins along with auto-discovered extensions. This fails if it ever
# stops doing so.
#
# Asks bin/gah over RPC for its commands and fails on any whose source is
# "builtin". A built-in that registers no command would not show here; the tool
# side of the same question is check-tool-surface.sh.
#
# Extra arguments go to gah, so `scripts/check-no-builtins.sh -e builtin:mcp`
# shows the check failing. No network, no keys.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

out=$( (echo '{"id":"1","type":"get_commands"}'; sleep 3) \
	| GAH_ALLOW_NO_SKILLS=1 timeout 30 ./bin/gah --mode rpc "$@" 2>/dev/null || true)

printf '%s\n' "$out" | node -e '
let s = "";
process.stdin.on("data", (d) => (s += d)).on("end", () => {
	const reply = s
		.split("\n")
		.filter((l) => l.startsWith("{"))
		.map((l) => JSON.parse(l))
		.find((m) => m.command === "get_commands");
	if (!reply?.success) {
		console.error("check-no-builtins: no get_commands response over RPC");
		process.exit(1);
	}
	const builtins = reply.data.commands
		.filter((c) => c.sourceInfo?.source === "builtin")
		.map((c) => `/${c.name} (${c.sourceInfo.path})`);
	if (builtins.length > 0) {
		console.error(`check-no-builtins: built-in extensions loaded: ${builtins.join(", ")}`);
		process.exit(1);
	}
	console.log("no built-in extensions OK");
});
'
