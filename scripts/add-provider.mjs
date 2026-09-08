#!/usr/bin/env node
/**
 * add-provider.mjs — interactively register an approved inference endpoint for
 * development, by writing (or extending) ~/.gah/providers.json.
 *
 * The deployed package builds this file from the deploy config; in a dev
 * checkout you point `bin/gah` at your corp inference server the same way, but
 * by hand. This prompts for the fields and writes a valid file so you don't
 * have to remember the schema. Defaults to an OpenAI Responses provider.
 *
 *   node scripts/add-provider.mjs            # -> ~/.gah/providers.json
 *   node scripts/add-provider.mjs --out FILE # a different path (or $GAH_PROVIDERS_FILE)
 *
 * Secrets: a literal API key is read with the echo off and the file is chmod
 * 600. Prefer the "$ENV_VAR" or "/login" options so no key is written to disk.
 * The file lives in your home, never the repo — do not commit your endpoint.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";


/** Build a validated provider entry from collected answers (pure, testable). */
export function buildProvider({ name, baseUrl, api, apiKey, ids, reasoning, image, contextWindow, maxTokens }) {
	const models = ids.map((id) => ({
		id,
		name: id,
		reasoning: !!reasoning,
		input: image ? ["text", "image"] : ["text"],
		// Dev: zeros. Real cost attribution is the provider's own logging, not the model table.
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow,
		maxTokens,
	}));
	return { name, baseUrl, api, ...(apiKey !== undefined ? { apiKey } : {}), models };
}

/** Merge a provider into a config: replace one of the same name, else append. */
export function mergeProvider(config, provider) {
	const providers = Array.isArray(config?.providers) ? [...config.providers] : [];
	const idx = providers.findIndex((p) => p && p.name === provider.name);
	const existed = idx !== -1;
	if (existed) providers[idx] = provider;
	else providers.push(provider);
	return { config: { ...config, providers }, existed };
}

const rl = createInterface({ input: stdin, output: stdout });

async function ask(question, def) {
	const suffix = def ? ` [${def}]` : "";
	const answer = (await rl.question(`${question}${suffix}: `)).trim();
	return answer || def || "";
}

async function askRequired(question, def) {
	for (;;) {
		const a = await ask(question, def);
		if (a) return a;
		stdout.write("  (required)\n");
	}
}

async function askYesNo(question, def = false) {
	const a = (await ask(`${question} (y/n)`, def ? "y" : "n")).toLowerCase();
	return a.startsWith("y");
}

const CTRL_C = "\u0003";
const BACKSPACE = /[\u0008\u007f]/;

/** Read a line with the echo off, for a secret. */
async function askHidden(question) {
	stdout.write(`${question}: `);
	const wasRaw = stdin.isRaw ?? false;
	stdin.setRawMode?.(true);
	stdin.resume();
	let value = "";
	await new Promise((resolve) => {
		const onData = (buf) => {
			const s = buf.toString("utf8");
			for (const ch of s) {
				if (ch === "\n" || ch === "\r") {
					stdin.removeListener("data", onData);
					stdin.setRawMode?.(wasRaw);
					stdout.write("\n");
					resolve();
					return;
				} else if (ch === CTRL_C) {
					stdout.write("\n");
					process.exit(130);
				} else if (BACKSPACE.test(ch)) {
					value = value.slice(0, -1);
				} else {
					value += ch;
				}
			}
		};
		stdin.on("data", onData);
	});
	return value.trim();
}

function hostOf(url) {
	try {
		return new URL(url).host;
	} catch {
		return null;
	}
}

async function main() {
	const outFlag = process.argv.indexOf("--out");
	const OUT =
		outFlag !== -1 && process.argv[outFlag + 1]
			? process.argv[outFlag + 1]
			: process.env.GAH_PROVIDERS_FILE || join(homedir(), ".gah", "providers.json");

	stdout.write("\nRegister an inference endpoint for gah development.\n");
	stdout.write(`Writing to: ${OUT}\n\n`);

	const name = await askRequired("Provider name (a short id you'll pick models under)", "corp");
	const baseUrl = await askRequired("Base URL of the endpoint");
	const host = hostOf(baseUrl);
	if (!host) stdout.write("  ! that doesn't parse as a URL; continuing anyway\n");
	const api = await ask("Wire protocol (openai-responses / openai-completions / anthropic-messages)", "openai-responses");

	stdout.write("\nHow does this endpoint authenticate?\n");
	stdout.write("  1) an API key you enter now (stored in the file, chmod 600)\n");
	stdout.write("  2) an environment variable read per request (nothing written to disk)\n");
	stdout.write("  3) /login inside gah collects it (nothing written to disk)\n");
	const authChoice = await ask("Choose 1/2/3", "2");
	let apiKey;
	let literalKeyPresent = false;
	if (authChoice === "1") {
		apiKey = await askHidden("API key");
		literalKeyPresent = apiKey.length > 0;
	} else if (authChoice === "3") {
		apiKey = undefined; // omitted -> /login
	} else {
		const varName = await askRequired("Environment variable name (without the $)", "CORP_API_KEY");
		apiKey = `$${varName.replace(/^\$/, "")}`;
	}

	stdout.write("\nModels. Enter the model ids this endpoint serves, comma-separated.\n");
	const ids = (await askRequired("Model id(s)", "gpt-4o"))
		.split(",")
		.map((s) => s.trim())
		.filter(Boolean);
	const reasoning = await askYesNo("Are these reasoning models?", api === "openai-responses");
	const image = await askYesNo("Do they accept image input?", false);
	const contextWindow = Number(await ask("Context window (tokens)", "128000")) || 128000;
	const maxTokens = Number(await ask("Max output tokens", "16384")) || 16384;

	const provider = buildProvider({ name, baseUrl, api, apiKey, ids, reasoning, image, contextWindow, maxTokens });

	// Merge into an existing file: replace a provider of the same name, else append.
	let config = { providers: [] };
	if (existsSync(OUT)) {
		try {
			const parsed = JSON.parse(readFileSync(OUT, "utf8"));
			if (Array.isArray(parsed.providers)) config = parsed;
		} catch {
			stdout.write(`  ! ${OUT} exists but did not parse; it will be replaced.\n`);
		}
	}
	if (config.providers.some((p) => p && p.name === name)) {
		const overwrite = await askYesNo(`A provider named "${name}" already exists. Replace it?`, true);
		if (!overwrite) {
			stdout.write("Aborted; nothing written.\n");
			rl.close();
			return;
		}
	}
	config = mergeProvider(config, provider).config;

	mkdirSync(dirname(OUT), { recursive: true });
	writeFileSync(OUT, `${JSON.stringify(config, null, 2)}\n`);
	if (literalKeyPresent) {
		try {
			chmodSync(OUT, 0o600);
		} catch {
			/* Windows / best-effort */
		}
	}

	stdout.write(`\n✓ wrote ${OUT}\n\n`);

	// Next steps in the shell the person is on: PowerShell on Windows, else bash.
	const win = process.platform === "win32";
	const gah = win ? "bin\\gah.ps1" : "./bin/gah";
	const usesDefaultPath = OUT === join(homedir(), ".gah", "providers.json");
	const setEnv = (k, v) => (win ? `$env:${k}="${v}"; ` : `${k}=${v} `);
	const envPrefix = usesDefaultPath ? "" : setEnv("GAH_PROVIDERS_FILE", OUT);

	stdout.write("Next:\n");
	stdout.write(`  ${envPrefix}${gah}                 # start a session; pick with /model or --model ${name}/${ids[0]}\n`);
	stdout.write(`  ${envPrefix}${gah} --list-models   # confirm the endpoint's models are offered\n`);
	if (authChoice === "2") {
		const v = apiKey.slice(1);
		stdout.write(`  ${win ? `$env:${v}="..."` : `export ${v}=...`}            # the key, before launching\n`);
	}
	if (authChoice === "3") stdout.write("  run /login in the session and paste the key\n");
	stdout.write("\nNotes:\n");
	stdout.write(`  - ${gah} allows all hosts in dev (GAH_ALLOWED_HOSTS=*). To restrict egress, set\n`);
	stdout.write(`    ${win ? `$env:GAH_ALLOWED_HOSTS="${host ?? "<endpoint-host>"}"` : `GAH_ALLOWED_HOSTS=${host ?? "<endpoint-host>"}`} (docs/PROVIDERS.md).\n`);
	stdout.write("  - To hide the built-in Anthropic models and see only this endpoint, set\n");
	stdout.write(`    ${win ? `$env:GAH_BUILTIN_MODELS=""` : "GAH_BUILTIN_MODELS="} (empty).\n`);
	stdout.write("  - This file is in your home, not the repo. Do not commit your endpoint.\n");
	rl.close();
}

// Run only as the entry point; importing for tests must not start the prompts.
import { fileURLToPath } from "node:url";
import { argv } from "node:process";
if (argv[1] && fileURLToPath(import.meta.url) === argv[1]) {
	main().catch((e) => {
		stdout.write(`\nadd-provider: ${e?.message ?? e}\n`);
		process.exit(1);
	});
} else {
	rl.close(); // imported: release the readline handle created at module load
}
