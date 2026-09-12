// Unit tests for lib/skills-freshness.ts against a throwaway git repository. Run: make test-policy
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
	capLines,
	clearSeen,
	commitsBehind,
	fetchUpstream,
	findRepoRoot,
	headSha,
	markSeen,
	newChangelogEntries,
	parseChangelog,
	parsePollMinutes,
	readSeen,
	repoLabel,
	skillPathsFromArgv,
	skillRepos,
	summariseUpdate,
	upstreamRef,
} from "../extensions/lib/skills-freshness.ts";

function sh(cwd: string, args: string[]): string {
	return execFileSync("git", args, {
		cwd,
		encoding: "utf-8",
		stdio: ["ignore", "pipe", "ignore"],
		env: {
			...process.env,
			GIT_AUTHOR_NAME: "t",
			GIT_AUTHOR_EMAIL: "t@example.com",
			GIT_COMMITTER_NAME: "t",
			GIT_COMMITTER_EMAIL: "t@example.com",
		},
	}).trim();
}

/** A bare origin, a "server-side" working clone to push from, and the agent's clone. */
function fixture(t: { after(fn: () => void): void }) {
	const dir = mkdtempSync(join(tmpdir(), "gah-skills-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const origin = join(dir, "origin.git");
	const author = join(dir, "author");
	const agent = join(dir, "agent");
	sh(dir, ["init", "--bare", "-q", "-b", "main", origin]);
	sh(dir, ["clone", "-q", origin, author]);
	commit(author, "skills/a/SKILL.md", "---\nname: a\n---\nA", "add skill a");
	sh(author, ["push", "-q", "-u", "origin", "main"]);
	sh(dir, ["clone", "-q", origin, agent]);
	return { dir, origin, author, agent };
}

function commit(repo: string, file: string, content: string, subject: string): string {
	const path = join(repo, file);
	mkdirSync(join(path, ".."), { recursive: true });
	writeFileSync(path, content);
	sh(repo, ["add", "-A"]);
	sh(repo, ["commit", "-q", "-m", subject]);
	return sh(repo, ["rev-parse", "HEAD"]);
}

test("skillPathsFromArgv reads --skill X and --skill=X, ignores the rest", () => {
	assert.deepEqual(
		skillPathsFromArgv(["node", "pi", "--no-skills", "--skill", "/r/skills/a", "--skill=/r/skills/b", "--skill", "--x", "--prompt-template", "/p"]),
		["/r/skills/a", "/r/skills/b"],
	);
	assert.deepEqual(skillPathsFromArgv([]), []);
});

test("findRepoRoot walks up to .git; skillRepos deduplicates to the root", (t) => {
	const { agent, dir } = fixture(t);
	const skillDir = join(agent, "skills", "a");
	assert.equal(findRepoRoot(skillDir), agent);
	assert.equal(findRepoRoot(agent), agent);
	const plain = join(dir, "plain-skills");
	mkdirSync(plain, { recursive: true });
	assert.equal(findRepoRoot(plain), null);
	assert.deepEqual(skillRepos([skillDir, join(agent, "skills", "b"), plain, agent]), [agent]);
});

test("behind detection: nothing until origin moves, then the fetched count", async (t) => {
	const { author, agent } = fixture(t);
	assert.equal(upstreamRef(agent), "origin/main");
	assert.equal(await fetchUpstream(agent), true);
	assert.equal(commitsBehind(agent), 0);
	commit(author, "skills/a/SKILL.md", "---\nname: a\n---\nA2", "a: fix the thing");
	sh(author, ["push", "-q"]);
	assert.equal(commitsBehind(agent), 0, "stale until fetched");
	assert.equal(await fetchUpstream(agent), true);
	assert.equal(commitsBehind(agent), 1);
	assert.equal(headSha(agent), sh(agent, ["rev-parse", "HEAD"]), "fetch never moves HEAD");
});

test("fetchUpstream is quietly false for a checkout with no tracking ref", (t) => {
	const dir = mkdtempSync(join(tmpdir(), "gah-skills-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	sh(dir, ["init", "-q", "-b", "main", "."]);
	commit(dir, "skills/x/SKILL.md", "x", "x");
	return fetchUpstream(dir).then((ok) => {
		assert.equal(ok, false);
		assert.equal(upstreamRef(dir), null);
	});
});

test("summariseUpdate: commit subjects under the skill paths, newest first, capped", (t) => {
	const { agent } = fixture(t);
	const from = sh(agent, ["rev-parse", "HEAD"]);
	commit(agent, "README.md", "docs only", "docs: readme");
	commit(agent, "skills/a/SKILL.md", "v2", "a: accept display numbers");
	commit(agent, "bin/tool.sh", "#!/bin/sh", "bin: add tool");
	commit(agent, ".github/ci.yml", "ci", "ci: lint");
	const to = sh(agent, ["rev-parse", "HEAD"]);
	const s = summariseUpdate(agent, from, to);
	assert.equal(s.source, "log");
	assert.deepEqual(s.lines, ["- bin: add tool", "- a: accept display numbers"]);
	assert.deepEqual(s.full, s.lines);

	const capped = summariseUpdate(agent, from, to, 1);
	assert.deepEqual(capped.lines, ["- bin: add tool", "  … and 1 more (/skills-changelog)"]);
	assert.equal(capped.full.length, 2);
});

test("summariseUpdate: 'none' when only non-skill paths changed", (t) => {
	const { agent } = fixture(t);
	const from = sh(agent, ["rev-parse", "HEAD"]);
	commit(agent, "README.md", "docs", "docs: readme");
	const s = summariseUpdate(agent, from, sh(agent, ["rev-parse", "HEAD"]));
	assert.equal(s.source, "none");
	assert.deepEqual(s.lines, []);
});

test("summariseUpdate prefers new CHANGELOG.md entries and keeps their bullets", (t) => {
	const { agent } = fixture(t);
	commit(agent, "CHANGELOG.md", "# Changes\n\n## 2026-09-01\n- first skill\n", "changelog: start");
	const from = sh(agent, ["rev-parse", "HEAD"]);
	commit(agent, "skills/a/SKILL.md", "v2", "a: something");
	commit(
		agent,
		"CHANGELOG.md",
		"# Changes\n\n## 2026-09-12\n- ticket-detail accepts display numbers\n- room-check: valid frontmatter\n\n## 2026-09-01\n- first skill\n",
		"changelog: 2026-09-12",
	);
	const s = summariseUpdate(agent, from, sh(agent, ["rev-parse", "HEAD"]));
	assert.equal(s.source, "changelog");
	assert.deepEqual(s.lines, ["2026-09-12", "  - ticket-detail accepts display numbers", "  - room-check: valid frontmatter"]);
	assert.equal(s.full.length, 1);
	assert.match(s.full[0], /^## 2026-09-12/);
});

test("summariseUpdate falls back to the log when CHANGELOG.md exists but gained nothing", (t) => {
	const { agent } = fixture(t);
	commit(agent, "CHANGELOG.md", "## 1.0\n- x\n", "changelog");
	const from = sh(agent, ["rev-parse", "HEAD"]);
	commit(agent, "skills/a/SKILL.md", "v3", "a: tweak");
	const s = summariseUpdate(agent, from, sh(agent, ["rev-parse", "HEAD"]));
	assert.equal(s.source, "log");
	assert.deepEqual(s.lines, ["- a: tweak"]);
});

test("parseChangelog / newChangelogEntries key on headings, any format", () => {
	const before = "# T\n\n## [1.0.0]\n- a\n";
	const now = "# T\n\n## [1.1.0]\n- b\n- c\n\n## [1.0.0]\n- a\n";
	assert.deepEqual(
		parseChangelog(now).map((e) => e.heading),
		["[1.1.0]", "[1.0.0]"],
	);
	const fresh = newChangelogEntries(before, now);
	assert.equal(fresh.length, 1);
	assert.equal(fresh[0].heading, "[1.1.0]");
	assert.equal(fresh[0].content, "## [1.1.0]\n- b\n- c");
	assert.deepEqual(newChangelogEntries("", "no headings here"), []);
});

test("seen markers: read, merge-write keeping other keys, clear one or all", (t) => {
	const dir = mkdtempSync(join(tmpdir(), "gah-skills-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const path = join(dir, "agent", "settings.json");
	assert.deepEqual(readSeen(path), {});
	assert.equal(markSeen(path, { "/r/one": "aaa" }), true);
	writeFileSync(path, JSON.stringify({ ...JSON.parse(readFileSync(path, "utf-8")), theme: "dark" }));
	assert.equal(markSeen(path, { "/r/two": "bbb" }), true);
	assert.deepEqual(JSON.parse(readFileSync(path, "utf-8")), {
		skillsSeen: { "/r/one": "aaa", "/r/two": "bbb" },
		theme: "dark",
	});
	assert.equal(markSeen(path, { "/r/one": "aaa" }), true, "no-op when unchanged");
	assert.equal(clearSeen(path, "/r/one"), true);
	assert.deepEqual(readSeen(path), { "/r/two": "bbb" });
	assert.equal(clearSeen(path), true);
	assert.deepEqual(JSON.parse(readFileSync(path, "utf-8")), { theme: "dark" });
	assert.equal(clearSeen(path), true, "idempotent");
});

test("seen markers leave a file that is not JSON alone", (t) => {
	const dir = mkdtempSync(join(tmpdir(), "gah-skills-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const path = join(dir, "settings.json");
	writeFileSync(path, "{ not json");
	assert.equal(markSeen(path, { "/r": "x" }), false);
	assert.equal(clearSeen(path), false);
	assert.equal(readFileSync(path, "utf-8"), "{ not json");
});

test("knobs: poll minutes and labels", () => {
	assert.equal(parsePollMinutes(undefined), 10);
	assert.equal(parsePollMinutes(""), 10);
	assert.equal(parsePollMinutes("0"), 0);
	assert.equal(parsePollMinutes("2.5"), 2.5);
	assert.equal(parsePollMinutes("nope"), 0);
	assert.equal(parsePollMinutes("-3"), 0);
	assert.equal(repoLabel("/home/u/.gah/skills-repo"), "skills-repo");
	assert.equal(repoLabel("C:\\Users\\u\\skills\\"), "skills");
	assert.deepEqual(capLines(["a", "b"], 2), ["a", "b"]);
});
