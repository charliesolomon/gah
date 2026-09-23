#!/usr/bin/env node
/**
 * model-data-overrides.mjs — the few places GAH's seed disagrees with upstream.
 *
 * packages/policy-pack/model-data/ holds upstream's generated catalogue, copied
 * as-is by `make refresh-model-data`. A correction made by hand there would be
 * undone by the next refresh, silently, so corrections live here instead and
 * the refresh applies them every time. Each one carries its reason and the
 * evidence that would let it be removed.
 *
 * Idempotent. `--check` exits 1 if any seed file still needs an override, which
 * is what the policy-pack unit test runs.
 *
 * Usage: node scripts/model-data-overrides.mjs [--check] [dir]
 */
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const OVERRIDES = [
	{
		// #108. pi 0.86 made the built-in tools prefer strict JSON-schema sampling,
		// and sends `toolSpec.strict` wherever `compat.supportsStrictMode` is true.
		// Upstream's catalogue sets it for most Bedrock models. Bedrock accepts the
		// field at the Converse layer and forwards it to the model backend; for
		// Claude that backend rejects it ("tools.0.custom.strict: Extra inputs are
		// not permitted") and every session fails on its first turn.
		//
		// Off for every Bedrock model, not only Claude: that is exactly the wire
		// format every pi before 0.86 sent, which is the one proven on hosts, and
		// the other families' claims are unverified. The tools ask for strict with
		// "prefer", so false means the field is simply omitted, never an error.
		//
		// To re-enable a family: configure one of its models in a deployment,
		// prove it there with scripts/check-live.sh, then narrow `match` here.
		file: "amazon-bedrock.json",
		match: () => true,
		apply: (model) => {
			if (model.compat?.supportsStrictMode === false) return false;
			if (!model.compat || model.compat.supportsStrictMode === undefined) return false;
			model.compat.supportsStrictMode = false;
			return true;
		},
		describe: "compat.supportsStrictMode -> false (Bedrock rejects toolSpec.strict, #108)",
	},
];

const args = process.argv.slice(2);
const check = args.includes("--check");
const dir =
	args.find((a) => !a.startsWith("--")) ??
	join(dirname(fileURLToPath(import.meta.url)), "..", "packages", "policy-pack", "model-data");

const present = new Set(readdirSync(dir));
let pending = 0;
for (const o of OVERRIDES) {
	if (!present.has(o.file)) continue;
	const path = join(dir, o.file);
	const raw = readFileSync(path, "utf8");
	const data = JSON.parse(raw);
	let changed = 0;
	for (const models of Object.values(data)) {
		for (const [id, model] of Object.entries(models)) {
			if (o.match(id, model) && o.apply(model)) changed++;
		}
	}
	if (changed === 0) continue;
	pending += changed;
	if (check) {
		console.error(`${o.file}: ${changed} model(s) need ${o.describe}`);
	} else {
		// Keep the source's own formatting (upstream writes one line) so the diff
		// is only the override and a later refresh diffs cleanly against it.
		const indent = raw.trimStart().startsWith("{\n") ? (/^( +|\t)/m.exec(raw)?.[1] ?? "\t") : undefined;
		writeFileSync(path, `${JSON.stringify(data, null, indent)}${raw.endsWith("\n") ? "\n" : ""}`);
		console.log(`${o.file}: ${changed} model(s) — ${o.describe}`);
	}
}
if (check && pending > 0) {
	console.error("Run: node scripts/model-data-overrides.mjs");
	process.exit(1);
}
if (!check && pending === 0) console.log("model-data overrides: nothing to change");
