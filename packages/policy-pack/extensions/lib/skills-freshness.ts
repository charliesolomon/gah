/**
 * Skills freshness (#91): the pieces behind two behaviours of skills-freshness.ts.
 *
 *   1. In-session, a git-backed --skill checkout can fall behind its remote
 *      (the launcher only resets it at launch). Fetch, compare, and say so.
 *   2. At startup, the checkout may have moved since the person last used it.
 *      Summarise what changed — from the repo's CHANGELOG.md when it keeps one,
 *      otherwise from the commit subjects — and remember what they have seen.
 *
 * Everything here is fs + git, no pi imports, so it is testable against a
 * throwaway repository (test/skills-freshness.test.ts). Every git call is
 * bounded by a timeout and every failure degrades to "no news": an offline
 * host must never turn into an error at the prompt.
 */

import { execFile, execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

// --- Which checkouts -----------------------------------------------------------

/** The values of every `--skill <path>` / `--skill=<path>` on a command line. */
export function skillPathsFromArgv(argv: readonly string[]): string[] {
	const paths: string[] = [];
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === "--skill") {
			const next = argv[i + 1];
			if (next !== undefined && !next.startsWith("-")) {
				paths.push(next);
				i++;
			}
		} else if (arg.startsWith("--skill=")) {
			const value = arg.slice("--skill=".length);
			if (value) paths.push(value);
		}
	}
	return paths;
}

/** Nearest ancestor (or the path itself) holding a `.git`; null when there is none. */
export function findRepoRoot(path: string): string | null {
	let dir = resolve(path);
	for (;;) {
		if (existsSync(join(dir, ".git"))) return dir;
		const parent = dirname(dir);
		if (parent === dir) return null;
		dir = parent;
	}
}

/** Distinct git roots behind a list of skill paths, in first-seen order. */
export function skillRepos(paths: readonly string[]): string[] {
	const roots: string[] = [];
	for (const p of paths) {
		const root = findRepoRoot(p);
		if (root && !roots.includes(root)) roots.push(root);
	}
	return roots;
}

// --- git ----------------------------------------------------------------------

const GIT_ENV = { ...process.env, GIT_TERMINAL_PROMPT: "0", LC_ALL: "C" };

/** Run git in `root`; stdout trimmed, or null on any failure or timeout. */
export function git(root: string, args: readonly string[], timeoutMs = 5000): string | null {
	try {
		return execFileSync("git", ["-C", root, ...args], {
			encoding: "utf-8",
			timeout: timeoutMs,
			stdio: ["ignore", "pipe", "ignore"],
			env: GIT_ENV,
		}).trim();
	} catch {
		return null;
	}
}

/** Async twin of git(), for calls that may wait on the network (fetch). */
export function gitAsync(root: string, args: readonly string[], timeoutMs = 30_000): Promise<string | null> {
	return new Promise((resolveResult) => {
		execFile(
			"git",
			["-C", root, ...args],
			{ encoding: "utf-8", timeout: timeoutMs, env: GIT_ENV },
			(error, stdout) => resolveResult(error ? null : String(stdout).trim()),
		);
	});
}

export function headSha(root: string): string | null {
	return git(root, ["rev-parse", "HEAD"]);
}

export function currentBranch(root: string): string | null {
	const name = git(root, ["rev-parse", "--abbrev-ref", "HEAD"]);
	return name && name !== "HEAD" ? name : null;
}

/** The tracking ref (e.g. `origin/main`), or null for a detached or untracked checkout. */
export function upstreamRef(root: string): string | null {
	return git(root, ["rev-parse", "--abbrev-ref", "@{upstream}"]);
}

/** `git fetch` the tracking remote. Quiet on failure: offline is not an error. */
export async function fetchUpstream(root: string, timeoutMs = 30_000): Promise<boolean> {
	const upstream = upstreamRef(root);
	if (!upstream) return false;
	const slash = upstream.indexOf("/");
	if (slash <= 0) return false;
	const remote = upstream.slice(0, slash);
	const branch = upstream.slice(slash + 1);
	return (await gitAsync(root, ["fetch", "--quiet", remote, branch], timeoutMs)) !== null;
}

/** Commits on the (already fetched) tracking ref that HEAD lacks; null when unknown. */
export function commitsBehind(root: string): number | null {
	const out = git(root, ["rev-list", "--count", "HEAD..@{upstream}"]);
	if (out === null) return null;
	const n = Number.parseInt(out, 10);
	return Number.isFinite(n) ? n : null;
}

// --- What changed --------------------------------------------------------------

/** Paths whose commits count as skill changes. Anything else (CI, docs) is noise to the person. */
export const SKILL_CHANGE_PATHS = ["skills", "bin", "prompts", "setup"] as const;

export interface ChangelogEntry {
	/** The `## ...` heading text (a version, a date — whatever the repo uses). */
	heading: string;
	/** Heading plus body, as written. */
	content: string;
}

/**
 * Split a Keep-a-Changelog style file into its `## ` sections. Anything before
 * the first heading (title, preamble) is dropped.
 */
export function parseChangelog(markdown: string): ChangelogEntry[] {
	const entries: ChangelogEntry[] = [];
	let current: { heading: string; lines: string[] } | null = null;
	for (const line of markdown.split(/\r?\n/)) {
		const m = /^##\s+(.+?)\s*$/.exec(line);
		if (m) {
			if (current) entries.push({ heading: current.heading, content: current.lines.join("\n").trim() });
			current = { heading: m[1], lines: [line] };
		} else if (current) {
			current.lines.push(line);
		}
	}
	if (current) entries.push({ heading: current.heading, content: current.lines.join("\n").trim() });
	return entries;
}

/** Entries whose heading exists in `now` but not in `before`, in file order. */
export function newChangelogEntries(before: string, now: string): ChangelogEntry[] {
	const seen = new Set(parseChangelog(before).map((e) => e.heading));
	return parseChangelog(now).filter((e) => !seen.has(e.heading));
}

export interface UpdateSummary {
	/** Where the summary came from. `none` = the two shas differ but nothing under the skill paths changed. */
	source: "changelog" | "log" | "none";
	/** Short form for the startup notice. */
	lines: string[];
	/** Everything, for the /skills-changelog command. */
	full: string[];
}

/**
 * Describe `from..to` for a person. A CHANGELOG.md at the repo root wins when it
 * gained entries in that range; otherwise the commit subjects touching the skill
 * paths, newest first. `cap` limits the short form; the full form is uncapped.
 */
export function summariseUpdate(root: string, from: string, to: string, cap = 8): UpdateSummary {
	const before = git(root, ["show", `${from}:CHANGELOG.md`]);
	const now = git(root, ["show", `${to}:CHANGELOG.md`]);
	if (now !== null) {
		const entries = newChangelogEntries(before ?? "", now);
		if (entries.length > 0) {
			const full = entries.map((e) => e.content);
			const lines = capLines(
				entries.flatMap((e) => changelogEntryLines(e)),
				cap,
			);
			return { source: "changelog", lines, full };
		}
	}
	const log = git(root, [
		"log",
		"--no-merges",
		"--format=%s",
		`${from}..${to}`,
		"--",
		...SKILL_CHANGE_PATHS,
	]);
	const subjects = (log ?? "")
		.split("\n")
		.map((s) => s.trim())
		.filter(Boolean);
	if (subjects.length === 0) return { source: "none", lines: [], full: [] };
	const full = subjects.map((s) => `- ${s}`);
	return { source: "log", lines: capLines(full, cap), full };
}

/** One entry → its heading and bullet lines, so a capped list still reads well. */
function changelogEntryLines(entry: ChangelogEntry): string[] {
	const out = [`${entry.heading}`];
	for (const line of entry.content.split("\n").slice(1)) {
		const t = line.trim();
		if (/^[-*]\s+/.test(t)) out.push(`  ${t}`);
	}
	return out;
}

export function capLines(lines: readonly string[], cap: number): string[] {
	if (lines.length <= cap) return [...lines];
	const rest = lines.length - cap;
	return [...lines.slice(0, cap), `  … and ${rest} more (/skills-changelog)`];
}

// --- Seen markers (settings.json) ---------------------------------------------

/** settings.json key: repo root → last sha the person has been told about. */
export const SEEN_KEY = "skillsSeen";

function readSettings(path: string): Record<string, unknown> | null {
	if (!existsSync(path)) return {};
	try {
		const parsed = JSON.parse(readFileSync(path, "utf-8").replace(/^﻿/, ""));
		return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
	} catch {
		return null;
	}
}

/** Merge-write like last-model.ts: every other key survives; an unparseable file is left alone. */
function writeSettings(path: string, next: Record<string, unknown>): void {
	mkdirSync(dirname(path), { recursive: true });
	const tmp = `${path}.${process.pid}.tmp`;
	writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, "utf-8");
	renameSync(tmp, path);
}

export function readSeen(path: string): Record<string, string> {
	const settings = readSettings(path);
	const raw = settings?.[SEEN_KEY];
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
	const out: Record<string, string> = {};
	for (const [k, v] of Object.entries(raw as Record<string, unknown>)) if (typeof v === "string") out[k] = v;
	return out;
}

/** Record the sha for one or more roots. Returns false when the file could not be honoured. */
export function markSeen(path: string, marks: Record<string, string>): boolean {
	const settings = readSettings(path);
	if (settings === null) return false;
	const current = readSeen(path);
	const merged = { ...current, ...marks };
	if (Object.keys(marks).every((k) => current[k] === marks[k])) return true;
	writeSettings(path, { ...settings, [SEEN_KEY]: merged });
	return true;
}

/** Forget one root, or every root when none is given — the next launch shows nothing and re-records. */
export function clearSeen(path: string, root?: string): boolean {
	const settings = readSettings(path);
	if (settings === null) return false;
	const current = readSeen(path);
	if (root === undefined) {
		if (!(SEEN_KEY in settings)) return true;
		const { [SEEN_KEY]: _dropped, ...rest } = settings;
		writeSettings(path, rest);
		return true;
	}
	if (!(root in current)) return true;
	const { [root]: _dropped, ...rest } = current;
	writeSettings(path, { ...settings, [SEEN_KEY]: rest });
	return true;
}

// --- Knobs -----------------------------------------------------------------------

/** GAH_SKILLS_POLL_MINUTES: how often to look for updates in-session. Default 10; 0 (or junk) = never. */
export function parsePollMinutes(raw: string | undefined, fallback = 10): number {
	if (raw === undefined || raw.trim() === "") return fallback;
	const n = Number(raw);
	if (!Number.isFinite(n) || n < 0) return 0;
	return n;
}

/** Short display form of a checkout: the repo directory name. */
export function repoLabel(root: string): string {
	return root.split(/[\\/]/).filter(Boolean).pop() ?? root;
}
