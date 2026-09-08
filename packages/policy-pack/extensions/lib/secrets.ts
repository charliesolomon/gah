/**
 * GAH_SECRET_FILES: files the model must never see (issue #53).
 *
 * A deployment names its secret stores as path globs, separated by the
 * platform's PATH delimiter (":" on POSIX, ";" on Windows), e.g.
 *   GAH_SECRET_FILES="$HOME/*.env:$HOME/.aws/*"
 * Three layers use this module, in order of reliability:
 *   1. file tools (read/write/edit): a path that matches is refused -- exact;
 *   2. shells (bash/powershell): a command whose text references a matching
 *      path -- literally, via ~ or $HOME, or via any exported variable that
 *      holds such a path -- is refused. A heuristic, so the model gets a clear
 *      message instead of a spiral; it is not what keeps the secret out;
 *   3. every tool result has the secret VALUES replaced before the model or
 *      the transcript sees them. This is the wall: it does not care how the
 *      bytes were obtained.
 * Scripts the skills call still source the files normally: nothing here
 * touches subprocess file access, only what the model asks for and gets back.
 *
 * Pure functions, no PI imports, so they can be unit-tested with node:test.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, delimiter, isAbsolute, resolve } from "node:path";

const WIN = process.platform === "win32";

/** Forward slashes, ~ and $HOME expanded, no trailing slash. */
export function normalizePath(p: string, home: string = homedir()): string {
	let s = p.trim().replaceAll("\\", "/");
	s = s.replace(/^~(?=\/|$)/, home.replaceAll("\\", "/"));
	s = s.replace(/^\$\{?HOME\}?(?=\/|$)/, home.replaceAll("\\", "/"));
	s = s.replace(/^%USERPROFILE%(?=\/|$)/i, home.replaceAll("\\", "/"));
	if (s.length > 1) s = s.replace(/\/+$/, "");
	return s;
}

/** Split GAH_SECRET_FILES into normalized glob patterns. */
export function parseSecretGlobs(spec: string | undefined, home: string = homedir()): string[] {
	if (!spec) return [];
	return spec
		.split(delimiter)
		.map((s) => s.trim())
		.filter((s) => s.length > 0)
		.map((s) => normalizePath(s, home));
}

const RE_SPECIAL = /[.+^${}()|[\]\\]/g;

/** A path glob: `*` and `?` stay inside one segment, `**` crosses segments. */
export function globToRegExp(glob: string, caseInsensitive: boolean = WIN): RegExp {
	let re = "";
	for (let i = 0; i < glob.length; i++) {
		const c = glob[i];
		if (c === "*") {
			if (glob[i + 1] === "*") {
				re += ".*";
				i++;
			} else {
				re += "[^/]*";
			}
		} else if (c === "?") {
			re += "[^/]";
		} else {
			re += c.replace(RE_SPECIAL, "\\$&");
		}
	}
	return new RegExp(`^${re}$`, caseInsensitive ? "i" : "");
}

export function hasWildcard(s: string): boolean {
	return /[*?]/.test(s);
}

/** Absolute, normalized form of a path the model referenced. */
export function absolutize(p: string, cwd: string, home: string = homedir()): string {
	const n = normalizePath(p, home);
	if (isAbsolute(n) || /^[A-Za-z]:\//.test(n)) return n;
	return resolve(cwd, n).replaceAll("\\", "/");
}

/** Does this concrete path fall under any secret pattern? */
export function isSecretPath(path: string, patterns: string[], cwd: string, home: string = homedir()): boolean {
	if (patterns.length === 0) return false;
	const abs = absolutize(path, cwd, home);
	return patterns.some((pat) => globToRegExp(pat).test(abs));
}

/**
 * The secret files that exist right now. Wildcards are expanded one directory
 * deep (`dir/*.env`) or recursively for `**`; a pattern with no wildcard is
 * included when the file exists.
 */
export function resolveSecretFiles(patterns: string[]): string[] {
	const out = new Set<string>();
	for (const pat of patterns) {
		if (!hasWildcard(pat)) {
			if (existsSync(pat) && statSync(pat).isFile()) out.add(pat);
			continue;
		}
		// Walk from the deepest wildcard-free prefix.
		const parts = pat.split("/");
		let i = 0;
		while (i < parts.length && !hasWildcard(parts[i])) i++;
		const root = parts.slice(0, i).join("/") || "/";
		const recursive = pat.includes("**");
		const re = globToRegExp(pat);
		const walk = (dir: string, depth: number) => {
			let entries: import("node:fs").Dirent[];
			try {
				entries = readdirSync(dir, { withFileTypes: true });
			} catch {
				return;
			}
			for (const e of entries) {
				const p = `${dir}/${e.name}`.replaceAll("//", "/");
				if (e.isFile() && re.test(p)) out.add(p);
				else if (e.isDirectory() && (recursive || depth < parts.length - i - 1)) walk(p, depth + 1);
			}
		};
		if (existsSync(root)) walk(root, 0);
	}
	return [...out].sort();
}

/** Characters that end a shell word for our purposes. */
const TOKEN_SPLIT = /[\s;|&<>()`]+/;

/**
 * Expand the ways a shell command can spell a path: quotes stripped, ~ and
 * $HOME, `$VAR` / `${VAR}` / `$env:VAR` / `%VAR%` for exported variables.
 */
export function expandToken(token: string, env: NodeJS.ProcessEnv, home: string = homedir()): string {
	let t = token.replace(/^["']+|["']+$/g, "");
	t = t.replace(/\$env:([A-Za-z_][A-Za-z0-9_]*)/g, (_m, n) => env[n] ?? `$env:${n}`);
	t = t.replace(/%([A-Za-z_][A-Za-z0-9_]*)%/g, (_m, n) => env[n] ?? `%${n}%`);
	t = t.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_m, n) => env[n] ?? `\${${n}}`);
	t = t.replace(/\$([A-Za-z_][A-Za-z0-9_]*)/g, (_m, n) => env[n] ?? `$${n}`);
	return normalizePath(t, home);
}

/**
 * The first word of a shell command that refers to a secret file, or null.
 * A wildcard word (`~/*.env`) counts when it would match an existing secret
 * file; a plain word counts when it falls under a secret pattern.
 */
export function commandReferencesSecret(
	command: string,
	patterns: string[],
	files: string[],
	env: NodeJS.ProcessEnv,
	cwd: string,
	home: string = homedir(),
): string | null {
	if (patterns.length === 0) return null;
	for (const raw of command.split(TOKEN_SPLIT)) {
		if (!raw) continue;
		// `KEY=value` prefixes and `--flag=value` forms: look at the value too.
		const candidates = [raw];
		const eq = raw.indexOf("=");
		if (eq > 0 && eq < raw.length - 1) candidates.push(raw.slice(eq + 1));
		for (const cand of candidates) {
			const word = expandToken(cand, env, home);
			if (!word.includes("/") && !word.startsWith("~")) continue;
			if (hasWildcard(word)) {
				const re = globToRegExp(absolutize(word, cwd, home));
				if (files.some((f) => re.test(f))) return raw;
			} else if (isSecretPath(word, patterns, cwd, home)) {
				return raw;
			}
		}
	}
	return null;
}

export interface SecretValue {
	file: string;
	key: string;
	value: string;
}

/** Keys whose values are worth redacting. Usernames and paths are not. */
const SECRET_KEY = /(PASS|PASSWD|PASSWORD|SECRET|TOKEN|API[_-]?KEY|ACCESS[_-]?KEY|PRIVATE|CREDENTIAL|AUTH)/i;
const MIN_VALUE_LENGTH = 6;

/** Unquote a value as written by a shell (`printf %q`), an env file, or an ini file. */
export function unquoteValue(v: string): string {
	let s = v.trim();
	if (s.startsWith("$'") && s.endsWith("'")) s = s.slice(2, -1);
	else if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) s = s.slice(1, -1);
	else {
		// unquoted: a trailing comment and printf %q escapes
		s = s.replace(/\s+#.*$/, "");
	}
	return s.replace(/\\(.)/g, "$1");
}

/** Parse `KEY=value`, `export KEY=value`, `key = value` lines from the secret files. */
export function loadSecretValues(files: string[]): SecretValue[] {
	const out: SecretValue[] = [];
	for (const file of files) {
		let text: string;
		try {
			text = readFileSync(file, "utf8");
		} catch {
			continue;
		}
		for (const line of text.split(/\r?\n/)) {
			const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_.-]*)\s*[=:]\s*(.+?)\s*$/.exec(line);
			if (!m || !SECRET_KEY.test(m[1])) continue;
			const value = unquoteValue(m[2]);
			if (value.length < MIN_VALUE_LENGTH) continue;
			out.push({ file: basename(file), key: m[1], value });
		}
	}
	// Longest first so a value that contains another is replaced whole.
	return out.sort((a, b) => b.value.length - a.value.length);
}

export interface RedactHit {
	file: string;
	key: string;
	count: number;
}

/** Replace every secret value in the text with a labelled placeholder. */
export function redactText(text: string, secrets: SecretValue[]): { text: string; hits: RedactHit[] } {
	const hits: RedactHit[] = [];
	let t = text;
	for (const s of secrets) {
		if (!t.includes(s.value)) continue;
		const parts = t.split(s.value);
		hits.push({ file: s.file, key: s.key, count: parts.length - 1 });
		t = parts.join(`[redacted:${s.file}:${s.key}]`);
	}
	return { text: t, hits };
}

/** For messages: the directory a pattern lives in, without leaking the file list. */
export function describePatterns(patterns: string[], home: string = homedir()): string {
	return patterns.map((p) => p.replace(home.replaceAll("\\", "/"), "~")).join(", ");
}
