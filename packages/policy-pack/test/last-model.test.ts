// Unit tests for lib/last-model.ts. Run: make test-policy
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { agentDir, rememberModel, settingsPath } from "../extensions/lib/last-model.ts";

test("agentDir honours GAH_CODING_AGENT_DIR, expands ~, defaults to ~/.gah/agent", () => {
	assert.equal(agentDir({ GAH_CODING_AGENT_DIR: "/x/agent" }, "/home/u"), "/x/agent");
	assert.equal(agentDir({ GAH_CODING_AGENT_DIR: "~/g/agent" }, "/home/u"), join("/home/u", "g/agent"));
	assert.equal(agentDir({}, "/home/u"), join("/home/u", ".gah", "agent"));
	assert.equal(settingsPath("/d"), join("/d", "settings.json"));
});

test("rememberModel creates the file, keeps other keys, and is idempotent", (t) => {
	const dir = mkdtempSync(join(tmpdir(), "gah-last-model-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const path = join(dir, "nested", "settings.json");
	assert.equal(rememberModel("corp", "gpt-5", path), true);
	assert.deepEqual(JSON.parse(readFileSync(path, "utf-8")), { defaultProvider: "corp", defaultModel: "gpt-5" });

	writeFileSync(
		path,
		JSON.stringify({ theme: "dark", defaultProvider: "corp", defaultModel: "gpt-5", compaction: { enabled: true } }),
	);
	assert.equal(rememberModel("corp", "gemini", path), true);
	assert.deepEqual(JSON.parse(readFileSync(path, "utf-8")), {
		theme: "dark",
		defaultProvider: "corp",
		defaultModel: "gemini",
		compaction: { enabled: true },
	});
	assert.ok(!existsSync(`${path}.${process.pid}.tmp`), "no temp file left behind");
});

test("rememberModel leaves a file it cannot parse alone", (t) => {
	const dir = mkdtempSync(join(tmpdir(), "gah-last-model-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const path = join(dir, "settings.json");
	writeFileSync(path, "{ not json");
	assert.equal(rememberModel("corp", "m", path), false);
	assert.equal(readFileSync(path, "utf-8"), "{ not json");
	writeFileSync(path, "[1,2]");
	assert.equal(rememberModel("corp", "m", path), false);
});
