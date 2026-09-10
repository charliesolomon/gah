/**
 * GAH approved-providers extension.
 *
 * Vendor patch 0010-restrict-model-sources hides every built-in model unless
 * allowlisted via GAH_BUILTIN_MODELS, and ignores ~/.gah/agent/models.json.
 * This extension is the only sanctioned way to add inference endpoints back:
 * it reads a deployment-controlled JSON file and registers each entry with
 * the model registry.
 *
 * Config file: $GAH_PROVIDERS_FILE, default ~/.gah/providers.json
 *   - File absent → nothing happens. gah exposes only what GAH_BUILTIN_MODELS
 *     allows (in this repo, bin/gah defaults that to anthropic/* for dev).
 *   - File present → it is authoritative: every listed provider is registered,
 *     and built-in OAuth login flows NOT listed in `keepOAuth` are removed
 *     from /login.
 *
 * Providers that authenticate via cloud credential chains (e.g. the built-in
 * amazon-bedrock provider with its AWS credential resolution) cannot be
 * re-created through registerProvider — allowlist those via GAH_BUILTIN_MODELS
 * instead and restrict to specific model ids there.
 *
 * The OAuth-removal loop below re-registers built-ins as native provider
 * objects taken from pi-ai, i.e. upstream's raw catalogue. That is safe only
 * because the runtime re-applies the allowlist to anything registered under a
 * built-in id (patch 0010, re-authored 2026-09-02); before that patch this loop
 * reopened every OAuth-capable built-in whenever a providers file was present.
 *
 * See providers.example.json (next to this package's SYSTEM.md) for a worked
 * example and docs/PROVIDERS.md for the full reference.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { type AssistantMessageEventStream, getApiProvider } from "@earendil-works/pi-ai";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	PROMPT_PLACEMENTS,
	type PromptedDebugEntry,
	promptedStream,
	type PromptPlacement,
	TOOL_MODES,
	type ToolMode,
} from "./lib/prompted-tools.ts";

const CONFIG_PATH = process.env.GAH_PROVIDERS_FILE ?? join(homedir(), ".gah", "providers.json");
const AUDIT_LOG_PATH = process.env.GAH_AUDIT_LOG ?? join(homedir(), ".gah", "audit.log");

interface ModelEntry {
	id: string;
	name: string;
	api?: string;
	reasoning: boolean;
	input: ("text" | "image")[];
	cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
	contextWindow: number;
	maxTokens: number;
	/** Per-model override of the provider's `tools` mode. */
	tools?: ToolMode;
	/** Per-model override of the provider's `toolsPrompt` placement. */
	toolsPrompt?: PromptPlacement;
}

interface ProviderEntry {
	name: string;
	baseUrl: string;
	/** Wire protocol, e.g. "openai-completions", "openai-responses", "anthropic-messages". */
	api: string;
	/**
	 * Literal key, "$ENV_VAR" to resolve from the environment per request, or
	 * omitted: the provider is registered without a key and /login collects one
	 * into auth.json. The endpoint stays in this file either way.
	 */
	apiKey?: string;
	/**
	 * How tool calls reach the model. "native" (default) sends the API's tool
	 * definitions. "prompted" is for a gateway that refuses them: tools are
	 * described in the system prompt and the model's fenced ```tool blocks are
	 * parsed back into tool calls (lib/prompted-tools.ts, #42). Per-model
	 * override via ModelEntry.tools.
	 */
	tools?: ToolMode;
	/**
	 * Where the prompted protocol goes: "system" (default) appends it to the
	 * system prompt; "user" prepends it to the current user turn, for a
	 * gateway that drops system prompts (probe-endpoint.mjs reports which
	 * placement the model followed). Only meaningful with tools "prompted".
	 */
	toolsPrompt?: PromptPlacement;
	models: ModelEntry[];
}

interface ProvidersConfig {
	providers: ProviderEntry[];
	/** Built-in OAuth login flows to keep (by provider id). Default: none. */
	keepOAuth?: string[];
}

function audit(entry: Record<string, unknown>): void {
	try {
		mkdirSync(dirname(AUDIT_LOG_PATH), { recursive: true });
		appendFileSync(AUDIT_LOG_PATH, JSON.stringify({ ts: new Date().toISOString(), ...entry }) + "\n");
	} catch {
		process.stderr.write(`[gah-providers] audit write failed: ${AUDIT_LOG_PATH}\n`);
	}
}

function loadConfig(): ProvidersConfig | undefined {
	if (!existsSync(CONFIG_PATH)) {
		return undefined;
	}
	const parsed = JSON.parse(readFileSync(CONFIG_PATH, "utf-8")) as ProvidersConfig;
	if (!Array.isArray(parsed.providers)) {
		throw new Error(`${CONFIG_PATH}: "providers" must be an array`);
	}
	for (const p of parsed.providers) {
		if (!p.name || !p.baseUrl || !p.api || !Array.isArray(p.models) || p.models.length === 0) {
			throw new Error(`${CONFIG_PATH}: provider entries need name, baseUrl, api and a non-empty models array`);
		}
		if (p.apiKey !== undefined && typeof p.apiKey !== "string") {
			throw new Error(`${CONFIG_PATH}: provider ${p.name}: apiKey must be a string when present`);
		}
		for (const mode of [p.tools, ...p.models.map((m) => m.tools)]) {
			if (mode !== undefined && !TOOL_MODES.includes(mode)) {
				throw new Error(`${CONFIG_PATH}: provider ${p.name}: tools must be one of ${TOOL_MODES.join(", ")}`);
			}
		}
		for (const placement of [p.toolsPrompt, ...p.models.map((m) => m.toolsPrompt)]) {
			if (placement !== undefined && !PROMPT_PLACEMENTS.includes(placement)) {
				throw new Error(
					`${CONFIG_PATH}: provider ${p.name}: toolsPrompt must be one of ${PROMPT_PLACEMENTS.join(", ")}`,
				);
			}
		}
		// The composer routes a custom streamSimple only for models on the
		// provider's own api; a prompted model on another api would silently
		// go native, so refuse the config instead.
		for (const m of p.models) {
			if (promptedModelIds(p).has(m.id) && m.api !== undefined && m.api !== p.api) {
				throw new Error(
					`${CONFIG_PATH}: provider ${p.name}: model ${m.id} uses tools "prompted" but its api differs from the provider's`,
				);
			}
		}
	}
	return parsed;
}

/** Ids of the models in an entry that use the prompted tool protocol. */
export function promptedModelIds(entry: ProviderEntry): Set<string> {
	const ids = new Set<string>();
	for (const m of entry.models) {
		if ((m.tools ?? entry.tools ?? "native") === "prompted") ids.add(m.id);
	}
	return ids;
}

/** Where a model's protocol text goes; model overrides provider, default system. */
export function promptPlacementFor(entry: ProviderEntry, modelId: string): PromptPlacement {
	const m = entry.models.find((x) => x.id === modelId);
	return m?.toolsPrompt ?? entry.toolsPrompt ?? "system";
}

/**
 * GAH_PROMPTED_DEBUG=<file>: one JSON line per prompted request with the
 * outbound shape and the model's raw text, for diagnosing a gateway that
 * still fabricates (#42). Off unless set; the file is the operator's choice.
 */
const PROMPTED_DEBUG_PATH = process.env.GAH_PROMPTED_DEBUG;
function promptedDebug(entry: PromptedDebugEntry): void {
	if (!PROMPTED_DEBUG_PATH) return;
	try {
		mkdirSync(dirname(PROMPTED_DEBUG_PATH), { recursive: true });
		appendFileSync(PROMPTED_DEBUG_PATH, `${JSON.stringify(entry)}\n`);
	} catch {
		process.stderr.write(`[gah-providers] prompted debug write failed: ${PROMPTED_DEBUG_PATH}\n`);
	}
}

export default function (pi: ExtensionAPI) {
	let config: ProvidersConfig | undefined;
	try {
		config = loadConfig();
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		audit({ kind: "providers_config_error", error: message });
		process.stderr.write(`[gah-providers] ${message}\n`);
		return; // Fail closed: bad config registers nothing.
	}

	if (!config) {
		audit({ kind: "providers_config_absent", path: CONFIG_PATH });
		return;
	}

	// The config file is authoritative: built-in /login flows not explicitly
	// kept are removed before our providers (and any OAuth they bring) register.
	//
	// v0.84.4 removed the global OAuth registry this used to call
	// (getOAuthProviders / unregisterOAuthProvider); @earendil-works/pi-ai/oauth
	// is now a type-only entry point, so those imports failed at load. OAuth is
	// per-provider on Provider.auth.oauth, and the only way to strip it is to
	// re-register the provider as a native object with that member dropped:
	// pi.unregisterProvider() is documented as a *restore* of the built-in, and
	// the config form of registerProvider can only add or replace OAuth, never
	// remove it (see composeOAuthAuth in provider-composer.ts).
	const keep = new Set(config.keepOAuth ?? []);
	for (const provider of builtinProviders()) {
		if (keep.has(provider.id) || !provider.auth?.oauth) continue;
		const { oauth: _dropped, ...authWithoutOAuth } = provider.auth;
		pi.registerProvider({ ...provider, auth: authWithoutOAuth });
		audit({ kind: "oauth_removed", provider: provider.id });
	}

	for (const entry of config.providers) {
		const prompted = promptedModelIds(entry);
		pi.registerProvider(entry.name, {
			baseUrl: entry.baseUrl,
			api: entry.api as never,
			...(entry.apiKey !== undefined ? { apiKey: entry.apiKey } : {}),
			models: entry.models as never,
			// Upstream routes every request for this provider's api through this
			// when present (provider-composer.ts, streamWith). Auth is already
			// applied to `options` by then, so delegating to the api's own
			// streamer changes nothing for native models.
			...(prompted.size > 0
				? {
						streamSimple: (model, context, options) => {
							const base = getApiProvider(model.api);
							if (!base) throw new Error(`No API provider registered for api: ${model.api}`);
							if (!prompted.has(model.id)) return base.streamSimple(model, context, options);
							// Same async-iteration + result() contract; the class itself is
							// type-only through the extension alias of pi-ai's root entry.
							return promptedStream(base, model, context, options, {
								placement: promptPlacementFor(entry, model.id),
								debug: PROMPTED_DEBUG_PATH ? promptedDebug : undefined,
							}) as unknown as AssistantMessageEventStream;
						},
					}
				: {}),
		});
		audit({
			kind: "provider_registered",
			provider: entry.name,
			baseUrl: entry.baseUrl,
			auth: entry.apiKey === undefined ? "login" : entry.apiKey.startsWith("$") ? "env" : "literal",
			models: entry.models.map((m) => m.id),
			...(prompted.size > 0
				? {
						promptedTools: [...prompted],
						toolsPrompt: Object.fromEntries([...prompted].map((id) => [id, promptPlacementFor(entry, id)])),
						...(PROMPTED_DEBUG_PATH ? { promptedDebug: PROMPTED_DEBUG_PATH } : {}),
					}
				: {}),
		});
	}
}
