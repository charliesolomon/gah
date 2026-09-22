#!/usr/bin/env node

/**
 * GAH: materialise src/providers/data/ without touching the network.
 *
 * Upstream's build runs generate-models.ts --strict, which hydrates the model
 * catalogue from ~20 vendor APIs and makes any single failure fatal. GAH hides
 * that catalogue at runtime (patch 0010) and allowlists a handful of models
 * back, so a fresh clone paid for a fetch it could not use and could not build
 * at all behind a filtering proxy.
 *
 * This script replaces that step. For every provider shard the tracked
 * aggregator imports it writes src/providers/data/<provider>.json, taking the
 * file verbatim from a GAH-controlled seed directory when one is there and an
 * empty catalogue ({}) otherwise, then writes the manifest check:model-data
 * expects and validates the result exactly as the generator would have.
 *
 * Seed directory, in order:
 *   - $GAH_MODEL_DATA_DIR, if set (empty string = no seed: everything empty)
 *   - ../../../../packages/policy-pack/model-data relative to this package,
 *     i.e. the GAH checkout that vendors this tree
 *   - none: every provider ships empty
 *
 * Why a build script and not a policy-pack extension: the data files are
 * imported by the provider shards at compile time, so they must exist before
 * tsgo runs. Nothing that loads at runtime can supply them.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
	createModelDataManifest,
	MODEL_DATA_MANIFEST_FILE,
	type ModelDataStructure,
	readModelDataProviderIds,
	validateGeneratedModelData,
} from "./model-data.ts";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_SEED_DIR = join(packageRoot, "..", "..", "..", "..", "packages", "policy-pack", "model-data");

function resolveSeedDir(): string | undefined {
	const fromEnv = process.env.GAH_MODEL_DATA_DIR;
	if (fromEnv !== undefined) {
		if (fromEnv === "") return undefined;
		const dir = resolve(fromEnv);
		if (!existsSync(dir)) throw new Error(`GAH_MODEL_DATA_DIR does not exist: ${dir}`);
		return dir;
	}
	return existsSync(DEFAULT_SEED_DIR) ? DEFAULT_SEED_DIR : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Model id → API group, as the manifest's structure hash wants it. */
function structureOf(path: string, content: string): Record<string, string> {
	let groups: unknown;
	try {
		groups = JSON.parse(content);
	} catch (error) {
		throw new Error(`${path} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
	}
	if (!isRecord(groups)) throw new Error(`${path} must contain a JSON object of API groups`);
	const structure: Record<string, string> = {};
	for (const [api, models] of Object.entries(groups)) {
		if (!isRecord(models)) throw new Error(`${path} API group ${JSON.stringify(api)} must be an object`);
		for (const modelId of Object.keys(models)) {
			if (modelId in structure) throw new Error(`${path} contains model ${modelId} in more than one API group`);
			structure[modelId] = api;
		}
	}
	return structure;
}

function main(): void {
	const providerIds = readModelDataProviderIds(packageRoot);
	const seedDir = resolveSeedDir();
	const seedFiles = new Set(seedDir ? readdirSync(seedDir).filter((entry) => entry.endsWith(".json")) : []);

	// A seed file for a provider upstream no longer has would be silently
	// ignored otherwise — and that is exactly the case worth hearing about.
	const orphans = Array.from(seedFiles).filter((file) => !providerIds.includes(file.replace(/\.json$/, "")));
	if (orphans.length > 0) {
		throw new Error(
			`${seedDir} seeds providers that have no shard in this tree: ${orphans.join(", ")}. ` +
				"Upstream may have renamed or dropped them; remove or rename the files.",
		);
	}

	const fileContents: Record<string, string> = {};
	const structure: ModelDataStructure = {};
	const seeded: string[] = [];
	for (const providerId of providerIds) {
		const filename = `${providerId}.json`;
		if (seedDir && seedFiles.has(filename)) {
			const seedPath = join(seedDir, filename);
			const content = readFileSync(seedPath, "utf8");
			structure[providerId] = structureOf(seedPath, content);
			fileContents[filename] = content;
			seeded.push(providerId);
		} else {
			structure[providerId] = {};
			fileContents[filename] = "{}\n";
		}
	}

	// Written in place: no staging directory, no directory rename, no recursive
	// delete. Upstream's generator stages under a mkdtemp directory and swaps it
	// in, and this script did the same at first -- on a managed Windows machine
	// the final rmSync of the staging directory failed with EPERM (antivirus
	// holding a handle on files it had just scanned is the usual cause). The
	// output here is deterministic, so there is nothing to roll back to: a run
	// that fails is simply re-run.
	const dataDir = join(packageRoot, "src", "providers", "data");
	mkdirSync(dataDir, { recursive: true });
	for (const [filename, content] of Object.entries(fileContents)) {
		writeFileSync(join(dataDir, filename), content);
	}
	writeFileSync(
		join(dataDir, MODEL_DATA_MANIFEST_FILE),
		`${JSON.stringify(createModelDataManifest(structure, fileContents, new Date().toISOString()))}\n`,
	);
	// A previous hydration may have left provider files this tree no longer
	// expects; check:model-data treats an extra file as an error.
	for (const entry of readdirSync(dataDir)) {
		if (entry === MODEL_DATA_MANIFEST_FILE || !entry.endsWith(".json") || entry in fileContents) continue;
		unlinkSync(join(dataDir, entry));
	}
	validateGeneratedModelData(packageRoot);

	const empty = providerIds.length - seeded.length;
	console.log(
		seedDir
			? `Model data: ${seeded.length} provider(s) seeded from ${seedDir} (${seeded.join(", ") || "none"}), ${empty} shipped empty.`
			: `Model data: no seed directory, all ${empty} providers shipped empty.`,
	);
}

try {
	main();
} catch (error) {
	console.error(error instanceof Error ? error.message : String(error));
	process.exitCode = 1;
}
