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
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

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
	}
	return parsed;
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
		pi.registerProvider(entry.name, {
			baseUrl: entry.baseUrl,
			api: entry.api as never,
			...(entry.apiKey !== undefined ? { apiKey: entry.apiKey } : {}),
			models: entry.models as never,
		});
		audit({
			kind: "provider_registered",
			provider: entry.name,
			baseUrl: entry.baseUrl,
			auth: entry.apiKey === undefined ? "login" : entry.apiKey.startsWith("$") ? "env" : "literal",
			models: entry.models.map((m) => m.id),
		});
	}
}
