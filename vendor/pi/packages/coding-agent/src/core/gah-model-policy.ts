/**
 * GAH: built-in model catalogue policy.
 *
 * Two controls, both deliberately enforced here rather than in configuration:
 *
 * 1. `GAH_BUILTIN_MODELS` — a comma-separated list of `provider/model-id` globs.
 *    Unset or empty means NO built-in models are exposed. Approved endpoints are
 *    registered by the GAH policy pack, or allowlisted here at deployment time.
 *
 * 2. `GAH_ALLOW_MODELS_JSON` — must be exactly "1" for `models.json` to be read
 *    at all. That file can define arbitrary provider ids with their own baseUrl,
 *    apiKey and headers, so honouring it unconditionally is a straight bypass of
 *    the approved-provider posture. Opt-in for local testing only.
 *
 * Why not configuration: upstream's `--models` / `enabledModels` /
 * `/scoped-models` look like an allowlist but are not one. They scope a single
 * session's Ctrl+P cycling set while the full catalogue stays reachable through
 * the `/model` picker, RPC, and any extension holding `ctx.modelRegistry`. The
 * setting lives in user-writable settings.json with no managed tier, and
 * agent-session.ts appends a model to it automatically when the user selects one
 * outside the scope. It is a convenience, not a boundary.
 *
 * Why not an extension: extensions can wrap providers via registerProvider, but
 * that only covers TUI/RPC sessions. `gah auth …`, the SDK and the package
 * manager each construct their own ModelRuntime before any extension loads.
 * ModelRuntime.create() is the one constructor they all share.
 *
 * NOTE: the enforcement boundary that actually matters in a governed deployment
 * is the per-agent IAM policy (see deploy/host/README.md) — this is
 * defence in depth and a UI-surface control, not the last line.
 */

import type { Api, Model, Provider } from "@earendil-works/pi-ai";

function globToRegExp(glob: string): RegExp {
	const escaped = glob.replace(/[.*+?^${}()|[\]\\]/g, (c) => (c === "*" ? ".*" : `\\${c}`));
	return new RegExp(`^${escaped}$`);
}

/**
 * Read on each call rather than cached at module load: the env is set by
 * gah-launch from a root-owned manifest before exec, but tests and the SDK may
 * change it between runtimes, and a stale cache here would fail open.
 */
function allowPatterns(): RegExp[] {
	return (process.env.GAH_BUILTIN_MODELS ?? "")
		.split(",")
		.map((s) => s.trim())
		.filter(Boolean)
		.map(globToRegExp);
}

export function gahAllowsBuiltInModel(provider: string, modelId: string): boolean {
	const patterns = allowPatterns();
	if (patterns.length === 0) return false; // unset/empty = deny all
	const reference = `${provider}/${modelId}`;
	return patterns.some((re) => re.test(reference));
}

/** True when models.json may be read at all. */
export function gahAllowsModelsJson(): boolean {
	return process.env.GAH_ALLOW_MODELS_JSON === "1";
}

/**
 * Wrap a provider so its catalogue is filtered by the allowlist.
 *
 * getModels is wrapped rather than a snapshot filtered, because the catalogue is
 * dynamic: withRemoteCatalog() merges models fetched from the remote catalog on
 * every call. Apply this OUTERMOST — after withRemoteCatalog — or remotely
 * added models bypass the allowlist. (That overlay did not exist in v0.79.1,
 * where this control previously lived in model-registry.ts.)
 */
export function gahRestrictProvider(provider: Provider): Provider {
	return {
		...provider,
		getModels: (): readonly Model<Api>[] =>
			provider.getModels().filter((m) => gahAllowsBuiltInModel(provider.id, m.id)),
	};
}

/**
 * A provider with nothing in its (filtered) catalogue has nothing to log into.
 *
 * Read at call time, not snapshotted: the catalogue is dynamic (see above).
 * getModels() is synchronous everywhere -- withRemoteCatalog merges an
 * in-memory overlay that refreshModels() fills in separately -- so this costs
 * no network round-trip at menu-render time.
 */
export function gahProviderHasModels(provider: Provider): boolean {
	return provider.getModels().length > 0;
}

/**
 * The provider list every picker sees: /login, `gah auth`, the ModelRegistry
 * facade extensions read. Denied providers are hidden rather than shown
 * disabled, so the approved set is what a user is choosing from -- a policy
 * that is invisible where providers are picked reads as no policy at all.
 * Extension-registered providers carry their own models and stay visible.
 */
export function gahVisibleProviders(providers: readonly Provider[]): Provider[] {
	return providers.filter(gahProviderHasModels);
}
