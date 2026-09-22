/**
 * GAH branding extension.
 *
 * Replaces the default system prompt with SYSTEM.md from this pack and
 * adds a small banner to the startup output identifying this as a GAH build.
 *
 * IMPORTANT: `before_agent_start` returning `systemPrompt` REPLACES the
 * assembled prompt wholesale. Since pi 0.87 that is done by projection rather
 * than assignment (agent-session.ts, _installAgentForcedPromptProjection: the
 * transcript keeps its structured system messages and the request is rendered
 * with the forced text as its single head), but the effect on what the model
 * sees is the same. Pi appends the <available_skills> catalogue to the prompt it
 * builds, so returning SYSTEM.md alone silently discards it and the model is
 * never told which skills exist -- they become reachable only if the user types
 * /skill:<name> by hand. We therefore re-append that catalogue here, from the
 * skills pi already resolved and handed us on the event.
 *
 * The date is appended here too (lib/today.ts). The harness supplies the working
 * directory and never the day, so a model asked to record one falls back on its
 * training prior; it is appended rather than templated into SYSTEM.md so that a
 * deployment shipping its own SYSTEM.md still gets it.
 *
 * Branding strings that need to live inside the binary itself (e.g. the
 * `pi` executable name) are handled by patches/0001-branding.patch instead.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { formatSkillsForPrompt, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { todayLine } from "./lib/today.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const SYSTEM_MD_PATH = join(HERE, "..", "SYSTEM.md");

// Keep in sync with policy.ts: the prompt must describe the allowlist policy
// actually enforces. A static prompt claiming "no bash" while GAH_ALLOW_TOOLS
// grants it makes the model refuse work it is allowed to do.
const DEFAULT_ALLOWED_TOOLS = ["read", "grep", "find", "ls", "edit", "write"];
const EXTRA_ALLOWED_TOOLS = (process.env.GAH_ALLOW_TOOLS ?? "")
	.split(",")
	.map((t) => t.trim())
	.filter(Boolean);
const ALLOWED_TOOLS = [...DEFAULT_ALLOWED_TOOLS, ...EXTRA_ALLOWED_TOOLS];

export default function (pi: ExtensionAPI) {
	// Override the system prompt at session start.
	pi.on("before_agent_start", async (event, ctx) => {
		try {
			const systemMd = readFileSync(SYSTEM_MD_PATH, "utf-8").replaceAll(
				"{{ALLOWED_TOOLS}}",
				ALLOWED_TOOLS.map((t) => `\`${t}\``).join(", "),
			);

			// Re-attach the skills pi resolved, in pi's own format. Without this
			// the model cannot autonomously choose a skill (see note above).
			const skills = event.systemPromptOptions?.skills ?? [];
			const skillsBlock = skills.length > 0 ? formatSkillsForPrompt(skills) : "";

			if (ctx.hasUI) {
				const n = skills.length;
				ctx.ui.notify(
					`GAH policy + system prompt loaded (${n} skill${n === 1 ? "" : "s"})`,
					"info",
				);
			}
			return { systemPrompt: `${systemMd}\n\n${todayLine()}${skillsBlock}` };
		} catch (err) {
			process.stderr.write(`[gah-branding] failed to load SYSTEM.md: ${(err as Error).message}\n`);
			return undefined;
		}
	});
}
