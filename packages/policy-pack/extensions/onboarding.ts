/**
 * Onboarding (#135): gah starts without shared skills, and helps finish setup
 * from inside the session.
 *
 *   - Setup skills load in every session: a deployment's own first, then the
 *     built-in ones (lib/onboarding.ts, setupSkillDirs). They are what
 *     /setup-skills runs, and they are available before GitLab works.
 *   - While no shared skills are loaded, one line above the input box says so:
 *     "gah is better with your team's skills. Type /setup-skills to set them up."
 *     branding.ts tells the model the same, and lifts SYSTEM.md's "ask when no
 *     skill fits" for that case.
 *   - /setup-skills starts the setup-skills skill. It decides the next step from
 *     facts, through the gah_setup tool:
 *       status        what is configured and what works -- never a secret's value;
 *       enter_gitlab_token, choose_gitlab_certificate
 *                     ask the PERSON in a dialog (the token is masked), store
 *                     the answer where the launcher looks, report the outcome;
 *       fetch_skills  fetch the shared skills now and reload, so they appear in
 *                     this same session.
 *     The model never sees a token: it asks for the dialog, the person types
 *     into it, and the tool returns only whether GitLab now accepts it.
 *
 * GitLab work is done by the package's own launcher (gah.ps1 / gah.sh,
 * `--gah-internal <op>`), which already knows the deployment's GitLab, proxy
 * and client certificate. A gah checkout and the shared host have no such
 * launcher; there the status says how skills are configured, and the setup
 * skill explains rather than acts.
 */

import { spawn } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Input, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { launcherKind, NUDGE_LINE, nudgeEnabled, setupSkillDirs, sharedSkillPaths } from "./lib/onboarding.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const POLICY_ROOT = join(HERE, "..");
const WIDGET_KEY = "gah-onboarding";
const RELOAD_COMMAND = "gah-reload-skills";

/** Names the launcher accepts in `--gah-internal store`; anything else is refused there too. */
const STORABLE = new Set(["GAH_GITLAB_TOKEN", "GAH_GITLAB_CERT_THUMBPRINT", "GAH_GITLAB_CLIENT_CERT", "GAH_GITLAB_CLIENT_KEY"]);

// --- The package launcher, as a helper ----------------------------------------

interface LauncherResult {
	ok: boolean;
	json?: Record<string, unknown>;
	error?: string;
}

/** Runs `<launcher> --gah-internal <op>`; the last stdout line is JSON. `input` goes to stdin, never argv. */
function runLauncher(op: string[], input?: string, timeoutMs = 120_000): Promise<LauncherResult> {
	const script = process.env.GAH_LAUNCHER_SCRIPT;
	if (!script || !existsSync(script)) return Promise.resolve({ ok: false, error: "no package launcher in this session" });
	const [cmd, args] =
		process.platform === "win32"
			? ["powershell.exe", ["-NoLogo", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script, "--gah-internal", ...op]]
			: ["bash", [script, "--gah-internal", ...op]];
	return new Promise((resolveP) => {
		const child = spawn(cmd, args, { stdio: ["pipe", "pipe", "pipe"], env: process.env, windowsHide: true });
		let out = "";
		let err = "";
		const timer = setTimeout(() => child.kill(), timeoutMs);
		child.stdout.on("data", (d) => (out += d));
		child.stderr.on("data", (d) => (err += d));
		child.on("error", (e) => {
			clearTimeout(timer);
			resolveP({ ok: false, error: e.message });
		});
		child.on("close", (code) => {
			clearTimeout(timer);
			const last = out.trim().split(/\r?\n/).pop() ?? "";
			try {
				const json = JSON.parse(last) as Record<string, unknown>;
				resolveP({ ok: code === 0 && json.ok !== false, json, error: typeof json.error === "string" ? json.error : undefined });
			} catch {
				resolveP({ ok: false, error: (err.trim() || out.trim() || `exit ${code}`).slice(-400) });
			}
		});
		child.stdin.end(input ?? "");
	});
}

// --- Status ---------------------------------------------------------------------

/** Skill paths on the command line (--skill <path>), as the launcher passed them. */
function argvSkillPaths(argv: readonly string[]): string[] {
	const out: string[] = [];
	for (let i = 0; i < argv.length - 1; i++) if (argv[i] === "--skill") out.push(argv[i + 1]!);
	return out;
}

function sharedSkillsLoaded(pi: ExtensionAPI): string[] {
	const dirs = setupSkillDirs(POLICY_ROOT);
	const paths = pi
		.getCommands()
		.filter((c) => c.source === "skill")
		.map((c) => c.sourceInfo?.path ?? "");
	return sharedSkillPaths(paths, dirs);
}

async function status(pi: ExtensionAPI): Promise<Record<string, unknown>> {
	const kind = launcherKind();
	const shared = sharedSkillsLoaded(pi);
	const base: Record<string, unknown> = {
		launcher: kind,
		platform: process.platform,
		sharedSkillsLoaded: shared.length,
		knowledgeBase: process.env.GAH_KB_DIR ? { configured: true, path: process.env.GAH_KB_DIR } : { configured: false },
	};
	if (kind === "package") {
		const r = await runLauncher(["status"], undefined, 60_000);
		return { ...base, ...(r.json ?? {}), ...(r.ok ? {} : { statusError: r.error }) };
	}
	if (kind === "host") {
		return {
			...base,
			note: "Shared host: the administrator configures skills in a root-owned manifest with a deploy key. The person cannot set this up; tell them to contact the administrator, with the failure the launcher printed.",
		};
	}
	const dir = process.env.GAH_SKILLS_DIR;
	return {
		...base,
		skillsDir: dir ? { path: dir, exists: existsSync(dir) } : null,
		skillPathsOnCommandLine: argvSkillPaths(process.argv).filter((p) => !setupSkillDirs(POLICY_ROOT).some((d) => p.startsWith(d))),
		note: "gah checkout: shared skills come from a local skills repository named by GAH_SKILLS_DIR (or --skill). `gah init <dir>` scaffolds one; clone the team's instead when it exists.",
	};
}

// --- Dialogs ----------------------------------------------------------------------

/** The TUI's own Input, drawn as dots. Same length, so the cursor stays where it is. */
class MaskedInput extends Input {
	override render(width: number): string[] {
		const self = this as unknown as { value: string };
		const real = self.value;
		self.value = "•".repeat(real.length);
		try {
			return super.render(width);
		} finally {
			self.value = real;
		}
	}
}

/** A masked one-line prompt. Resolves undefined on Escape or an empty answer. */
function askSecret(ctx: ExtensionContext, title: string, hint: string): Promise<string | undefined> {
	return ctx.ui.custom<string | undefined>((tui, theme, _kb, done) => {
		const input = new MaskedInput();
		input.focused = true;
		input.onSubmit = (v) => done(v.trim() || undefined);
		input.onEscape = () => done(undefined);
		const wrap = (text: string, width: number) => wrapTextWithAnsi(text, Math.max(1, width));
		return {
			render: (width: number) => [
				theme.fg("accent", "─".repeat(Math.max(1, width))),
				...wrap(theme.fg("accent", title), width),
				...wrap(theme.fg("muted", hint), width),
				"",
				...input.render(width),
				"",
				...wrap(theme.fg("dim", "Enter saves · Esc cancels · what you type is hidden and never enters the conversation"), width),
				theme.fg("accent", "─".repeat(Math.max(1, width))),
			],
			invalidate: () => input.invalidate(),
			handleInput: (data: string) => {
				input.handleInput(data);
				tui.requestRender();
			},
		};
	});
}

async function store(name: string, value: string): Promise<LauncherResult> {
	if (!STORABLE.has(name)) return { ok: false, error: `not a setting this tool stores: ${name}` };
	const r = await runLauncher(["store", name], value);
	// The launcher stores for future launches; this process needs it now, for the
	// status check and the skills fetch that follow.
	if (r.ok) process.env[name] = value;
	return r;
}

// --- The extension ----------------------------------------------------------------

export default function (pi: ExtensionAPI) {
	const nudge = nudgeEnabled();
	// Set by fetch_skills. The reload waits for the turn to end: reloading in the
	// middle of a tool call would tear the session down under the running turn.
	let reloadPending = false;
	pi.on("agent_end", async () => {
		if (!reloadPending) return;
		reloadPending = false;
		// Sent as a command (expandPromptTemplates), not as text for the model.
		setImmediate(() => pi.sendUserMessage(`/${RELOAD_COMMAND}`, { expandPromptTemplates: true }));
	});

	// Setup skills, and skills fetched earlier in this process (fetch_skills).
	// resources_discover runs at startup and on every /reload.
	pi.on("resources_discover", () => {
		const skillPaths = setupSkillDirs(POLICY_ROOT);
		const promptPaths: string[] = [];
		const fetched = process.env.GAH_SESSION_SKILLS_DIR;
		if (fetched && existsSync(join(fetched, "skills"))) {
			skillPaths.unshift(join(fetched, "skills"));
			if (existsSync(join(fetched, "prompts"))) promptPaths.push(join(fetched, "prompts"));
		}
		return { skillPaths, promptPaths };
	});

	function refreshNudge(ctx: ExtensionContext): void {
		if (!ctx.hasUI) return;
		const show = nudge && sharedSkillsLoaded(pi).length === 0;
		ctx.ui.setWidget(WIDGET_KEY, show ? [ctx.ui.theme.fg("accent", NUDGE_LINE)] : undefined);
	}
	pi.on("session_start", async (_event, ctx) => refreshNudge(ctx));
	// Setup skills arrive through resources_discover, after session_start; a
	// shared skill can only arrive the same way after fetch_skills. Recheck once
	// the first turn starts, which is cheap and always after both.
	pi.on("before_agent_start", async (_event, ctx) => {
		refreshNudge(ctx);
		return undefined;
	});

	pi.registerCommand("setup-skills", {
		description: "Connect your team's shared skills (and GitLab, if that is needed first)",
		handler: async (args, _ctx) => {
			pi.sendUserMessage(`/skill:setup-skills ${args ?? ""}`.trim(), { expandPromptTemplates: true });
		},
	});

	pi.registerCommand(RELOAD_COMMAND, {
		description: "Reload skills after gah_setup fetched them",
		handler: async (_args, ctx) => {
			await ctx.reload();
		},
	});

	pi.registerTool({
		name: "gah_setup",
		label: "gah setup",
		description:
			"Set up this gah installation's access to the team's shared skills. Actions: " +
			"status (what is configured and what works; never shows secret values), " +
			"enter_gitlab_token (opens a masked dialog where the PERSON types a GitLab token; you never see it), " +
			"choose_gitlab_certificate (the person picks the client certificate GitLab requires), " +
			"fetch_skills (download the shared skills now and reload them into this session). " +
			"Only for use by the setup-skills and setup-gitlab skills.",
		parameters: Type.Object({
			action: Type.Union([
				Type.Literal("status"),
				Type.Literal("enter_gitlab_token"),
				Type.Literal("choose_gitlab_certificate"),
				Type.Literal("fetch_skills"),
			]),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const text = (o: unknown) => ({ content: [{ type: "text" as const, text: typeof o === "string" ? o : JSON.stringify(o, null, 2) }], details: {} });
			const action = (params as { action: string }).action;
			const kind = launcherKind();

			if (action === "status") return text(await status(pi));

			if (kind !== "package") {
				return text(
					kind === "host"
						? "Not available on the shared host: the administrator manages skills and GitLab access there."
						: "Not available in a gah checkout: skills come from a local repository (GAH_SKILLS_DIR). See the status note.",
				);
			}

			if (action === "enter_gitlab_token" || action === "choose_gitlab_certificate") {
				if (!ctx.hasUI) return text("This needs the interactive terminal: the person must type the answer into a dialog.");
			}

			if (action === "enter_gitlab_token") {
				const token = await askSecret(
					ctx,
					"GitLab personal access token",
					"Paste your token below and press Enter. The read_api scope is enough.",
				);
				if (!token) return text({ stored: false, reason: "cancelled by the person" });
				const r = await store("GAH_GITLAB_TOKEN", token);
				if (!r.ok) return text({ stored: false, error: r.error });
				const s = await status(pi);
				return text({ stored: true, probes: (s as { probes?: unknown }).probes, gitlab: (s as { gitlab?: unknown }).gitlab });
			}

			if (action === "choose_gitlab_certificate") {
				if (process.platform === "win32") {
					const list = await runLauncher(["list-certs"]);
					const certs = (list.json?.certs ?? []) as { thumbprint: string; label: string }[];
					if (!list.ok || certs.length === 0) return text({ stored: false, error: list.error ?? "no usable client certificate in Cert:\\CurrentUser\\My" });
					const pick = await ctx.ui.select("Which certificate should gah present to GitLab?", certs.map((c) => c.label));
					const chosen = certs.find((c) => c.label === pick);
					if (!chosen) return text({ stored: false, reason: "cancelled by the person" });
					const r = await store("GAH_GITLAB_CERT_THUMBPRINT", chosen.thumbprint);
					return text(r.ok ? { stored: true, certificate: chosen.label } : { stored: false, error: r.error });
				}
				const cert = await ctx.ui.input("Client certificate file (PEM)", "the file git uses as http.sslCert, e.g. ~/certs/me.pem");
				if (!cert) return text({ stored: false, reason: "cancelled by the person" });
				const key = await ctx.ui.input("Private key file, if separate (Enter to skip)", "the file git uses as http.sslKey");
				const r1 = await store("GAH_GITLAB_CLIENT_CERT", cert.trim());
				if (!r1.ok) return text({ stored: false, error: r1.error });
				if (key?.trim()) {
					const r2 = await store("GAH_GITLAB_CLIENT_KEY", key.trim());
					if (!r2.ok) return text({ stored: false, error: r2.error });
				}
				return text({ stored: true, certificate: cert.trim(), key: key?.trim() || null });
			}

			if (action === "fetch_skills") {
				const r = await runLauncher(["sync-skills"]);
				const dir = typeof r.json?.path === "string" ? (r.json.path as string) : undefined;
				if (!r.ok || !dir) return text({ fetched: false, error: r.error ?? "the launcher did not report a skills folder" });
				const count = existsSync(join(dir, "skills"))
					? readdirSync(join(dir, "skills"), { withFileTypes: true }).filter((e) => e.isDirectory()).length
					: 0;
				if (count === 0) return text({ fetched: true, skills: 0, note: "The skills repository has no skills/ folder with skills in it; nothing to load." });
				process.env.GAH_SESSION_SKILLS_DIR = dir;
				reloadPending = true;
				return text({ fetched: true, skills: count, reloading: true, note: "The session reloads after this turn; the skills are then available." });
			}

			return text(`unknown action ${action}`);
		},
	});
}
