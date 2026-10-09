// Unit tests for lib/onboarding.ts (#135). Run: make test-policy
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { test } from "node:test";
import {
	isUnder,
	launcherKind,
	noSharedSkillsNote,
	nudgeEnabled,
	setupSkillDirs,
	sharedSkillPaths,
} from "../extensions/lib/onboarding.ts";

test("setup skill folders: the host's, then the deployment's, then the built-in ones; missing ones skipped", () => {
	const root = mkdtempSync(join(tmpdir(), "onb-"));
	try {
		const policy = join(root, "gah-policy");
		mkdirSync(join(policy, "setup-skills"), { recursive: true });
		assert.deepEqual(setupSkillDirs(policy, {}), [join(policy, "setup-skills")]);
		mkdirSync(join(policy, "deploy-setup-skills"));
		const host = join(root, "host-setup");
		mkdirSync(host);
		const env = { GAH_SETUP_SKILLS_DIR: [host, join(root, "missing")].join(delimiter) };
		assert.deepEqual(setupSkillDirs(policy, env), [host, join(policy, "deploy-setup-skills"), join(policy, "setup-skills")]);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("isUnder matches whole path segments only", () => {
	assert.equal(isUnder("/p/setup-skills/a/SKILL.md", ["/p/setup-skills"]), true);
	assert.equal(isUnder("/p/setup-skills-extra/a/SKILL.md", ["/p/setup-skills"]), false);
	assert.equal(isUnder("/p/setup-skills", ["/p/setup-skills"]), true);
});

test("setup skills never count as shared skills", () => {
	const dirs = ["/pkg/gah-policy/setup-skills", "/pkg/gah-policy/deploy-setup-skills"];
	const paths = [
		"/pkg/gah-policy/setup-skills/setup-skills/SKILL.md",
		"/pkg/gah-policy/deploy-setup-skills/setup-gitlab/SKILL.md",
		"/home/a/.local/share/gah/skills/abc/skills/triage/SKILL.md",
		"",
	];
	assert.deepEqual(sharedSkillPaths(paths, dirs), ["/home/a/.local/share/gah/skills/abc/skills/triage/SKILL.md"]);
	assert.deepEqual(sharedSkillPaths(paths.slice(0, 2), dirs), []);
});

test("the nudge is on unless a deployment or a check turns it off", () => {
	assert.equal(nudgeEnabled({}), true);
	assert.equal(nudgeEnabled({ GAH_SKILLS_NUDGE: "1" }), true);
	assert.equal(nudgeEnabled({ GAH_SKILLS_NUDGE: "0" }), false);
	assert.equal(nudgeEnabled({ GAH_SKILLS_NUDGE: "false" }), false);
	assert.equal(nudgeEnabled({ GAH_ALLOW_NO_SKILLS: "1" }), false);
});

test("the no-skills note lifts 'ask when no skill fits', and mentions /setup-skills only with the nudge", () => {
	const on = noSharedSkillsNote(true);
	const off = noSharedSkillsNote(false);
	for (const n of [on, off]) assert.match(n, /help directly with general requests/);
	assert.match(on, /\/setup-skills/);
	assert.doesNotMatch(off, /\/setup-skills/);
});

test("launcher kind defaults to checkout", () => {
	assert.equal(launcherKind({}), "checkout");
	assert.equal(launcherKind({ GAH_LAUNCHER_KIND: "package" }), "package");
	assert.equal(launcherKind({ GAH_LAUNCHER_KIND: "host" }), "host");
	assert.equal(launcherKind({ GAH_LAUNCHER_KIND: "other" }), "checkout");
});
