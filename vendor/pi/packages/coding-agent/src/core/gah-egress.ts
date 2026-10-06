/**
 * GAH: network egress allowlist.
 *
 * 0010-restrict-model-sources decides which models the registry exposes and
 * the policy pack decides which endpoints it registers -- both registry-level
 * controls. This one sits underneath them: no HTTP request leaves the process
 * unless its hostname matches GAH_ALLOWED_HOSTS, whatever code built the
 * request, including upstream code added after this patch was written.
 *
 * GAH_ALLOWED_HOSTS: comma-separated hostname globs. `*` matches any run of
 * characters, so `*.amazonaws.com` covers every regional Bedrock endpoint and
 * a bare `*` switches the control off (what bin/gah defaults to on a
 * workstation, where the user owns the environment anyway). Unset or empty =
 * deny everything, the same posture as GAH_BUILTIN_MODELS; deploy/host's
 * launcher exports it empty so the manifest has to grant hosts explicitly.
 * Hostnames only, case-insensitive: ports and schemes are not policy.
 *
 * Three hooks, because three HTTP stacks are in use:
 *  - undici, i.e. every fetch() in the process: the Anthropic, OpenAI and
 *    Google SDKs, OAuth token exchange, pi's own calls. Installed as a
 *    dispatcher interceptor by configureHttpDispatcher(), so it is re-applied
 *    whenever upstream rebuilds the dispatcher (settings changes) and it works
 *    under EnvHttpProxyAgent -- the interceptor sees the target origin, not
 *    the proxy.
 *  - node:http / node:https request() and get(): the AWS SDK's NodeHttpHandler,
 *    which Bedrock uses when an HTTP proxy is configured. Under the proxy
 *    agent the request options still name the target host.
 *  - node:http2 connect(): the AWS SDK's default NodeHttp2Handler, which
 *    Bedrock uses when no proxy is configured.
 *  The node hooks patch the module objects once; CommonJS consumers such as
 *  the AWS SDK read them at call time, and syncBuiltinESMExports() updates
 *  ESM importers.
 *
 * A refused request throws GahEgressError, which reaches the user as the
 * provider error, and is appended to the audit log ($GAH_AUDIT_LOG, default
 * ~/.gah/audit.log) once per host per process so SDK retries do not flood it.
 *
 * Read per call rather than cached at load, for the same reason as
 * gah-model-policy.ts: a stale cache here would fail open.
 */

import { appendFileSync, mkdirSync } from "node:fs";
import http from "node:http";
import http2 from "node:http2";
import https from "node:https";
import { syncBuiltinESMExports } from "node:module";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type * as undici from "undici";

export class GahEgressError extends Error {
	readonly host: string;
	readonly via: string;

	constructor(host: string, via: string) {
		super(`GAH egress policy: "${host}" is not in GAH_ALLOWED_HOSTS (${via}). See docs/PROVIDERS.md.`);
		this.name = "GahEgressError";
		this.host = host;
		this.via = via;
	}
}

function globToRegExp(glob: string): RegExp {
	const escaped = glob.replace(/[.*+?^${}()|[\]\\]/g, (c) => (c === "*" ? ".*" : `\\${c}`));
	return new RegExp(`^${escaped}$`);
}

function allowedPatterns(): RegExp[] {
	return (process.env.GAH_ALLOWED_HOSTS ?? "")
		.split(",")
		.map((s) => s.trim().toLowerCase())
		.filter(Boolean)
		.map(globToRegExp);
}

function normalizeHost(host: string): string {
	return host
		.trim()
		.toLowerCase()
		.replace(/^\[(.*)\]$/, "$1") // bracketed IPv6
		.replace(/\.$/, ""); // trailing dot
}

export function gahAllowsHost(host: string): boolean {
	const normalized = normalizeHost(host);
	if (!normalized) return false;
	return allowedPatterns().some((re) => re.test(normalized));
}

const auditedHosts = new Set<string>();

function auditBlocked(host: string, via: string): void {
	if (auditedHosts.has(host)) return;
	auditedHosts.add(host);
	const path = process.env.GAH_AUDIT_LOG ?? join(homedir(), ".gah", "audit.log");
	try {
		mkdirSync(dirname(path), { recursive: true });
		appendFileSync(
			path,
			`${JSON.stringify({
				ts: new Date().toISOString(),
				kind: "egress_blocked",
				host,
				via,
				allowed: process.env.GAH_ALLOWED_HOSTS ?? "",
			})}\n`,
		);
	} catch {
		// Best effort: an unwritable audit log must not turn a refusal into a crash.
	}
}

/** Throws GahEgressError (and audits) unless `host` is allowlisted. */
export function gahCheckHost(host: string, via: string): void {
	if (gahAllowsHost(host)) return;
	auditBlocked(normalizeHost(host), via);
	throw new GahEgressError(normalizeHost(host), via);
}

function hostnameOfOrigin(origin: string | URL | undefined): string {
	if (origin === undefined) return "";
	return typeof origin === "string" ? new URL(origin).hostname : origin.hostname;
}

/** undici dispatcher interceptor: apply with `dispatcher.compose(gahEgressInterceptor)`. */
export const gahEgressInterceptor = (dispatch: undici.Dispatcher["dispatch"]): undici.Dispatcher["dispatch"] => {
	return (opts, handler) => {
		gahCheckHost(hostnameOfOrigin(opts.origin), "undici");
		return dispatch(opts, handler);
	};
};

/** Wrap an already-configured dispatcher so every request it serves is checked. */
export function gahGuardDispatcher(dispatcher: undici.Dispatcher): undici.Dispatcher {
	return dispatcher.compose(gahEgressInterceptor);
}

// node:http/https request(url?, options?, callback?) -- the host can come from
// a URL argument or from options.hostname / options.host (which may carry a port).
function hostFromRequestArgs(args: readonly unknown[]): string {
	let url: URL | undefined;
	let options: Record<string, unknown> | undefined;
	for (const arg of args.slice(0, 2)) {
		if (typeof arg === "string") url = new URL(arg);
		else if (arg instanceof URL) url = arg;
		else if (arg !== null && typeof arg === "object") options = arg as Record<string, unknown>;
	}
	const fromOptions = options?.hostname ?? options?.host;
	if (typeof fromOptions === "string" && fromOptions.length > 0) {
		return fromOptions.replace(/^(\[[^\]]*\]|[^:]*)(:\d+)?$/, "$1");
	}
	return url?.hostname ?? "localhost";
}

let nodeGuardInstalled = false;

/** Patch node:http, node:https and node:http2 so requests that bypass undici are checked too. Idempotent. */
export function gahInstallNodeHttpGuard(): void {
	if (nodeGuardInstalled) return;
	nodeGuardInstalled = true;

	for (const [mod, via] of [
		[http, "node:http"],
		[https, "node:https"],
	] as const) {
		for (const name of ["request", "get"] as const) {
			const original = mod[name] as (...args: unknown[]) => http.ClientRequest;
			(mod as unknown as Record<string, unknown>)[name] = function (this: unknown, ...args: unknown[]) {
				gahCheckHost(hostFromRequestArgs(args), via);
				return original.apply(this, args);
			};
		}
	}

	const originalConnect = http2.connect as (...args: unknown[]) => http2.ClientHttp2Session;
	(http2 as unknown as Record<string, unknown>).connect = function (this: unknown, ...args: unknown[]) {
		const authority = args[0];
		const host =
			typeof authority === "string"
				? new URL(authority).hostname
				: authority instanceof URL
					? authority.hostname
					: "";
		gahCheckHost(host, "node:http2");
		return originalConnect.apply(this, args);
	};

	syncBuiltinESMExports();
}
