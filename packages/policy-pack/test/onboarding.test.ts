// Unit tests for lib/onboarding.ts (#135, #138). Run: make test-policy
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { test } from "node:test";
import {
	guidedSetupOffered,
	isUnder,
	launchedSharedSkills,
	launcherKind,
	noSharedSkillsNote,
	noSkillsPointer,
	nudgeEnabled,
	setupOffered,
	setupSkillDirs,
	setupSkillFolders,
	sharedSkillPaths,
	skillsUpdateFailure,
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

test("the no-skills note lifts 'ask when no skill fits', and points to /setup-skills or the administrator", () => {
	const setup = noSharedSkillsNote("setup");
	const admin = noSharedSkillsNote("admin");
	const none = noSharedSkillsNote(undefined);
	for (const n of [setup, admin, none]) assert.match(n, /help directly with general requests/);
	assert.match(setup, /\/setup-skills/);
	assert.match(admin, /administrator/);
	for (const n of [admin, none]) assert.doesNotMatch(n, /\/setup-skills/);
	// The shared host's wording names no forge (#138).
	assert.doesNotMatch(admin, /GitLab|GitHub/);
});

test("launcher kind defaults to checkout", () => {
	assert.equal(launcherKind({}), "checkout");
	assert.equal(launcherKind({ GAH_LAUNCHER_KIND: "package" }), "package");
	assert.equal(launcherKind({ GAH_LAUNCHER_KIND: "host" }), "host");
	assert.equal(launcherKind({ GAH_LAUNCHER_KIND: "other" }), "checkout");
});

/** A --skill folder with one skill in it. */
function skillFolder(root: string, name: string): string {
	const dir = join(root, name);
	mkdirSync(join(dir, "triage"), { recursive: true });
	writeFileSync(join(dir, "triage", "SKILL.md"), "---\nname: triage\ndescription: x\n---\n");
	return dir;
}

test("shared skills known at load: --skill folders that hold a skill, and fetched ones; setup folders never count", () => {
	const root = mkdtempSync(join(tmpdir(), "onb-"));
	try {
		const team = skillFolder(root, "team");
		const empty = join(root, "empty");
		mkdirSync(empty);
		const setup = skillFolder(root, "setup-skills");
		const argv = ["node", "cli.js", "--skill", empty, "--skill", join(root, "missing"), "--skill", setup];
		assert.deepEqual(launchedSharedSkills(argv, [setup], {}), []);
		assert.deepEqual(launchedSharedSkills([...argv, "--skill", team], [setup], {}), [team]);
		const fetched = join(root, "fetched");
		skillFolder(fetched, "skills");
		assert.deepEqual(launchedSharedSkills(argv, [setup], { GAH_SESSION_SKILLS_DIR: fetched }), [join(fetched, "skills")]);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("setup is offered only while it can help (#138)", () => {
	const root = mkdtempSync(join(tmpdir(), "onb-"));
	try {
		const team = skillFolder(root, "team");
		const none = ["node", "cli.js"];
		const loaded = ["node", "cli.js", "--skill", team];
		const pkg = { GAH_LAUNCHER_KIND: "package" };
		// A package: offered with no shared skills, gone once they load...
		assert.equal(setupOffered(none, [], pkg), true);
		assert.equal(guidedSetupOffered(none, [], pkg), true);
		assert.equal(setupOffered(loaded, [], pkg), false);
		// ...unless the launcher could not update them (an expired token).
		const failed = { ...pkg, GAH_SKILLS_UPDATE_FAILED: "error: 401" };
		assert.equal(skillsUpdateFailure(failed), "error: 401");
		assert.equal(skillsUpdateFailure({ GAH_SKILLS_UPDATE_FAILED: "  " }), undefined);
		assert.equal(setupOffered(loaded, [], failed), true);
		assert.equal(guidedSetupOffered(loaded, [], failed), true);
		// The deployment's switch wins.
		assert.equal(setupOffered(none, [], { ...failed, GAH_SETUP_SKILLS: "0" }), false);
		assert.equal(setupOffered(none, [], { ...pkg, GAH_SETUP_SKILLS: "false" }), false);
		// The shared host never offers setup, whatever happened.
		const host = { GAH_LAUNCHER_KIND: "host", GAH_SKILLS_UPDATE_FAILED: "clone failed" };
		assert.equal(setupOffered(none, [], host), false);
		// A checkout offers /setup-skills (a printed explanation), never guided setup.
		assert.equal(setupOffered(none, [], {}), true);
		assert.equal(guidedSetupOffered(none, [], {}), false);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("where a session with no shared skills points the person", () => {
	const none = ["node", "cli.js"];
	assert.equal(noSkillsPointer(none, [], { GAH_LAUNCHER_KIND: "package" }), "setup");
	assert.equal(noSkillsPointer(none, [], { GAH_LAUNCHER_KIND: "host" }), "admin");
	assert.equal(noSkillsPointer(none, [], { GAH_LAUNCHER_KIND: "package", GAH_SETUP_SKILLS: "0" }), undefined);
	assert.equal(noSkillsPointer(none, [], { GAH_LAUNCHER_KIND: "package", GAH_SKILLS_NUDGE: "0" }), undefined);
	assert.equal(noSkillsPointer(none, [], { GAH_LAUNCHER_KIND: "host", GAH_SKILLS_NUDGE: "0" }), undefined);
});

test("one setup skill folder per name: the deployment's replaces the built-in one", () => {
	const root = mkdtempSync(join(tmpdir(), "onb-"));
	try {
		const deploy = join(root, "deploy-setup-skills");
		const builtin = join(root, "setup-skills");
		for (const [d, n] of [[deploy, "setup-gitlab"], [builtin, "setup-gitlab"], [builtin, "setup-skills"]] as const) {
			mkdirSync(join(d, n), { recursive: true });
			writeFileSync(join(d, n, "SKILL.md"), "---\n---\n");
		}
		mkdirSync(join(builtin, "not-a-skill"));
		assert.deepEqual(setupSkillFolders([deploy, builtin, join(root, "missing")]), [
			join(deploy, "setup-gitlab"),
			join(builtin, "setup-skills"),
		]);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
