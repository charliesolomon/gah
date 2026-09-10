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
import { formatReport, probeEndpoint, promptPlacementFor, toolModeFor } from "./probe-endpoint.mjs";

/**
 * Build a validated provider entry from collected answers (pure, testable).
 * `modelInfo[id]` may carry a per-model contextWindow / maxTokens (from the
 * endpoint probe); `tools` is written only when it is "prompted".
 */
export function buildProvider({
	name,
	baseUrl,
	api,
	apiKey,
	ids,
	reasoning,
	image,
	contextWindow,
	maxTokens,
	tools,
	toolsPrompt,
	modelInfo = {},
}) {
	const models = ids.map((id) => ({
		id,
		name: id,
		reasoning: !!reasoning,
		input: image ? ["text", "image"] : ["text"],
		// Dev: zeros. Real cost attribution is the provider's own logging, not the model table.
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: modelInfo[id]?.contextWindow ?? contextWindow,
		maxTokens: modelInfo[id]?.maxTokens ?? maxTokens,
	}));
	return {
		name,
		baseUrl,
		api,
		...(apiKey !== undefined ? { apiKey } : {}),
		...(tools === "prompted" ? { tools } : {}),
		...(tools === "prompted" && toolsPrompt === "user" ? { toolsPrompt } : {}),
		models,
	};
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

// Lines are queued as they arrive rather than read with rl.question(): with a
// piped stdin (a scripted run, a test) readline emits every line at once and
// drops the ones no question is waiting for. Interactive use is unchanged.
const pendingLines = [];
let lineWaiter = null;
let inputClosed = false;
let rl = null;

/**
 * (Re)attach readline to stdin. askHidden() detaches it first: a readline in
 * terminal mode echoes every keystroke and turns the Enter after a secret
 * into a queued line, which then answered the next question by itself.
 */
function openReadline() {
	const iface = createInterface({ input: stdin, output: stdout, terminal: !!stdin.isTTY });
	iface.on("line", (line) => {
		if (lineWaiter) {
			const resolve = lineWaiter;
			lineWaiter = null;
			resolve(line);
		} else {
			pendingLines.push(line);
		}
	});
	iface.on("close", () => {
		if (rl !== iface) return; // closed on purpose by askHidden, not end of input
		inputClosed = true;
		if (lineWaiter) {
			const resolve = lineWaiter;
			lineWaiter = null;
			resolve(null);
		}
	});
	rl = iface;
	inputClosed = false;
}
openReadline();

async function readLine() {
	if (pendingLines.length > 0) return pendingLines.shift();
	if (inputClosed) return null;
	return new Promise((resolve) => {
		lineWaiter = resolve;
	});
}

async function ask(question, def) {
	const suffix = def ? ` [${def}]` : "";
	stdout.write(`${question}${suffix}: `);
	const line = await readLine();
	if (line === null) throw new Error("input ended before the questions did");
	if (!stdin.isTTY) stdout.write(`${line}\n`); // echo piped answers so a transcript reads like a session
	const answer = line.trim();
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
	// Readline must not see these keystrokes: detach it for the duration.
	const previous = rl;
	rl = null;
	previous.close();
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
					openReadline();
					pendingLines.length = 0; // nothing typed during the secret counts as an answer
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

	// Ask the endpoint first (#75): the models it lists, which protocol answers,
	// streaming, and whether tool calls are accepted, ignored or refused. The
	// answers below default to what it said. A key typed as option 1 or set in
	// the option-2 variable is used for the probe; nothing is written.
	let report;
	const probeKey = authChoice === "1" ? apiKey : authChoice === "2" ? process.env[apiKey.slice(1)] : undefined;
	if (authChoice === "2" && !probeKey)
		stdout.write(`  ($${apiKey.slice(1)} is not set in this shell, so a probe would run without a key)\n`);
	if (await askYesNo("\nProbe the endpoint now to prefill the answers below?", true)) {
		stdout.write("  probing…\n");
		report = await probeEndpoint({ baseUrl, apiKey: probeKey });
		stdout.write(`${formatReport(report).replace(/^/gm, "  ")}\n\n`);
	}
	const probedTools = report ? toolModeFor(report) : undefined;

	const api = await ask(
		"Wire protocol (openai-responses / openai-completions / anthropic-messages)",
		report?.api ?? "openai-responses",
	);

	stdout.write("\nModels. Enter the model ids this endpoint serves, comma-separated.\n");
	const listed = report?.models.map((m) => m.id) ?? [];
	if (listed.length > 12)
		stdout.write(`  (the endpoint listed ${listed.length}; the default keeps all of them, trim as you like)\n`);
	const ids = (await askRequired("Model id(s)", listed.length > 0 ? listed.join(",") : "gpt-4o"))
		.split(",")
		.map((s) => s.trim())
		.filter(Boolean);
	const reasoning = await askYesNo("Are these reasoning models?", api === "openai-responses");
	const image = await askYesNo("Do they accept image input?", false);
	// Per-model limits from the probe win; the two answers cover the rest.
	const modelInfo = Object.fromEntries((report?.models ?? []).filter((m) => ids.includes(m.id)).map((m) => [m.id, m]));
	const known = Object.values(modelInfo);
	const withoutContext = ids.filter((id) => !modelInfo[id]?.contextWindow);
	const withoutMax = ids.filter((id) => !modelInfo[id]?.maxTokens);
	if (report?.outputCap?.enforced === false)
		stdout.write("  (the endpoint ignores the output cap you send, so maxTokens is documentation here)\n");
	if (known.length > 0 && withoutContext.length < ids.length)
		stdout.write(
			`  (context window known for ${ids.length - withoutContext.length} of ${ids.length} models from the probe)\n`,
		);
	const contextWindow =
		withoutContext.length > 0
			? Number(
					await ask(
						`Context window (tokens)${withoutContext.length < ids.length ? ` for ${withoutContext.join(", ")}` : ""}`,
						"128000",
					),
				) || 128000
			: 128000;
	const maxTokens =
		withoutMax.length > 0
			? Number(
					await ask(
						`Max output tokens${withoutMax.length < ids.length ? ` for ${withoutMax.join(", ")}` : ""}`,
						"16384",
					),
				) || 16384
			: 16384;
	let tools;
	let toolsPrompt;
	if (probedTools === "prompted") {
		const why = report.tools === "refused" ? "refuses tool calls" : "ignores tool definitions";
		tools = (await askYesNo(`The endpoint ${why}. Use the prompted tool protocol ("tools": "prompted")?`, true))
			? "prompted"
			: "native";
		if (tools === "prompted") {
			toolsPrompt = promptPlacementFor(report);
			if (toolsPrompt === "user") {
				stdout.write('  (protocol followed only from the user turn: writing "toolsPrompt": "user")\n');
			}
			if (report.protocol === "not-followed")
				stdout.write(
					"  ! the model did not follow the protocol in the probe; expect fabricated answers until a model that does is chosen\n",
				);
		}
	}

	const provider = buildProvider({
		name,
		baseUrl,
		api,
		apiKey,
		ids,
		reasoning,
		image,
		contextWindow,
		maxTokens,
		tools,
		toolsPrompt,
		modelInfo,
	});

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
	if (tools === "prompted")
		stdout.write("  - Tool calls go through the prompted protocol on this provider (docs/PROVIDERS.md, #42).\n");
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
