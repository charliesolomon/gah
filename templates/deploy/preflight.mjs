#!/usr/bin/env node
/**
 * preflight.mjs — what a session cannot work without, checked before it starts
 * (#135). Shipped in every deployment package; run by gah.ps1 and gah.sh.
 *
 *   node preflight.mjs --deploy <deploy.json> --providers <providers.json> --state <file> --out <file>
 *                      [--system-proxy <url>]
 *
 * 1. Route. Find a way to reach the inference host, in this order: what worked
 *    last time (--state), a direct connection, the proxy in the environment
 *    (HTTPS_PROXY), the system proxy the launcher found (--system-proxy), the
 *    deployment's suggestion (deploy.json inferenceProxy), and finally the
 *    person, asked in the terminal. Any HTTP answer means reachable. A proxy
 *    that answers 407 needs a login, which gah does not support: say so, stop.
 * 2. Key. At least one provider must have a key the endpoint accepts. Checked
 *    with the provider's model list, never a chat request (some gateways bill
 *    per message); an endpoint without a model list cannot be checked, and its
 *    key is accepted as it is. With no usable provider, the person is asked for
 *    a key -- masked -- until one works or they give up. A person who cannot
 *    reach any model never has to discover /login on their own.
 *
 * Keys are stored where the session reads them: "$VAR" providers as a user
 * environment variable (Windows) or in ~/.config/gah/secrets.env (Linux, 0600);
 * /login providers in the agent's auth.json. The launcher re-reads them.
 *
 * --out receives {"proxy": <url or null>, "direct": [hosts]}: with a proxy the
 * launcher exports it as HTTPS_PROXY; with a direct route it adds the
 * inference hosts to NO_PROXY, so the session goes the way that was tested
 * even when the environment names a proxy (for other traffic). No secret is
 * ever written there.
 *
 * Exit: 0 ready; 2 no route to any inference host; 3 no usable key; 4 proxy
 * needs a login.
 */

import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const args = process.argv.slice(2);
const opt = {};
for (let i = 0; i < args.length; i++) {
	const k = args[i].replace(/^--/, "");
	opt[k] = args[++i];
}
const deploy = JSON.parse(readFileSync(opt.deploy, "utf8"));
const providers = JSON.parse(readFileSync(opt.providers, "utf8")).providers ?? [];
const interactive = Boolean(process.stdin.isTTY && process.stderr.isTTY);
const say = (m = "") => process.stderr.write(`${m}\n`);

// --- One request, through one route, in a child process -------------------------
// Through a proxy, the child asks for a CONNECT tunnel itself and speaks TLS
// over it, so any Node 22 works (Node's own proxy support needs 22.21+) and a
// refused tunnel reports its status (407: wants a login). gah itself reaches
// the proxy through undici's EnvHttpProxyAgent, independent of Node's version.
const PROBE = `
const http = require("node:http"), https = require("node:https"), tls = require("node:tls");
const url = new URL(process.argv[1]), headers = JSON.parse(process.argv[2]), proxy = process.argv[3];
const done = (o) => { console.log(JSON.stringify(o)); process.exit(0); };
const fail = (e) => done({ error: String(e.code ?? e.name ?? "error"), message: String(e.message).slice(0, 200) });
setTimeout(() => done({ error: "ETIMEDOUT", message: "no answer in time" }), Number(process.argv[4])).unref();
const secure = url.protocol === "https:";
const send = (opts) => {
	const r = (secure ? https : http).request(url, { headers, ...opts }, (res) => { res.resume(); done({ status: res.statusCode }); });
	r.on("error", fail);
	r.end();
};
if (!proxy) send({});
else {
	const p = new URL(proxy), target = url.hostname + ":" + (url.port || (secure ? 443 : 80));
	const c = http.request({ host: p.hostname, port: p.port || 80, method: "CONNECT", path: target, headers: { host: target } });
	c.on("connect", (res, socket) => {
		if (res.statusCode === 407) { socket.destroy(); return done({ status: 407 }); }
		if (res.statusCode !== 200) { socket.destroy(); return done({ error: "EPROXY", message: "the proxy answered " + res.statusCode + " to CONNECT " + target }); }
		send({ createConnection: () => (secure ? tls.connect({ socket, servername: url.hostname }) : socket) });
	});
	c.on("error", fail);
	c.end();
}`;
function probe(url, headers, proxy, timeoutMs) {
	const env = { ...process.env };
	for (const k of ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy", "NODE_USE_ENV_PROXY"]) delete env[k];
	const r = spawnSync(process.execPath, ["-e", PROBE, url, JSON.stringify(headers), proxy ?? "", String(timeoutMs)], { env, encoding: "utf8", timeout: timeoutMs + 5000 });
	try {
		return JSON.parse(r.stdout.trim().split("\n").pop());
	} catch {
		return { error: "spawn", message: (r.stderr || "no output").slice(0, 200) };
	}
}

// --- Provider endpoints and keys ------------------------------------------------
function modelsRequest(p, key) {
	const base = String(p.baseUrl).replace(/\/+$/, "");
	if (p.api === "anthropic-messages") {
		const url = /\/v1$/.test(base) ? `${base}/models` : `${base}/v1/models`;
		return { url, headers: key ? { "x-api-key": key, "anthropic-version": "2023-06-01" } : {} };
	}
	if (/^openai-/.test(p.api ?? "")) return { url: `${base}/models`, headers: key ? { authorization: `Bearer ${key}` } : {} };
	// Unknown API shape: reachability only; the key cannot be checked.
	return { url: base, headers: {}, unverifiable: true };
}

const agentDir = process.env.GAH_CODING_AGENT_DIR || join(homedir(), ".gah", "agent");
const authFile = join(agentDir, "auth.json");
function readAuth() {
	try {
		return JSON.parse(readFileSync(authFile, "utf8"));
	} catch {
		return {};
	}
}
function keyOf(p) {
	if (typeof p.apiKey === "string" && !p.apiKey.startsWith("$")) return { key: p.apiKey, source: "config" };
	if (typeof p.apiKey === "string") return { key: process.env[p.apiKey.slice(1)], source: "env", variable: p.apiKey.slice(1) };
	const cred = readAuth()[p.name];
	// A /login sign-in other than an API key (OAuth) is a credential this
	// script cannot test; it counts as present and unverifiable.
	if (cred && cred.type !== "api_key") return { key: undefined, source: "login", signedIn: true };
	return { key: cred?.type === "api_key" ? cred.key : undefined, source: "login" };
}

function storeKey(p, key) {
	const k = keyOf(p);
	if (k.source === "env") {
		process.env[k.variable] = key;
		if (process.platform === "win32") {
			const r = spawnSync(
				"powershell.exe",
				["-NoLogo", "-NoProfile", "-Command", "[Environment]::SetEnvironmentVariable($env:GAH_STORE_NAME, [Console]::In.ReadToEnd().Trim(), 'User')"],
				{ input: key, env: { ...process.env, GAH_STORE_NAME: k.variable }, encoding: "utf8" },
			);
			if (r.status !== 0) throw new Error(`could not store ${k.variable}: ${r.stderr}`);
		} else {
			const dir = join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "gah");
			const file = join(dir, "secrets.env");
			mkdirSync(dir, { recursive: true, mode: 0o700 });
			const kept = existsSync(file) ? readFileSync(file, "utf8").split("\n").filter((l) => l && !l.startsWith(`${k.variable}=`)) : [];
			writeFileSync(`${file}.tmp`, `${[...kept, `${k.variable}=${key}`].join("\n")}\n`, { mode: 0o600 });
			renameSync(`${file}.tmp`, file);
			chmodSync(file, 0o600);
		}
		return k.variable;
	}
	// A /login provider: the same record /login writes.
	mkdirSync(agentDir, { recursive: true, mode: 0o700 });
	const auth = readAuth();
	auth[p.name] = { type: "api_key", key };
	writeFileSync(`${authFile}.tmp`, `${JSON.stringify(auth, null, 2)}\n`, { mode: 0o600 });
	renameSync(`${authFile}.tmp`, authFile);
	if (process.platform !== "win32") chmodSync(authFile, 0o600);
	return "auth.json";
}

// --- Terminal input ---------------------------------------------------------------
function readLine(prompt, { masked = false } = {}) {
	return new Promise((resolveP) => {
		process.stderr.write(prompt);
		const stdin = process.stdin;
		let value = "";
		const done = (v) => {
			if (stdin.isTTY) stdin.setRawMode(false);
			stdin.pause();
			stdin.removeListener("data", onData);
			process.stderr.write("\n");
			resolveP(v);
		};
		const onData = (buf) => {
			for (const ch of buf.toString("utf8")) {
				if (ch === "\r" || ch === "\n") return done(value.trim());
				if (ch === "\u0003") {
					process.stderr.write("\n");
					process.exit(130);
				}
				if (ch === "\u007f" || ch === "\b") {
					if (value.length) {
						value = value.slice(0, -1);
						process.stderr.write("\b \b");
					}
					continue;
				}
				if (ch === "\u001b") continue;
				value += ch;
				process.stderr.write(masked ? "•" : ch);
			}
		};
		if (stdin.isTTY) stdin.setRawMode(true);
		stdin.resume();
		stdin.on("data", onData);
	});
}

// --- 1. Route ---------------------------------------------------------------------------
function readState() {
	try {
		return JSON.parse(readFileSync(opt.state, "utf8"));
	} catch {
		return {};
	}
}
function saveState(s) {
	try {
		mkdirSync(dirname(opt.state), { recursive: true });
		writeFileSync(opt.state, `${JSON.stringify(s)}\n`);
	} catch {
		/* a missing fast path costs a few seconds next time, nothing more */
	}
}

/** Tries `proxy` (null = direct) against every provider; returns the answers, or why it failed. */
function tryRoute(proxy, timeoutMs) {
	const answers = [];
	for (const p of providers) {
		const k = keyOf(p);
		const req = modelsRequest(p, k.key);
		const r = probe(req.url, req.headers, proxy, timeoutMs);
		if (r.status === 407) return { proxyAuth: true };
		// 502 and 504: a gateway or proxy on the way answered for a target it
		// could not reach. That is not a route to the model.
		if (r.status === 502 || r.status === 504) {
			answers.push({ provider: p, error: `HTTP ${r.status}: ${proxy ? "the proxy" : "a gateway"} could not reach ${req.url}` });
			continue;
		}
		if (typeof r.status === "number") answers.push({ provider: p, status: r.status, unverifiable: req.unverifiable || k.signedIn, keySource: k.source, hasKey: Boolean(k.key) || Boolean(k.signedIn) });
		else answers.push({ provider: p, error: `${r.error}: ${r.message}` });
	}
	return { answers, reachable: answers.some((a) => typeof a.status === "number") };
}

const state = readState();
// curl and dnf read a proxy without a scheme as http://; so does gah (0012).
const withScheme = (u) => (u && !u.includes("://") ? `http://${u}` : u);
const envProxy = withScheme((process.env.HTTPS_PROXY || process.env.https_proxy || "").trim());
const candidates = [];
const add = (proxy, label) => {
	const key = proxy || "none";
	if (!candidates.some((c) => (c.proxy || "none") === key)) candidates.push({ proxy: proxy || null, label });
};
if (state.proxy !== undefined) add(state.proxy === "none" ? null : state.proxy, "what worked last time");
add(null, "a direct connection");
if (envProxy) add(envProxy, `the proxy in HTTPS_PROXY (${envProxy})`);
if (opt["system-proxy"]) add(withScheme(opt["system-proxy"]), `the system proxy (${opt["system-proxy"]})`);
if (deploy.inferenceProxy) add(deploy.inferenceProxy, `the proxy your deployment suggests (${deploy.inferenceProxy})`);

let route;
let result;
for (const c of candidates) {
	result = tryRoute(c.proxy, c.proxy ? 8000 : 5000);
	if (result.proxyAuth) {
		say(`gah: the proxy ${c.proxy} asks for a login. gah does not support proxies that need one.`);
		say("     Ask your IT for a proxy that does not, or a network where the inference service is reachable directly.");
		process.exit(4);
	}
	if (result.reachable) {
		route = c;
		break;
	}
}
while (!route && interactive) {
	const hosts = [...new Set(providers.map((p) => { try { return new URL(p.baseUrl).host; } catch { return p.baseUrl; } }))].join(", ");
	say("");
	say(`gah cannot reach the inference service (${hosts}).`);
	for (const c of candidates) say(`  tried ${c.label}`);
	say("If your network needs a proxy, enter it here, for example http://proxy.example.com:8080");
	say("(your browser's or IT's proxy settings name it). Press Enter to give up.");
	const typed = await readLine("  Proxy: ");
	if (!typed) break;
	const proxy = withScheme(typed);
	const r = tryRoute(proxy, 8000);
	if (r.proxyAuth) {
		say(`gah: ${proxy} asks for a login. gah does not support proxies that need one.`);
		continue;
	}
	if (r.reachable) {
		route = { proxy, label: proxy };
		result = r;
	} else say(`  ${proxy} did not get through either (${r.answers.map((a) => a.error).filter(Boolean)[0] ?? "no answer"}).`);
}
if (!route) {
	say("gah: no route to the inference service, so a session would have no model to talk to.");
	if (!interactive) say("     Start gah in a terminal to be asked for a proxy, or set HTTPS_PROXY.");
	process.exit(2);
}
saveState({ ...state, proxy: route.proxy ?? "none" });
if (route.proxy) say(`gah: reaching the inference service through ${route.proxy}`);

// --- 2. Key ------------------------------------------------------------------------------
// Reachable, with a key the endpoint did not refuse. 404 or 405 on the model
// list means the endpoint has none: the key is accepted unchecked.
const usable = (a) => typeof a.status === "number" && a.hasKey && (a.unverifiable || (a.status !== 401 && a.status !== 403));
let answers = result.answers;
while (!answers.some(usable)) {
	// The provider to ask for: the first reachable one, in config order.
	const target = answers.find((a) => typeof a.status === "number");
	const p = target.provider;
	const why = target.hasKey ? `the key for ${p.name} was refused (HTTP ${target.status})` : `there is no API key for ${p.name} yet`;
	if (!interactive) {
		say(`gah: ${why}. Start gah in a terminal to enter it.`);
		process.exit(3);
	}
	say("");
	say(`gah needs an API key for ${p.name} (${p.baseUrl}): ${why}.`);
	say("It is stored for your user only and never shown to the assistant. Press Enter to give up.");
	const key = await readLine("  API key: ", { masked: true });
	if (!key) {
		say("gah: no API key, so a session would have no model to talk to.");
		process.exit(3);
	}
	const where = storeKey(p, key);
	const r = tryRoute(route.proxy, 8000);
	answers = r.answers ?? [];
	const now = answers.find((a) => a.provider === p);
	if (now && usable(now)) say(`  key accepted${now.unverifiable || now.status >= 400 ? " (this endpoint cannot confirm keys; it will be tried on first use)" : ""}; stored in ${where}`);
	else say(`  that key was refused (HTTP ${now?.status ?? now?.error ?? "?"}).`);
}

const direct = route.proxy ? [] : [...new Set(providers.map((p) => { try { return new URL(p.baseUrl).hostname; } catch { return ""; } }).filter(Boolean))];
writeFileSync(opt.out, `${JSON.stringify({ proxy: route.proxy, direct })}\n`);
process.exit(0);
