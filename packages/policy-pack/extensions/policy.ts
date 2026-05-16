/**
 * GAH policy extension.
 *
 * Enforces three things on every session:
 *   1. Tool allowlist — only tools listed in ALLOWED_TOOLS may run.
 *   2. Protected paths — write/edit operations to sensitive paths are blocked.
 *   3. Audit log — every tool call is appended to an audit file.
 *
 * This is the single file that defines our day-to-day risk posture. Edit it
 * to widen or tighten what the agent can do.
 */

import { appendFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// --- Policy knobs ------------------------------------------------------------

/** Tools the agent may call. Built-ins not in this list are blocked. */
const ALLOWED_TOOLS = new Set<string>(["read", "grep", "find", "ls", "edit", "write"]);
// Notably absent: "bash". Re-add it deliberately if a use case justifies it.

/** Write/edit operations targeting these paths are blocked outright. */
const PROTECTED_PATH_FRAGMENTS = [
	".env",
	".git/",
	"node_modules/",
	"/etc/",
	"~/.ssh/",
	"~/.aws/",
];

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

function isProtectedPath(path: string): boolean {
	const expanded = path.replace(/^~/, homedir());
	return PROTECTED_PATH_FRAGMENTS.some((frag) => {
		const expandedFrag = frag.replace(/^~/, homedir());
		return expanded.includes(expandedFrag);
	});
}

export default function (pi: ExtensionAPI) {
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

		// 3. Audit allowed calls
		audit({ kind: "allowed", tool: event.toolName, input: event.input });
		return undefined;
	});
}
