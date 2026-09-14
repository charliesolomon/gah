#!/usr/bin/env node
/**
 * scrub-session.mjs — make a session file shareable for troubleshooting.
 *
 * A session JSONL (~/.gah/agent/sessions/<cwd>/<id>.jsonl) records everything
 * the agent saw: the working directory, tool calls with paths and commands,
 * tool results with file contents, provider and model names, and anything a
 * person pasted. Sharing one for help means sharing a map of the environment.
 * This rewrites a copy so the structure, order, timing, tool names and error
 * text survive, but identifiers do not.
 *
 *   node scripts/scrub-session.mjs <session.jsonl> [options]
 *
 *     --out <file>            scrubbed output (default: <input>.scrubbed.jsonl)
 *     --map <file>            placeholder → original map, mode 0600, never share
 *                             (default: <input>.scrub-map.json; --no-map to skip)
 *     --drop-tool-results     replace tool result bodies with length + hash
 *     --drop-thinking         remove assistant thinking blocks
 *     --keep-images           keep image data (default: replaced by a stub)
 *     --words <file>          extra strings to scrub, one per line (#-comments ok)
 *     --domains a.corp,b.lan  extra domains whose hostnames are identifiers
 *     --providers <file>      providers.json to learn names/URLs/models from
 *                             (default: $GAH_PROVIDERS_FILE or ~/.gah/providers.json)
 *     --models <file>         models.json to learn from (default: <agent dir>/models.json)
 *     --deploy <file>         a gah-deploy.json to learn org/GitLab/proxy/providers from
 *     --secrets <file>        KEY=value file whose secret-looking values are redacted
 *                             (repeatable; default: every GAH_SECRET_FILES match)
 *     --no-env                do not learn from this machine's environment
 *     --check <file>          leak-check an already scrubbed file and exit
 *
 * Two layers. LEARNED identifiers come from this machine and its config: home
 * directory, user and host names, proxy variables, DNS search domains, the
 * inference providers' names, URLs and model ids, the deployment's org and
 * GitLab. Each distinct value maps to a stable placeholder (<host-2>,
 * <provider-1>) so a story about "host-2" stays coherent, and the map file
 * lets the owner answer "what is host-2" without the reader ever seeing it.
 * GENERIC patterns catch what config did not teach: absolute paths (POSIX,
 * Windows, UNC), URLs, e-mail addresses, IP addresses, hostnames under
 * internal-looking domains, and secret-shaped strings (cloud keys, forge
 * tokens, bearer headers, private-key blocks).
 *
 * The result is leak-checked: every learned value and generic pattern is
 * searched for again in the output, and the script exits 1 if anything
 * survived. What no pattern can catch is meaning — a campus, a person, a
 * product named in prose — which is what --words is for, followed by a read.
 *
 * Organisation-neutral (#20): nothing here knows any particular company.
 * The exported functions are pure and unit-tested (make test-policy).
 */
import { createHash } from "node:crypto";
import { chmodSync, existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, hostname as osHostname } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// --- Learning identifiers ------------------------------------------------------

/** Domains whose hostnames are identifiers wherever they appear. */
export const INTERNAL_TLDS = ["local", "internal", "corp", "lan", "intranet", "home", "localdomain", "priv", "private"];

const KEY_SECRET = /(PASS|PASSWD|PASSWORD|SECRET|TOKEN|API[_-]?KEY|ACCESS[_-]?KEY|PRIVATE|CREDENTIAL|AUTH)/i;
const KEY_IDENTIFYING = /^(url|baseUrl|base_url|host|hostname|proxy|endpoint|server|domain|org|organisation|organization|gitlab|registry|realm|tenant)$/i;

/** The identifiers learned from config and environment, by category. Sets keep insertion order. */
export function emptyIdentifiers() {
	return {
		home: new Set(),
		user: new Set(),
		host: new Set(),
		url: new Set(),
		provider: new Set(),
		model: new Set(),
		org: new Set(),
		domain: new Set(),
		secret: new Set(),
		word: new Set(),
	};
}

function hostOf(url) {
	try {
		return new URL(url).hostname.toLowerCase();
	} catch {
		return null;
	}
}

function isUrl(s) {
	return /^[a-z][a-z0-9+.-]*:\/\/\S+$/i.test(s);
}

function isHostLike(s) {
	return /^(?=.{1,253}$)[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i.test(s) && !/^\d+\.\d+\.\d+\.\d+$/.test(s);
}

function addUrlOrHost(ids, value) {
	if (typeof value !== "string" || !value) return;
	if (isUrl(value)) {
		ids.url.add(value.replace(/\/+$/, ""));
		const h = hostOf(value);
		if (h && h !== "localhost" && h !== "127.0.0.1") ids.host.add(h);
	} else if (isHostLike(value)) {
		ids.host.add(value.toLowerCase());
	}
}

/** Learn from this process's environment (and the OS): home, user, host, proxies, DNS domains. */
export function learnFromEnv(ids, env = process.env, opts = {}) {
	const home = opts.home ?? env.HOME ?? env.USERPROFILE ?? "";
	if (home) ids.home.add(home.replace(/[\\/]+$/, ""));
	for (const k of ["USER", "USERNAME", "LOGNAME"]) if (env[k] && env[k].length >= 3) ids.user.add(env[k]);
	let hn = opts.hostname;
	if (hn === undefined) {
		try {
			hn = osHostname();
		} catch {
			hn = "";
		}
	}
	for (const h of [hn, env.HOSTNAME, env.COMPUTERNAME]) if (h && h.length >= 3) ids.host.add(h.toLowerCase());
	for (const k of ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy"]) {
		if (env[k]) addUrlOrHost(ids, env[k].replace(/^([a-z]+:\/\/)[^@/]+@/i, "$1"));
	}
	for (const k of ["NO_PROXY", "no_proxy", "GAH_ALLOWED_HOSTS"]) {
		for (const part of (env[k] ?? "").split(/[,\s]+/)) {
			const p = part.replace(/^\*?\./, "").trim();
			if (p && p !== "*" && p !== "localhost" && !/^[\d.]+$/.test(p)) ids.domain.add(p.toLowerCase());
		}
	}
	if (env.AWS_PROFILE && env.AWS_PROFILE !== "default") ids.word.add(env.AWS_PROFILE);
	const resolv = opts.resolvConf ?? readIfExists("/etc/resolv.conf");
	if (resolv) {
		for (const m of resolv.matchAll(/^\s*(?:search|domain)\s+(.+)$/gm)) {
			for (const d of m[1].trim().split(/\s+/)) if (d && d !== ".") ids.domain.add(d.toLowerCase());
		}
	}
	return ids;
}

/** Walk any config object: URL/host-shaped strings anywhere, plus values under identifying keys. */
export function learnFromConfig(ids, obj, path = []) {
	if (obj === null || obj === undefined) return ids;
	if (Array.isArray(obj)) {
		obj.forEach((v, i) => learnFromConfig(ids, v, [...path, String(i)]));
		return ids;
	}
	if (typeof obj === "object") {
		for (const [k, v] of Object.entries(obj)) {
			if (k.startsWith("$")) continue; // $comment, $schema
			if (typeof v === "string") {
				if (KEY_SECRET.test(k) && v.length >= 6 && !v.startsWith("$")) ids.secret.add(v);
				else if (isUrl(v) || isHostLike(v)) addUrlOrHost(ids, v);
				else if (KEY_IDENTIFYING.test(k) && v.length >= 3) ids.org.add(v);
			} else {
				learnFromConfig(ids, v, [...path, k]);
			}
		}
		// Provider entries: { name, baseUrl, models: [{ id, name }] } in providers.json,
		// { providers: { <name>: {...} } } in models.json and deploy configs.
		if (typeof obj.baseUrl === "string" || typeof obj.api === "string") {
			if (typeof obj.name === "string" && obj.name.length >= 3) ids.provider.add(obj.name);
			const parentKey = path[path.length - 1];
			if (parentKey && path[path.length - 2] === "providers" && !/^\d+$/.test(parentKey)) ids.provider.add(parentKey);
			for (const m of Array.isArray(obj.models) ? obj.models : []) {
				if (m && typeof m.id === "string" && m.id.length >= 3) ids.model.add(m.id);
				if (m && typeof m.name === "string" && m.name.length >= 3) ids.model.add(m.name);
			}
		}
	}
	return ids;
}

/** KEY=value files (env, ini): the values under secret-looking keys. */
export function learnSecretsFromEnvFile(ids, text) {
	for (const line of text.split(/\r?\n/)) {
		const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_.-]*)\s*[=:]\s*(.+?)\s*$/.exec(line);
		if (!m || !KEY_SECRET.test(m[1])) continue;
		let v = m[2].trim();
		if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
		else v = v.replace(/\s+#.*$/, "");
		if (v.length >= 6) ids.secret.add(v);
	}
	return ids;
}

/** --words file: one string per line, # comments. */
export function learnWords(ids, text) {
	for (const line of text.split(/\r?\n/)) {
		const w = line.replace(/\s+#.*$/, "").trim();
		if (w && !w.startsWith("#")) ids.word.add(w);
	}
	return ids;
}

// --- Scrubbing -----------------------------------------------------------------

const RE_ESC = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Secret-shaped strings that need no config to recognise. */
export const SECRET_SHAPES = [
	/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
	/\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, // AWS access key ids
	/\bgh[pousr]_[A-Za-z0-9]{36,}\b/g, // GitHub tokens
	/\bgithub_pat_[A-Za-z0-9_]{22,}\b/g,
	/\bglpat-[A-Za-z0-9_-]{20,}\b/g, // GitLab PATs
	/\bglrt-[A-Za-z0-9_-]{20,}\b/g, // GitLab runner tokens
	/\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g, // Slack
	/\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{20,}\b/g, // OpenAI / Anthropic style
	/\bAIza[0-9A-Za-z_-]{35}\b/g, // Google API keys
	/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, // JWTs
	/(?<=\b(?:Bearer|Basic|Token)\s+)[A-Za-z0-9._~+/=-]{16,}/g, // auth headers
	/(?<=\b(?:password|passwd|pwd|secret|token|api[_-]?key|access[_-]?key)\s*[=:]\s*["']?)[^\s"',;]{6,}/gi, // key=value in text
];

/** Generic, order-sensitive patterns that need no config. */
const RE_URL = /\b[a-z][a-z0-9+.-]*:\/\/[^\s"'<>)\]]+/gi;
const RE_EMAIL = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g;
const RE_IPV4 = /\b(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)\b(?::\d{1,5})?/g;
// Candidate first, validated by looksIpv6(): `::` compression or all 8 groups, so 12:30:45 is not an address.
const RE_IPV6 = /(?<![:\w])(?:[0-9a-f]{0,4}:){2,7}[0-9a-f]{0,4}(?![:\w])/gi;
function looksIpv6(s) {
	const colons = (s.match(/:/g) ?? []).length;
	if (s.includes(":::") || s.split("::").length > 2) return false;
	return (s.includes("::") && colons >= 2 && /[0-9a-f]/i.test(s)) || colons === 7;
}
const RE_WIN_PATH = /\b[A-Za-z]:\\(?:[^\\\s"'<>|?*]+\\)*[^\\\s"'<>|?*]*/g;
const RE_UNC_PATH = /\\\\[^\\\s"'<>|?*]+(?:\\[^\\\s"'<>|?*]+)+/g;
// Two or more segments from a root, not preceded by a word char, a placeholder's `>`, `~`, or a URL `:`.
const RE_POSIX_PATH = /(?<![\w<>~:./-])(?:\/[A-Za-z0-9._+@%-]+){2,}\/?/g;

/** A hostname whose final labels are `domain`: `\b(label.)*label.domain` with nothing after. */
function domainRegex(domain) {
	return new RegExp(`\\b(?:[a-z0-9-]+\\.)*[a-z0-9-]+\\.${RE_ESC(domain)}(?![a-z0-9.-])`, "gi");
}
/** Learned and explicit domains first (longest first), then the generic internal suffixes. */
function domainOrder(ids, options) {
	const learned = [...new Set([...(options.domains ?? []), ...ids.domain])].sort((a, b) => b.length - a.length);
	return [...learned, ...INTERNAL_TLDS.filter((d) => !learned.includes(d))];
}

/** Loopback and unspecified addresses identify nothing. */
const KEEP_IPS = new Set(["127.0.0.1", "0.0.0.0", "::1"]);
/** Paths every machine has; keeping them makes tracebacks readable. */
const KEEP_PATH_PREFIXES = ["/usr/", "/bin/", "/etc/", "/tmp/", "/dev/", "/proc/", "/sys/", "/opt/gah/", "/var/", "/lib/", "/sbin/", "/snap/", "/nix/"];

/**
 * A scrubber holds the learned identifiers and the placeholder map. It is
 * deterministic: the same original always gets the same placeholder, numbered
 * in order of first appearance.
 */
export function createScrubber(ids, options = {}) {
	const map = new Map(); // original → placeholder
	const counters = new Map();
	const counts = {}; // category → replacements
	const extraDomains = domainOrder(ids, options);

	function placeholder(category, original, fixed) {
		if (map.has(original)) return map.get(original);
		let p;
		if (fixed) p = `<${fixed}>`;
		else {
			const n = (counters.get(category) ?? 0) + 1;
			counters.set(category, n);
			p = `<${category}-${n}>`;
		}
		map.set(original, p);
		return p;
	}
	function bump(category, n = 1) {
		counts[category] = (counts[category] ?? 0) + n;
	}
	function replaceAll(text, needle, category, fixed, flags = "g") {
		if (!needle) return text;
		const re = new RegExp(RE_ESC(needle), flags);
		return text.replace(re, (m) => {
			bump(category);
			return placeholder(category, fixed ? needle : m, fixed);
		});
	}
	function replaceWord(text, needle, category, fixed, ci = false) {
		if (!needle) return text;
		const re = new RegExp(`(?<![\\w-])${RE_ESC(needle)}(?![\\w-])`, ci ? "gi" : "g");
		return text.replace(re, (m) => {
			bump(category);
			return placeholder(category, fixed ? needle : m.toLowerCase(), fixed);
		});
	}

	const secretsLongestFirst = [...ids.secret].sort((a, b) => b.length - a.length);
	const urlsLongestFirst = [...ids.url].sort((a, b) => b.length - a.length);
	const hostsLongestFirst = [...ids.host].sort((a, b) => b.length - a.length);
	const homes = [...ids.home].sort((a, b) => b.length - a.length);
	const cwd = options.cwd;

	function scrubText(text) {
		if (typeof text !== "string" || text.length === 0) return text;
		let t = text;
		// 1. Credentials: learned values, then shapes.
		for (const s of secretsLongestFirst) t = replaceAll(t, s, "secret");
		for (const re of SECRET_SHAPES) {
			t = t.replace(re, (m) => {
				bump("secret");
				return placeholder("secret", m);
			});
		}
		// 2. Learned URLs and hosts (case-insensitive: hostnames are).
		for (const u of urlsLongestFirst) t = replaceAll(t, u, "url", undefined, "gi");
		for (const h of hostsLongestFirst) t = replaceWord(t, h, "host", undefined, true);
		// 3. Working directory and home, before generic paths eat them.
		if (cwd) {
			t = replaceAll(t, cwd, "cwd", "cwd");
			if (cwd.includes("\\")) t = replaceAll(t, cwd.replaceAll("\\", "/"), "cwd", "cwd");
		}
		for (const h of homes) {
			t = replaceAll(t, h, "home", "home");
			if (h.includes("\\")) t = replaceAll(t, h.replaceAll("\\", "/"), "home", "home");
		}
		// 4. Generic URLs, then paths.
		t = t.replace(RE_URL, (m) => {
			const h = hostOf(m);
			if (!h || h === "localhost" || KEEP_IPS.has(h)) return m;
			bump("url");
			return placeholder("url", m);
		});
		t = t.replace(RE_WIN_PATH, (m) => {
			bump("path");
			return placeholder("path", m);
		});
		t = t.replace(RE_UNC_PATH, (m) => {
			bump("path");
			return placeholder("path", m);
		});
		t = t.replace(RE_POSIX_PATH, (m) => {
			if (KEEP_PATH_PREFIXES.some((p) => m.startsWith(p))) return m;
			bump("path");
			return placeholder("path", m);
		});
		// 5. Addresses.
		t = t.replace(RE_EMAIL, (m) => {
			bump("email");
			return placeholder("email", m.toLowerCase());
		});
		t = t.replace(RE_IPV4, (m) => {
			const ip = m.split(":")[0];
			if (KEEP_IPS.has(ip)) return m;
			bump("ip");
			return placeholder("ip", ip) + m.slice(ip.length);
		});
		t = t.replace(RE_IPV6, (m) => {
			if (!looksIpv6(m) || KEEP_IPS.has(m)) return m;
			bump("ip");
			return placeholder("ip", m.toLowerCase());
		});
		// 6. Hostnames under internal-looking or learned domains.
		for (const d of extraDomains) {
			t = t.replace(domainRegex(d), (m) => {
				bump("host");
				return placeholder("host", m.toLowerCase());
			});
		}
		// 7. Names: providers, models, org strings, user, extra words.
		for (const p of ids.provider) t = replaceWord(t, p, "provider");
		for (const m of ids.model) t = replaceWord(t, m, "model");
		for (const o of ids.org) t = replaceAll(t, o, "org");
		for (const u of ids.user) t = replaceWord(t, u, "user", "user", true);
		for (const w of [...ids.word].sort((a, b) => b.length - a.length)) t = replaceAll(t, w, "word", undefined, "gi");
		return t;
	}

	return {
		scrubText,
		counts: () => ({ ...counts }),
		mapping: () => Object.fromEntries([...map].map(([orig, ph]) => [ph, orig])),
	};
}

// --- Session structure -----------------------------------------------------------

function sha256(s) {
	return createHash("sha256").update(s).digest("hex").slice(0, 12);
}

/** Recursively scrub every string in a JSON value. */
export function scrubValue(v, scrub) {
	if (typeof v === "string") return scrub.scrubText(v);
	if (Array.isArray(v)) return v.map((x) => scrubValue(x, scrub));
	if (v && typeof v === "object") {
		const out = {};
		for (const [k, x] of Object.entries(v)) out[k] = scrubValue(x, scrub);
		return out;
	}
	return v;
}

function scrubContent(content, scrub, opts, role) {
	if (typeof content === "string") {
		if (role === "toolResult" && opts.dropToolResults) return `[tool result dropped: ${content.length} chars, sha256:${sha256(content)}]`;
		return scrub.scrubText(content);
	}
	if (!Array.isArray(content)) return scrubValue(content, scrub);
	const out = [];
	for (const part of content) {
		if (!part || typeof part !== "object") {
			out.push(scrubValue(part, scrub));
			continue;
		}
		switch (part.type) {
			case "thinking":
				if (opts.dropThinking) continue;
				out.push({ ...part, thinking: scrub.scrubText(part.thinking ?? ""), ...(part.thinkingSignature ? { thinkingSignature: "[dropped]" } : {}) });
				break;
			case "text":
				if (role === "toolResult" && opts.dropToolResults) {
					out.push({ ...part, text: `[tool result dropped: ${(part.text ?? "").length} chars, sha256:${sha256(part.text ?? "")}]` });
				} else out.push({ ...part, text: scrub.scrubText(part.text ?? "") });
				break;
			case "image":
				out.push(opts.keepImages ? part : { ...part, data: `[image dropped: ${(part.data ?? "").length} chars]` });
				break;
			case "toolCall":
				out.push({ ...part, arguments: scrubValue(part.arguments, scrub) });
				break;
			default:
				out.push(scrubValue(part, scrub));
		}
	}
	return out;
}

function scrubMessage(msg, scrub, opts) {
	if (!msg || typeof msg !== "object") return msg;
	const out = { ...msg };
	if ("content" in out) out.content = scrubContent(out.content, scrub, opts, msg.role);
	if (typeof out.provider === "string") out.provider = scrub.scrubText(out.provider);
	if (typeof out.model === "string") out.model = scrub.scrubText(out.model);
	if (typeof out.errorMessage === "string") out.errorMessage = scrub.scrubText(out.errorMessage);
	if ("details" in out) out.details = scrubValue(out.details, scrub);
	return out;
}

/** Scrub one session entry. Ids, parent links, timestamps and usage numbers are untouched. */
export function scrubEntry(entry, scrub, opts = {}) {
	if (!entry || typeof entry !== "object") return entry;
	const e = { ...entry };
	switch (e.type) {
		case "session":
			if (typeof e.cwd === "string") e.cwd = scrub.scrubText(e.cwd);
			if (typeof e.parentSession === "string") e.parentSession = scrub.scrubText(e.parentSession);
			return e;
		case "message":
			e.message = scrubMessage(e.message, scrub, opts);
			return e;
		case "model_change":
			if (typeof e.provider === "string") e.provider = scrub.scrubText(e.provider);
			if (typeof e.modelId === "string") e.modelId = scrub.scrubText(e.modelId);
			return e;
		case "compaction":
			if (typeof e.summary === "string") e.summary = scrub.scrubText(e.summary);
			if (Array.isArray(e.retainedTail)) e.retainedTail = e.retainedTail.map((m) => scrubMessage(m, scrub, opts));
			return e;
		case "thinking_level_change":
		case "label":
			return e;
		default:
			// custom, custom_message, branch_summary, session_info, anything newer: every string.
			return scrubValue(e, scrub);
	}
}

/** Scrub a whole JSONL text. Unparseable lines are kept only as a marker, never verbatim. */
export function scrubSession(text, scrub, opts = {}) {
	const out = [];
	let bad = 0;
	for (const line of text.split(/\r?\n/)) {
		if (line.trim() === "") continue;
		let entry;
		try {
			entry = JSON.parse(line);
		} catch {
			bad++;
			out.push(JSON.stringify({ type: "unparseable_line_dropped", length: line.length }));
			continue;
		}
		out.push(JSON.stringify(scrubEntry(entry, scrub, opts)));
	}
	return { text: out.join("\n") + "\n", unparseable: bad };
}

/** The session's cwd, so the scrubber can map it to <cwd> before generic paths run. */
export function sessionCwd(text) {
	const first = text.split(/\r?\n/).find((l) => l.trim() !== "");
	try {
		const e = JSON.parse(first ?? "");
		return e && e.type === "session" && typeof e.cwd === "string" ? e.cwd : undefined;
	} catch {
		return undefined;
	}
}

// --- Leak check ---------------------------------------------------------------------

/** Search scrubbed text for anything that should have gone. Returns findings (empty = clean). */
export function leakCheck(text, ids, options = {}) {
	const findings = [];
	const add = (category, sample, count) => findings.push({ category, sample, count });
	const countOf = (re) => (text.match(re) ?? []).length;
	const lower = text.toLowerCase();
	const learned = [
		["home", ids.home],
		["user", ids.user],
		["host", ids.host],
		["url", ids.url],
		["provider", ids.provider],
		["model", ids.model],
		["org", ids.org],
		["secret", ids.secret],
		["word", ids.word],
	];
	for (const [category, set] of learned) {
		for (const v of set) {
			if (!v) continue;
			const ci = category !== "secret";
			const hay = ci ? lower : text;
			const needle = ci ? v.toLowerCase() : v;
			// Names are checked as words; the rest as substrings.
			const re = ["user", "provider", "model"].includes(category)
				? new RegExp(`(?<![\\w-])${RE_ESC(needle)}(?![\\w-])`, "g")
				: new RegExp(RE_ESC(needle), "g");
			const n = (hay.match(re) ?? []).length;
			if (n > 0) add(category, category === "secret" ? `${v.slice(0, 3)}…` : v, n);
		}
	}
	for (const re of SECRET_SHAPES) {
		const n = countOf(new RegExp(re.source, re.flags.includes("g") ? re.flags : `${re.flags}g`));
		if (n > 0) add("secret-shape", re.source.slice(0, 30), n);
	}
	const urls = text.match(RE_URL) ?? [];
	const badUrls = urls.filter((u) => {
		const h = hostOf(u);
		return h && h !== "localhost" && !KEEP_IPS.has(h);
	});
	if (badUrls.length) add("url", badUrls[0], badUrls.length);
	const emails = countOf(RE_EMAIL);
	if (emails) add("email", (text.match(RE_EMAIL) ?? [])[0], emails);
	const ips = (text.match(RE_IPV4) ?? []).filter((m) => !KEEP_IPS.has(m.split(":")[0]));
	if (ips.length) add("ip", ips[0], ips.length);
	const ip6 = (text.match(RE_IPV6) ?? []).filter((m) => looksIpv6(m) && !KEEP_IPS.has(m));
	if (ip6.length) add("ip", ip6[0], ip6.length);
	const win = countOf(RE_WIN_PATH) + countOf(RE_UNC_PATH);
	if (win) add("path", (text.match(RE_WIN_PATH) ?? text.match(RE_UNC_PATH) ?? [])[0], win);
	const posix = (text.match(RE_POSIX_PATH) ?? []).filter((p) => !KEEP_PATH_PREFIXES.some((k) => p.startsWith(k)));
	if (posix.length) add("path", posix[0], posix.length);
	for (const d of domainOrder(ids, options)) {
		const re = domainRegex(d);
		const n = countOf(re);
		if (n) add("host", (text.match(re) ?? [])[0], n);
	}
	return findings;
}

// --- CLI ----------------------------------------------------------------------------

function readIfExists(p) {
	try {
		return existsSync(p) ? readFileSync(p, "utf8") : null;
	} catch {
		return null;
	}
}

function readJsonIfExists(p) {
	const t = readIfExists(p);
	if (t === null) return null;
	try {
		return JSON.parse(t.replace(/^﻿/, ""));
	} catch {
		console.error(`scrub-session: ${p} is not JSON; ignored`);
		return null;
	}
}

function agentDir(env = process.env) {
	const d = env.GAH_CODING_AGENT_DIR;
	if (d) return d.startsWith("~/") ? join(homedir(), d.slice(2)) : d;
	return join(homedir(), ".gah", "agent");
}

/** Expand GAH_SECRET_FILES globs the simple way: `*` within one path segment. */
function secretFilesFromEnv(env = process.env) {
	const spec = env.GAH_SECRET_FILES ?? "";
	if (!spec) return [];
	const out = [];
	for (const raw of spec.split(process.platform === "win32" ? ";" : ":")) {
		const p = raw.trim().replace(/^~(?=[\\/])/, homedir()).replace(/\$HOME|%USERPROFILE%/g, homedir());
		if (!p) continue;
		if (!p.includes("*")) {
			out.push(p);
			continue;
		}
		const dir = dirname(p);
		const re = new RegExp(`^${RE_ESC(basename(p)).replace(/\\\*/g, "[^/\\\\]*")}$`);
		let names = [];
		try {
			names = existsSync(dir) ? readdirSync(dir) : [];
		} catch {
			names = [];
		}
		for (const name of names) if (re.test(name)) out.push(join(dir, name));
	}
	return out;
}

export function parseArgs(argv) {
	const o = { secrets: [], domains: [], map: undefined, noMap: false, noEnv: false };
	const positional = [];
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		const next = () => {
			if (i + 1 >= argv.length) throw new Error(`${a} needs a value`);
			return argv[++i];
		};
		switch (a) {
			case "--out": o.out = next(); break;
			case "--map": o.map = next(); break;
			case "--no-map": o.noMap = true; break;
			case "--drop-tool-results": o.dropToolResults = true; break;
			case "--drop-thinking": o.dropThinking = true; break;
			case "--keep-images": o.keepImages = true; break;
			case "--words": o.words = next(); break;
			case "--domains": o.domains.push(...next().split(",").map((s) => s.trim()).filter(Boolean)); break;
			case "--providers": o.providers = next(); break;
			case "--models": o.models = next(); break;
			case "--deploy": o.deploy = next(); break;
			case "--secrets": o.secrets.push(next()); break;
			case "--no-env": o.noEnv = true; break;
			case "--check": o.check = next(); break;
			case "-h": case "--help": o.help = true; break;
			default:
				if (a.startsWith("-")) throw new Error(`unknown option ${a}`);
				positional.push(a);
		}
	}
	o.input = positional[0];
	if (positional.length > 1) throw new Error("one session file at a time");
	return o;
}

function usage() {
	const src = readFileSync(fileURLToPath(import.meta.url), "utf8");
	const m = /\/\*\*([\s\S]*?)\*\//.exec(src);
	console.error((m ? m[1] : "").replace(/^ \* ?/gm, ""));
}

async function main() {
	let o;
	try {
		o = parseArgs(process.argv.slice(2));
	} catch (err) {
		console.error(`scrub-session: ${err.message}`);
		process.exit(2);
	}
	if (o.help || (!o.input && !o.check)) {
		usage();
		process.exit(o.help ? 0 : 2);
	}

	const ids = emptyIdentifiers();
	if (!o.noEnv) learnFromEnv(ids);
	const providersPath = o.providers ?? process.env.GAH_PROVIDERS_FILE ?? join(homedir(), ".gah", "providers.json");
	const modelsPath = o.models ?? join(agentDir(), "models.json");
	for (const p of [providersPath, modelsPath, o.deploy]) {
		if (!p) continue;
		const j = readJsonIfExists(p);
		if (j) learnFromConfig(ids, j);
	}
	const secretFiles = o.secrets.length ? o.secrets : secretFilesFromEnv();
	for (const f of secretFiles) {
		const t = readIfExists(f);
		if (t !== null) learnSecretsFromEnvFile(ids, t);
	}
	if (o.words) {
		const t = readIfExists(o.words);
		if (t === null) {
			console.error(`scrub-session: cannot read --words ${o.words}`);
			process.exit(2);
		}
		learnWords(ids, t);
	}
	// The map file itself and the outputs must never be scrubbed as identifiers.
	const learnedSummary = Object.entries(ids)
		.map(([k, s]) => `${k}=${s.size}`)
		.join(" ");

	if (o.check) {
		const text = readIfExists(o.check);
		if (text === null) {
			console.error(`scrub-session: cannot read ${o.check}`);
			process.exit(2);
		}
		const findings = leakCheck(text, ids, { domains: o.domains });
		report(findings, learnedSummary);
		process.exit(findings.length ? 1 : 0);
	}

	const text = readIfExists(o.input);
	if (text === null) {
		console.error(`scrub-session: cannot read ${o.input}`);
		process.exit(2);
	}
	const cwd = sessionCwd(text);
	const scrub = createScrubber(ids, { cwd, domains: o.domains });
	const result = scrubSession(text, scrub, { dropToolResults: o.dropToolResults, dropThinking: o.dropThinking, keepImages: o.keepImages });

	const outPath = o.out ?? o.input.replace(/\.jsonl$/, "") + ".scrubbed.jsonl";
	writeFileSync(outPath, result.text, "utf8");
	if (!o.noMap) {
		const mapPath = o.map ?? o.input.replace(/\.jsonl$/, "") + ".scrub-map.json";
		writeFileSync(mapPath, `${JSON.stringify(scrub.mapping(), null, 2)}\n`, "utf8");
		try {
			chmodSync(mapPath, 0o600);
		} catch {
			/* Windows */
		}
		console.error(`map:      ${mapPath}  (placeholder → original; keep private)`);
	}
	console.error(`scrubbed: ${outPath}`);
	console.error(`learned:  ${learnedSummary}`);
	const counts = scrub.counts();
	console.error(`replaced: ${Object.keys(counts).length ? Object.entries(counts).map(([k, n]) => `${k}=${n}`).join(" ") : "nothing"}`);
	if (result.unparseable) console.error(`dropped:  ${result.unparseable} unparseable line(s)`);
	if (o.dropToolResults) console.error("tool results: replaced by length + hash");

	const findings = leakCheck(result.text, ids, { domains: o.domains });
	report(findings);
	if (findings.length) {
		console.error("scrub-session: identifiers survived the scrub (see above); output NOT safe to share");
		process.exit(1);
	}
	console.error("leak-check: clean. Read the output once for names no pattern can know (--words).");
}

function report(findings, learnedSummary) {
	if (learnedSummary) console.error(`learned:  ${learnedSummary}`);
	if (!findings.length) return;
	console.error("leak-check: FOUND");
	for (const f of findings) console.error(`  ${f.category.padEnd(12)} ×${String(f.count).padStart(3)}  ${f.sample}`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
	await main();
}
