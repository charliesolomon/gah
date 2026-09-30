/**
 * What's new (#117). The deployment's own release notes, shown once at startup.
 *
 * Upstream's startup changelog is written for people who build on pi: new
 * providers, extension APIs, features GAH switches off. Patch 0003 cuts it to
 * one line with a link. What a person using a deployment needs to hear -- "the
 * default model is now Sonnet 5.5" -- is a fact about that deployment, so it
 * comes from a file its administrator keeps: GAH_WHATS_NEW, a Markdown file
 * with one `## ` section per announcement, newest first. deploy/host/gah-launch
 * points it at /etc/gah/whats-new.md when that file exists.
 *
 * Shown: the sections this person has not been told about (only the newest,
 * the first time). /whats-new shows every section.
 *
 * Seen is recorded in settings.json (whatsNewSeen) when the person sends their
 * first prompt, as skills-freshness does, so an administrator who launches
 * under someone's account and quits at the prompt leaves the notice for its
 * owner. A session without a UI (print mode) never records: nothing was shown.
 * gah-launch --no-mark-seen (GAH_SKILLS_NO_MARK_SEEN=1) never records;
 * /whats-new-seen reset forgets the marker after the fact.
 *
 * No file, no notes: nothing is shown and nothing is recorded.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { settingsPath } from "./lib/last-model.ts";
import { clearNotesSeen, formatNotes, markNotesSeen, readNotes, readNotesSeen, unseenNotes } from "./lib/whats-new.ts";

export default function (pi: ExtensionAPI) {
	const notesPath = process.env.GAH_WHATS_NEW?.trim() || undefined;
	const markAllowed = process.env.GAH_SKILLS_NO_MARK_SEEN !== "1";
	let marked = false;
	/** Set when this session could show the notice. A print-mode run (`gah -p`: check-live, a
	 * scripted job) has no UI, so its prompt must not count as the person having read it. */
	let interactive = false;

	pi.on("session_start", async (event, ctx) => {
		if (event.reason !== "startup" || !ctx.hasUI) return;
		interactive = true;
		const text = formatNotes(unseenNotes(readNotes(notesPath), readNotesSeen(settingsPath())));
		if (text) ctx.ui.notify(text, "info");
	});

	// The first prompt is what "seen" means; slash commands never reach here.
	pi.on("before_agent_start", async () => {
		if (!marked && markAllowed && interactive) {
			marked = true;
			const entries = readNotes(notesPath);
			if (entries.length > 0) markNotesSeen(settingsPath(), entries);
		}
		return undefined;
	});

	pi.registerCommand("whats-new", {
		description: "Show this deployment's release notes",
		handler: async (_args, ctx) => {
			const entries = readNotes(notesPath);
			ctx.ui.notify(
				entries.length > 0
					? `What's new\n\n${entries.map((e) => e.content).join("\n\n")}`
					: "No release notes for this deployment.",
				"info",
			);
		},
	});

	pi.registerCommand("whats-new-seen", {
		description: "whats-new-seen reset — forget the release-notes marker so the next launch shows the newest note again",
		handler: async (args, ctx) => {
			if (args.trim() !== "reset") {
				ctx.ui.notify("Usage: /whats-new-seen reset", "warning");
				return;
			}
			const ok = clearNotesSeen(settingsPath());
			ctx.ui.notify(
				ok
					? "Release-notes marker cleared; the next launch shows the newest note again."
					: "Could not update settings.json (not valid JSON); nothing changed.",
				ok ? "info" : "error",
			);
		},
	});
}
