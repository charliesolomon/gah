/**
 * Onboarding state shared by onboarding.ts and branding.ts (#135).
 *
 * gah starts without shared skills; these helpers decide whether a session has
 * any, and what the session should say when it does not. Setup skills -- the
 * ones that help a person connect their team's skills -- never count as
 * shared skills, or the nudge would hide itself.
 */

import { existsSync, readdirSync, statSync } from "node:fs";
import { delimiter, join, resolve, sep } from "node:path";

/** The line shown above the input box while no shared skills are loaded. */
export const NUDGE_LINE = "gah is better with your team's skills. Type /setup-skills to set them up.";
/** ... while an older copy is loaded but the launcher could not update it. */
export const UPDATE_FAILED_LINE = "Your team's skills couldn't be updated. Type /setup-skills to see why and fix it.";
/** The shared host's lines: the person cannot fix either, the administrator can. */
export const HOST_NO_SKILLS_LINE = "Your team's skills didn't load. Tell your administrator.";
export const HOST_UPDATE_FAILED_LINE = "Your team's skills couldn't be updated. Tell your administrator.";

/**
 * Folders of setup skills, in load order. The first skill loaded with a name
 * wins, so a deployment's own setup skills come before the built-in ones:
 *   1. GAH_SETUP_SKILLS_DIR -- the shared host points this at a folder on the host;
 *   2. <policy>/deploy-setup-skills -- a deployment package's own (gah-deploy.json setupSkills);
 *   3. <policy>/setup-skills -- the built-in, generic set.
 * `policyRoot` is the policy pack in a checkout, or gah-policy/ in a package.
 */
export function setupSkillDirs(policyRoot: string, env: NodeJS.ProcessEnv = process.env): string[] {
	const fromEnv = (env.GAH_SETUP_SKILLS_DIR ?? "").split(delimiter).filter(Boolean);
	const dirs = [...fromEnv, join(policyRoot, "deploy-setup-skills"), join(policyRoot, "setup-skills")];
	return dirs.map((d) => resolve(d)).filter((d) => existsSync(d));
}

/**
 * The setup skill folders to load: one per name, the first in `dirs` order.
 * Handing pi whole folders would make a deployment's replacement collide with
 * the built-in skill of the same name, and pi prints every collision at startup.
 */
export function setupSkillFolders(dirs: string[]): string[] {
	const seen = new Set<string>();
	const out: string[] = [];
	for (const d of dirs) {
		let entries: string[] = [];
		try {
			entries = readdirSync(d, { withFileTypes: true })
				.filter((e) => e.isDirectory() && existsSync(join(d, e.name, "SKILL.md")))
				.map((e) => e.name)
				.sort();
		} catch {
			continue;
		}
		for (const name of entries) {
			if (seen.has(name)) continue;
			seen.add(name);
			out.push(join(d, name));
		}
	}
	return out;
}

/** True when `file` lies inside one of `dirs`. */
export function isUnder(file: string, dirs: string[]): boolean {
	const f = resolve(file);
	return dirs.some((d) => f === d || f.startsWith(d.endsWith(sep) ? d : d + sep));
}

/** Skills in `paths` that are not setup skills -- the team's, a knowledge base's, a person's own. */
export function sharedSkillPaths(paths: string[], setupDirs: string[]): string[] {
	return paths.filter((p) => p && !isUnder(p, setupDirs));
}

/**
 * Whether the nudge is shown. Off when a deployment never uses shared skills
 * (GAH_SKILLS_NUDGE=0, set from gah-deploy.json skillsNudge: false), and for
 * checks and CI, which start deliberately without skills (GAH_ALLOW_NO_SKILLS).
 */
export function nudgeEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
	if (env.GAH_SKILLS_NUDGE === "0" || env.GAH_SKILLS_NUDGE === "false") return false;
	if (env.GAH_ALLOW_NO_SKILLS) return false;
	return true;
}

/**
 * Appended to the system prompt when no shared skills are loaded. SYSTEM.md
 * tells the model to ask rather than improvise when no skill fits; with no
 * skills at all that would make it decline ordinary work, which is what the
 * old refusal to start existed to prevent. This overrides that one rule.
 * `pointer` says where to send the person: /setup-skills where it exists, the
 * administrator on the shared host, nowhere when the nudge is off.
 */
export function noSharedSkillsNote(pointer: "setup" | "admin" | undefined): string {
	const lines = [
		"## This session has no shared skills",
		"",
		"No shared skills from the person's team are loaded yet, so the rule above about asking when no skill fits does not apply: help directly with general requests, using the tools you have.",
	];
	if (pointer === "setup") {
		lines.push(
			"When a request would clearly be better served by the team's own procedures, or the person asks what you can do, mention once that typing /setup-skills connects their team's skills. Do not repeat it in every answer.",
		);
	} else if (pointer === "admin") {
		lines.push(
			"The team's skills are set up by the administrator of this machine, and the person cannot change that. If they ask about the missing skills, say once that their administrator can fix it. Do not describe how skills are stored or fetched.",
		);
	}
	return `${lines.join("\n")}\n`;
}

/** Where a session with no shared skills should point the person (see noSharedSkillsNote). */
export function noSkillsPointer(argv: readonly string[], setupDirs: string[], env: NodeJS.ProcessEnv = process.env): "setup" | "admin" | undefined {
	if (!nudgeEnabled(env)) return undefined;
	if (launcherKind(env) === "host") return "admin";
	return setupOffered(argv, setupDirs, env) ? "setup" : undefined;
}

/** Which launcher started this session: a deployment package, a gah checkout, or the shared host. */
export type LauncherKind = "package" | "checkout" | "host";
export function launcherKind(env: NodeJS.ProcessEnv = process.env): LauncherKind {
	const k = env.GAH_LAUNCHER_KIND;
	return k === "package" || k === "host" ? k : "checkout";
}

/**
 * Why the launcher could not update the shared skills this launch, or
 * undefined when it could (or did not try). The package launchers and the
 * shared host set GAH_SKILLS_UPDATE_FAILED; fetch_skills clears it.
 */
export function skillsUpdateFailure(env: NodeJS.ProcessEnv = process.env): string | undefined {
	const v = env.GAH_SKILLS_UPDATE_FAILED?.trim();
	return v ? v : undefined;
}

/** True when `path` (a --skill argument) holds at least one skill. */
function holdsSkills(path: string): boolean {
	try {
		if (!existsSync(path)) return false;
		if (statSync(path).isFile()) return path.endsWith(".md");
		if (existsSync(join(path, "SKILL.md"))) return true;
		return readdirSync(path, { withFileTypes: true }).some((e) => e.isDirectory() && existsSync(join(path, e.name, "SKILL.md")));
	} catch {
		return false;
	}
}

/**
 * Shared skill folders known before pi resolves skills: the --skill paths the
 * launcher passed, and the folder fetch_skills added in this process. Setup
 * visibility has to be decided this early, while extensions load, because what
 * is not registered then is not in the slash menu.
 */
export function launchedSharedSkills(argv: readonly string[], setupDirs: string[], env: NodeJS.ProcessEnv = process.env): string[] {
	const paths: string[] = [];
	for (let i = 0; i < argv.length - 1; i++) if (argv[i] === "--skill") paths.push(argv[i + 1]!);
	if (env.GAH_SESSION_SKILLS_DIR) paths.push(join(env.GAH_SESSION_SKILLS_DIR, "skills"));
	return sharedSkillPaths(paths, setupDirs).filter(holdsSkills);
}

/** A deployment that never onboards in-session (gah-deploy.json setupSkills: false). */
export function setupSwitchedOff(env: NodeJS.ProcessEnv = process.env): boolean {
	return env.GAH_SETUP_SKILLS === "0" || env.GAH_SETUP_SKILLS === "false";
}

/**
 * Whether this session offers setup at all (#138). Setup is there only while it
 * can help, and is otherwise not registered -- no setup skills, no /setup-skills,
 * no gah_setup tool -- so it is neither in the system prompt nor in the slash
 * menu:
 *   - never on the shared host, where the administrator sets accounts up;
 *   - never when the deployment switched it off;
 *   - otherwise while no shared skills are loaded, or while the launcher could
 *     not update them (an expired token, with an older copy still loaded).
 * Decided when the extension loads, which pi repeats on every reload.
 */
export function setupOffered(argv: readonly string[], setupDirs: string[], env: NodeJS.ProcessEnv = process.env): boolean {
	if (launcherKind(env) === "host") return false;
	if (setupSwitchedOff(env)) return false;
	if (skillsUpdateFailure(env)) return true;
	return launchedSharedSkills(argv, setupDirs, env).length === 0;
}

/** Whether the model-driven setup (setup skills, gah_setup) is offered: packages only. */
export function guidedSetupOffered(argv: readonly string[], setupDirs: string[], env: NodeJS.ProcessEnv = process.env): boolean {
	return launcherKind(env) === "package" && setupOffered(argv, setupDirs, env);
}
