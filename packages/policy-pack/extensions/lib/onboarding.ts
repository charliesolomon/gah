/**
 * Onboarding state shared by onboarding.ts and branding.ts (#135).
 *
 * gah starts without shared skills; these helpers decide whether a session has
 * any, and what the session should say when it does not. Setup skills -- the
 * ones that help a person connect their team's skills -- never count as
 * shared skills, or the nudge would hide itself.
 */

import { existsSync } from "node:fs";
import { delimiter, join, resolve, sep } from "node:path";

/** The line shown above the input box while no shared skills are loaded. */
export const NUDGE_LINE = "gah is better with your team's skills. Type /setup-skills to set them up.";

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
 */
export function noSharedSkillsNote(nudge: boolean): string {
	const lines = [
		"## This session has no shared skills",
		"",
		"No shared skills from the person's team are loaded yet, so the rule above about asking when no skill fits does not apply: help directly with general requests, using the tools you have.",
	];
	if (nudge) {
		lines.push(
			"When a request would clearly be better served by the team's own procedures, or the person asks what you can do, mention once that typing /setup-skills connects their team's skills. Do not repeat it in every answer.",
		);
	}
	return `${lines.join("\n")}\n`;
}

/** Which launcher started this session: a deployment package, a gah checkout, or the shared host. */
export type LauncherKind = "package" | "checkout" | "host";
export function launcherKind(env: NodeJS.ProcessEnv = process.env): LauncherKind {
	const k = env.GAH_LAUNCHER_KIND;
	return k === "package" || k === "host" ? k : "checkout";
}
