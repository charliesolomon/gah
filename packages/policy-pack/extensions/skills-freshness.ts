/**
 * Skills freshness (#91). Two things a person learns without asking:
 *
 *   1. In-session: the shared skills checkout has moved on. The launcher only
 *      resets it at launch, so a running session keeps the old copy; a fix
 *      merged during the afternoon is invisible until they relaunch. Every
 *      GAH_SKILLS_POLL_MINUTES (default 10) the tracking ref is fetched and
 *      compared; when HEAD is behind, one line says so — once — above the
 *      editor, and the poll stops.
 *   2. At startup: the checkout differs from what this person last used.
 *      A short summary of the change (the repo's CHANGELOG.md when it keeps
 *      one, else the commit subjects under skills/, bin/, prompts/, setup/)
 *      is shown once; /skills-changelog shows all of it.
 *
 * "Last used" is recorded in settings.json (skillsSeen: root → sha) when the
 * person sends their first prompt — not when the summary is drawn — so an
 * administrator who launches under someone's account to test a skill and
 * quits at the prompt leaves the notice for its owner. A test launch that
 * does send prompts sets GAH_SKILLS_NO_MARK_SEEN=1 (gah-launch --no-mark-seen)
 * and never advances the marker; /skills-seen reset forgets it after the fact.
 *
 * Scope: every --skill path inside a git checkout, deduplicated to its root.
 * A path that is not a checkout is skipped, so a dev session with a plain
 * skills directory loads nothing here. The checkout is only ever read
 * (fetch touches remote refs, not the working tree); the launcher owns the
 * reset. Nothing is Grace-specific (#20).
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { appendFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { settingsPath } from "./lib/last-model.ts";
import {
	clearSeen,
	commitsBehind,
	currentBranch,
	fetchUpstream,
	headSha,
	markSeen,
	parsePollMinutes,
	readSeen,
	repoLabel,
	skillPathsFromArgv,
	skillRepos,
	summariseUpdate,
} from "./lib/skills-freshness.ts";

const WIDGET_KEY = "gah-skills-freshness";
const BEHIND_LINE = "Skill updates are available — /quit and relaunch to load them.";
const AUDIT_LOG_PATH = process.env.GAH_AUDIT_LOG ?? join(homedir(), ".gah", "audit.log");

/** Same file and line shape as policy.ts; a `skills` line makes "which version was
 * Zach running when it failed" answerable from the log alone. */
function audit(session: string | undefined, entry: Record<string, unknown>): void {
	try {
		mkdirSync(dirname(AUDIT_LOG_PATH), { recursive: true });
		appendFileSync(AUDIT_LOG_PATH, `${JSON.stringify({ ts: new Date().toISOString(), session, ...entry })}\n`);
	} catch {
		/* audit failure never breaks the session; policy.ts reports its own */
	}
}

export default function (pi: ExtensionAPI) {
	const repos = skillRepos(skillPathsFromArgv(process.argv));
	if (repos.length === 0) return;

	const markAllowed = process.env.GAH_SKILLS_NO_MARK_SEEN !== "1";
	const pollMs = parsePollMinutes(process.env.GAH_SKILLS_POLL_MINUTES) * 60_000;

	/** HEAD of each checkout as this process saw it at startup — what "seen" will mean. */
	const startHeads = new Map<string, string>();
	/** Full text of the startup summary, for /skills-changelog. */
	let changelog: string[] = [];
	let marked = false;
	let behindShown = false;
	let polling = false;
	let timer: ReturnType<typeof setInterval> | undefined;
	let uiCtx: ExtensionContext | undefined;

	function stopPolling(): void {
		if (timer) clearInterval(timer);
		timer = undefined;
	}

	async function poll(): Promise<void> {
		if (polling || behindShown) return;
		polling = true;
		try {
			for (const root of repos) {
				if (!(await fetchUpstream(root))) continue; // offline or untracked: no news
				const behind = commitsBehind(root);
				if (behind !== null && behind > 0) {
					behindShown = true;
					stopPolling();
					// A widget, not a chat line: it stays above the editor until relaunch
					// instead of scrolling away under the next reply.
					if (uiCtx?.hasUI) uiCtx.ui.setWidget(WIDGET_KEY, [uiCtx.ui.theme.fg("warning", BEHIND_LINE)]);
					audit(uiCtx?.sessionManager?.getSessionId(), { kind: "skills", reason: "behind", path: root, commits: behind });
					return;
				}
			}
		} finally {
			polling = false;
		}
	}

	pi.on("session_start", async (event, ctx) => {
		uiCtx = ctx;
		if (event.reason !== "startup") return; // /new, /resume, /fork: same process, same skills

		let session: string | undefined;
		try {
			session = ctx.sessionManager.getSessionId();
		} catch {
			session = undefined;
		}

		const seen = readSeen(settingsPath());
		const notice: string[] = [];
		changelog = [];
		const auditRepos: Record<string, unknown>[] = [];
		for (const root of repos) {
			const head = headSha(root);
			if (!head) continue;
			startHeads.set(root, head);
			auditRepos.push({ path: root, sha: head, branch: currentBranch(root) });
			const previous = seen[root];
			if (!previous || previous === head) continue;
			const summary = summariseUpdate(root, previous, head);
			if (summary.source === "none") continue;
			const title = `Your skills changed since you last used them (${repoLabel(root)}):`;
			notice.push(title, ...summary.lines);
			changelog.push(title, ...summary.full, "");
		}
		audit(session, { kind: "skills", reason: "loaded", repos: auditRepos });

		if (notice.length > 0 && ctx.hasUI) {
			ctx.ui.notify(notice.join("\n"), "info");
		}

		if (pollMs > 0) {
			timer = setInterval(() => void poll(), pollMs);
			timer.unref?.();
		}
	});

	// The person's first prompt is what "seen" means. Slash commands never reach
	// here, so an administrator who launches, looks, and quits leaves no trace.
	pi.on("before_agent_start", async () => {
		if (!marked && markAllowed && startHeads.size > 0) {
			marked = true;
			const marks: Record<string, string> = {};
			for (const [root, sha] of startHeads) marks[root] = sha;
			markSeen(settingsPath(), marks);
		}
		return undefined;
	});

	pi.on("session_shutdown", async () => stopPolling());

	pi.registerCommand("skills-changelog", {
		description: "What changed in the skills since you last used them, and whether updates are waiting",
		handler: async (_args, ctx) => {
			const lines = changelog.length > 0 ? [...changelog] : ["Skills are as you last saw them."];
			if (behindShown) lines.push(BEHIND_LINE);
			ctx.ui.notify(lines.join("\n").trim(), "info");
		},
	});

	pi.registerCommand("skills-seen", {
		description: "skills-seen reset — forget the skills-update marker so the next launch shows the summary again",
		handler: async (args, ctx) => {
			if (args.trim() !== "reset") {
				ctx.ui.notify("Usage: /skills-seen reset", "warning");
				return;
			}
			const ok = clearSeen(settingsPath());
			ctx.ui.notify(
				ok
					? "Skills-update marker cleared; the next launch will summarise everything since the checkout's previous state."
					: "Could not update settings.json (not valid JSON); nothing changed.",
				ok ? "info" : "error",
			);
		},
	});
}
