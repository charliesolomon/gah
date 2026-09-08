// End-to-end: the policy extension's audit writer rolls yesterday's log and
// prunes past retention on a real temp dir. Run: make test-policy
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

test("audit writer rolls the previous day's log and prunes beyond retention", async (t) => {
	const dir = mkdtempSync(join(tmpdir(), "gah-rot-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const log = join(dir, "audit.log");

	// A current log dated two days ago, plus one dated file inside and one outside a 1-day window.
	writeFileSync(log, '{"ts":"old","kind":"turn"}\n');
	const twoDaysAgo = new Date(Date.now() - 2 * 86400_000);
	utimesSync(log, twoDaysAgo, twoDaysAgo);
	const ymd = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
	const staleDate = ymd(new Date(Date.now() - 10 * 86400_000));
	const freshDate = ymd(new Date(Date.now() - 1 * 86400_000));
	writeFileSync(join(dir, `audit-${staleDate}.log`), "x\n");
	writeFileSync(join(dir, `audit-${freshDate}.log`), "y\n");

	process.env.GAH_AUDIT_LOG = log;
	process.env.GAH_AUDIT_RETENTION_DAYS = "3";
	process.env.GAH_SECRET_FILES = "";
	process.env.GAH_ALLOW_TOOLS = "";

	const handlers: Record<string, any> = {};
	const pi = {
		on: (n: string, f: any) => (handlers[n] = f),
		getAllTools: () => [{ name: "read" }],
		setActiveTools: () => {},
	};
	const mod = await import("../extensions/policy.ts");
	mod.default(pi as any);
	// First audit write triggers the one-shot rotation, then appends.
	await handlers.session_start({}, { sessionManager: { getSessionId: () => "s" } });

	const rolled = ymd(twoDaysAgo);
	assert.ok(existsSync(join(dir, `audit-${rolled}.log`)), "previous-day content rolled to a dated file");
	assert.ok(statSync(log).mtime.getTime() > twoDaysAgo.getTime(), "a fresh audit.log now holds today's lines");
	assert.ok(!existsSync(join(dir, `audit-${staleDate}.log`)), "the 10-day-old file is pruned (retention 3)");
	assert.ok(existsSync(join(dir, `audit-${freshDate}.log`)), "the 1-day-old file is kept");

	const files = readdirSync(dir).filter((f) => f.startsWith("audit"));
	assert.ok(files.includes("audit.log") && files.some((f) => f === `audit-${rolled}.log`));
});
