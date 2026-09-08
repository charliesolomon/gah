/**
 * GAH policy extension.
 *
 * Enforces four things on every session:
 *   1. Tool allowlist — only tools listed in ALLOWED_TOOLS may run.
 *   2. Protected paths — write/edit operations to sensitive paths are blocked.
 *   3. Secret files (GAH_SECRET_FILES) — the model may neither read them by
 *      any tool nor see their values in any tool result (lib/secrets.ts).
 *   4. Audit log — every tool call is appended to an audit file.
 *
 * This is the single file that defines our day-to-day risk posture. Edit it
 * to widen or tighten what the agent can do.
 */

import { appendFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	commandReferencesSecret,
	describePatterns,
	isSecretPath,
	loadSecretValues,
	parseSecretGlobs,
	redactText,
	resolveSecretFiles,
	type SecretValue,
} from "./lib/secrets.ts";

// --- Policy knobs ------------------------------------------------------------

/** Tools the agent may call. Built-ins not in this list are blocked. */
const DEFAULT_ALLOWED_TOOLS = ["read", "grep", "find", "ls", "edit", "write"];
// Notably absent: the shells -- "bash", and "powershell" on Windows.
// Deployments opt in via GAH_ALLOW_TOOLS — a comma-separated list of extra
// tools set by a root-owned launcher (see deploy/host/gah-launch), never by
// end users. Widenings are audit-logged.
// Keep in sync with branding.ts, which renders this same list into the
// system prompt ({{ALLOWED_TOOLS}} in SYSTEM.md).
const EXTRA_ALLOWED_TOOLS = (process.env.GAH_ALLOW_TOOLS ?? "")
	.split(",")
	.map((t) => t.trim())
	.filter(Boolean);
const ALLOWED_TOOLS = new Set<string>([...DEFAULT_ALLOWED_TOOLS, ...EXTRA_ALLOWED_TOOLS]);
// The binary's --help page reports the tools this policy actually enforces.
// Extensions load before help prints, so this single source reaches it.
process.env.GAH_EFFECTIVE_TOOLS = [...ALLOWED_TOOLS].join(",");

/** Write/edit operations targeting these paths are blocked outright. */
const PROTECTED_PATH_FRAGMENTS = [
	".env",
	".git/",
	"node_modules/",
	"/etc/",
	"~/.ssh/",
	"~/.aws/",
];

/**
 * Files the model must never see: path globs in GAH_SECRET_FILES, separated
 * by the PATH delimiter. Unset = none. See lib/secrets.ts for the three layers.
 */
const SECRET_PATTERNS = parseSecretGlobs(process.env.GAH_SECRET_FILES);
const SHELL_TOOLS = new Set(["bash", "powershell"]);

/** Where to append the audit log. Override with GAH_AUDIT_LOG. */
const AUDIT_LOG_PATH = process.env.GAH_AUDIT_LOG ?? join(homedir(), ".gah", "audit.log");

// --- Implementation ----------------------------------------------------------

function audit(entry: Record<string, unknown>): void {
	try {
		mkdirSync(dirname(AUDIT_LOG_PATH), { recursive: true });
		appendFileSync(AUDIT_LOG_PATH, JSON.stringify({ ts: new Date().toISOString(), ...entry }) + "\n");
	} catch {
		// Audit failure must not break the agent. Surface via stderr only.
		process.stderr.write(`[gah-policy] audit write failed: ${AUDIT_LOG_PATH}\n`);
	}
}

/** Normalize to forward slashes so fragment matching works on Windows paths. */
function normalize(path: string): string {
	return path.replace(/^~/, homedir()).replaceAll("\\", "/");
}

function isProtectedPath(path: string): boolean {
	const expanded = normalize(path);
	return PROTECTED_PATH_FRAGMENTS.some((frag) => expanded.includes(normalize(frag)));
}

/** Resolved lazily: setup steps may create a secret file just before launch. */
let secretFiles: string[] | null = null;
let secretValues: SecretValue[] | null = null;
function secrets(): { files: string[]; values: SecretValue[] } {
	if (secretFiles === null || secretValues === null) {
		secretFiles = resolveSecretFiles(SECRET_PATTERNS);
		secretValues = loadSecretValues(secretFiles);
	}
	return { files: secretFiles, values: secretValues };
}

function secretMessage(ref: string): string {
	return (
		`"${ref}" is a secret store (GAH_SECRET_FILES: ${describePatterns(SECRET_PATTERNS)}). ` +
		"The assistant may not read, print, copy or write it. The tools and scripts that need those " +
		"credentials read the file themselves; call them instead, and if one is failing report the error it prints."
	);
}

export default function (pi: ExtensionAPI) {
	if (EXTRA_ALLOWED_TOOLS.length > 0) {
		audit({ kind: "policy", reason: "allowlist_widened", tools: EXTRA_ALLOWED_TOOLS });
	}

	// 0. The tools the model is OFFERED are the tools the policy allows.
	//
	// Upstream activates only read, bash, edit and write by default; grep, find
	// and ls are registered but off. Without this, the model was offered bash
	// (which the hook below then blocks) and never offered ls (which it would
	// allow) -- so it reached for the one listing tool it could see and hit the
	// policy wall (#35). A tool the model cannot see is one it never tries.
	// Set at session start, after every tool is registered; unknown names are
	// ignored by the harness, so a name in the allowlist that this platform
	// does not have (bash on Windows) is harmless.
	pi.on("session_start", async () => {
		const registered = new Set(pi.getAllTools().map((tool) => tool.name));
		const active = [...ALLOWED_TOOLS].filter((name) => registered.has(name));
		pi.setActiveTools(active);
		audit({ kind: "policy", reason: "active_tools", tools: active });
		if (SECRET_PATTERNS.length > 0) {
			const { files, values } = secrets();
			audit({ kind: "policy", reason: "secret_files", patterns: SECRET_PATTERNS, files: files.length, values: values.length });
		}
	});

	// The `!command` / `!!command` editor prefix runs a shell as the USER, not
	// as a model tool call, so the allowlist below never sees it -- and on a
	// shared host that is a raw shell hand-out the deployment promised not to
	// make (#35). Same rule as the tools: a shell is available only when the
	// deployment allowed one. Returning a result replaces execution entirely.
	pi.on("user_bash", async (event) => {
		const shellAllowed = ALLOWED_TOOLS.has("bash") || ALLOWED_TOOLS.has("powershell");
		if (shellAllowed) {
			audit({ kind: "allowed", tool: "user_bash", command: event.command });
			return undefined;
		}
		audit({ kind: "blocked", reason: "shell_escape", command: event.command });
		return {
			result: {
				output: "Shell commands are disabled by GAH policy in this deployment (no bash/powershell in GAH_ALLOW_TOOLS).",
				exitCode: 1,
				cancelled: false,
				truncated: false,
			},
		};
	});

	pi.on("tool_call", async (event, _ctx) => {
		// 1. Allowlist
		if (!ALLOWED_TOOLS.has(event.toolName)) {
			audit({ kind: "blocked", reason: "not_allowlisted", tool: event.toolName });
			return { block: true, reason: `Tool "${event.toolName}" is not in the GAH allowlist.` };
		}

		// 2. Protected paths (write/edit only)
		if (event.toolName === "write" || event.toolName === "edit") {
			const path = (event.input as { path?: string }).path;
			if (path && isProtectedPath(path)) {
				audit({ kind: "blocked", reason: "protected_path", tool: event.toolName, path });
				return { block: true, reason: `Path "${path}" is protected by GAH policy.` };
			}
		}

		// 3. Secret files: no tool may read or write one, and a shell command may
		//    not name one. The values are redacted from results below regardless.
		if (SECRET_PATTERNS.length > 0) {
			const cwd = process.cwd();
			const path = (event.input as { path?: string }).path;
			if (typeof path === "string" && isSecretPath(path, SECRET_PATTERNS, cwd)) {
				audit({ kind: "blocked", reason: "secret_file", tool: event.toolName, path });
				return { block: true, reason: secretMessage(path) };
			}
			if (SHELL_TOOLS.has(event.toolName)) {
				const command = (event.input as { command?: string }).command ?? "";
				const ref = commandReferencesSecret(command, SECRET_PATTERNS, secrets().files, process.env, cwd);
				if (ref !== null) {
					audit({ kind: "blocked", reason: "secret_file", tool: event.toolName, path: ref });
					return { block: true, reason: secretMessage(ref) };
				}
			}
		}

		// 4. Audit allowed calls
		audit({ kind: "allowed", tool: event.toolName, input: event.input });
		return undefined;
	});

	// Secret values never reach the model or the transcript, whatever produced
	// them: a cat, a script that echoed too much, a stack trace. Text content
	// only; images are left alone.
	pi.on("tool_result", async (event) => {
		if (SECRET_PATTERNS.length === 0) return undefined;
		const { values } = secrets();
		if (values.length === 0) return undefined;
		const hits: { file: string; key: string; count: number }[] = [];
		const content = event.content.map((part) => {
			if (part.type !== "text") return part;
			const r = redactText(part.text, values);
			hits.push(...r.hits);
			return r.hits.length > 0 ? { ...part, text: r.text } : part;
		});
		if (hits.length === 0) return undefined;
		audit({ kind: "redacted", tool: (event as { toolName?: string }).toolName, hits });
		return { content };
	});
}
