// Unit tests for lib/help.ts (#142). Run: make test-policy
import assert from "node:assert/strict";
import { test } from "node:test";
import { formatSessionHelp, NEXT_COMMANDS, type SessionRow } from "../extensions/lib/help.ts";

// The shape gahSessionRows returns (cli/gah-help.ts); scripts/check-help.sh
// checks the real rows against --help end to end.
const ROWS: SessionRow[] = [
	{ key: "tools", label: "Tools", value: "read, grep, find, ls, edit, write" },
	{ key: "models", label: "Models", value: "amazon-bedrock/us.anthropic.*" },
	{ key: "endpoints", label: "Endpoints file", value: "/home/u/.gah/providers.json (absent)", absent: true },
	{ key: "network", label: "Network", value: "bedrock-runtime.us-west-1.amazonaws.com" },
	{ key: "skills", label: "Skills", value: "/home/u/.gah/skills-repo/skills (12 skills)" },
	{ key: "audit", label: "Audit log", value: "/home/u/.gah/audit.log" },
];

test("shows every row's value, with the version", () => {
	const out = formatSessionHelp(ROWS, { version: "1.2.3", kind: "host" });
	assert.match(out, /^This session \(gah 1\.2\.3\)/);
	for (const r of ROWS.filter((r) => !r.absent)) {
		assert.match(out, new RegExp(`^  ${r.label} +${r.value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "m"));
	}
});

test("leaves out a row naming what the session does not have, and shows it once it does", () => {
	const out = formatSessionHelp(ROWS, { version: "1", kind: "package" });
	assert.doesNotMatch(out, /Endpoints file/);
	const present = ROWS.map((r) => (r.key === "endpoints" ? { ...r, value: "/srv/providers.json", absent: false } : r));
	assert.match(formatSessionHelp(present, { version: "1", kind: "package" }), /^ {2}Endpoints file +\/srv\/providers\.json$/m);
});

test("points to the next commands", () => {
	const out = formatSessionHelp(ROWS, { version: "1", kind: "checkout" });
	for (const [name, text] of NEXT_COMMANDS) assert.ok(out.includes(`${name}`) && out.includes(text), name);
});

test("on the shared host, the administrator changes the setup; elsewhere, gah --help has more", () => {
	const host = formatSessionHelp(ROWS, { version: "1", kind: "host" });
	assert.match(host, /administrator/);
	assert.doesNotMatch(host, /--help/);
	for (const kind of ["package", "checkout"] as const) {
		const out = formatSessionHelp(ROWS, { version: "1", kind });
		assert.match(out, /gah --help/);
		assert.doesNotMatch(out, /administrator/);
	}
});

test("carries none of the page's notes about variables and flags", () => {
	const out = formatSessionHelp(ROWS, { version: "1", kind: "host" });
	assert.doesNotMatch(out, /GAH_|--skill|--list-models/);
});
