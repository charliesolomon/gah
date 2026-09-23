// The seed model data carries GAH's corrections to upstream's catalogue
// (scripts/model-data-overrides.mjs). `make refresh-model-data` re-copies
// upstream's files and re-applies them; this fails if a refresh, a hand copy or
// a merge ever lands the seed without them. #108: one wrong flag there failed
// every Bedrock session on its first turn while every offline check passed.
// Run: make test-policy
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const REPO = join(import.meta.dirname, "..", "..", "..");
const SCRIPT = join(REPO, "scripts", "model-data-overrides.mjs");
const SEED = join(REPO, "packages", "policy-pack", "model-data");

const run = (...args: string[]) => spawnSync(process.execPath, [SCRIPT, ...args], { encoding: "utf8" });

test("the committed seed already carries every override", () => {
	const r = run("--check", SEED);
	assert.equal(r.status, 0, `seed is missing an override:\n${r.stderr}`);
});

test("no Bedrock model claims strict tool schemas (#108)", () => {
	const data = JSON.parse(readFileSync(join(SEED, "amazon-bedrock.json"), "utf8"));
	const claiming = Object.values(data)
		.flatMap((models) => Object.entries(models as Record<string, { compat?: { supportsStrictMode?: boolean } }>))
		.filter(([, m]) => m.compat?.supportsStrictMode === true)
		.map(([id]) => id);
	assert.deepEqual(claiming, [], "Bedrock forwards toolSpec.strict to backends that reject it");
});

test("--check catches upstream's value, and applying fixes it without touching anything else", () => {
	const dir = mkdtempSync(join(tmpdir(), "gah-model-data-"));
	try {
		// Upstream's shape, one line, as the refresh copies it.
		const upstream = {
			"bedrock-converse-stream": {
				"us.anthropic.claude-sonnet-5": { id: "us.anthropic.claude-sonnet-5", compat: { supportsStrictMode: true, other: 1 } },
				"amazon.nova-pro-v1:0": { id: "amazon.nova-pro-v1:0", compat: {} },
			},
		};
		const path = join(dir, "amazon-bedrock.json");
		writeFileSync(path, `${JSON.stringify(upstream)}\n`);

		assert.equal(run("--check", dir).status, 1, "a refreshed file must fail the check");
		assert.equal(run(dir).status, 0);

		const raw = readFileSync(path, "utf8");
		assert.equal(raw.split("\n").length, 2, "keeps upstream's one-line formatting");
		const fixed = JSON.parse(raw);
		const sonnet = fixed["bedrock-converse-stream"]["us.anthropic.claude-sonnet-5"];
		assert.equal(sonnet.compat.supportsStrictMode, false);
		assert.equal(sonnet.compat.other, 1, "other compat fields survive");
		assert.deepEqual(fixed["bedrock-converse-stream"]["amazon.nova-pro-v1:0"].compat, {}, "does not invent the field");
		assert.equal(run("--check", dir).status, 0, "idempotent");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
