/**
 * GAH branding extension.
 *
 * Replaces the default system prompt with SYSTEM.md from this pack and
 * adds a small banner to the startup output identifying this as a GAH build.
 *
 * Branding strings that need to live inside the binary itself (e.g. the
 * `pi` executable name) are handled by patches/0001-branding.patch instead.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const HERE = dirname(fileURLToPath(import.meta.url));
const SYSTEM_MD_PATH = join(HERE, "..", "SYSTEM.md");

export default function (pi: ExtensionAPI) {
	// Override the system prompt at session start.
	pi.on("before_agent_start", async (_event, ctx) => {
		try {
			const systemMd = readFileSync(SYSTEM_MD_PATH, "utf-8");
			if (ctx.hasUI) ctx.ui.notify("GAH policy + system prompt loaded", "info");
			return { systemPrompt: systemMd };
		} catch (err) {
			process.stderr.write(`[gah-branding] failed to load SYSTEM.md: ${(err as Error).message}\n`);
			return undefined;
		}
	});
}
