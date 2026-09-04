/**
 * GAH: append a line to the audit log from vendor code.
 *
 * The policy pack writes the same file from its extensions; this is for the
 * few enforcement points that live inside the binary (see 0014). Best effort:
 * an unwritable log must never turn a refusal into a crash.
 */

import { appendFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export function gahAudit(entry: Record<string, unknown>): void {
	const path = process.env.GAH_AUDIT_LOG ?? join(homedir(), ".gah", "audit.log");
	try {
		mkdirSync(dirname(path), { recursive: true });
		appendFileSync(path, `${JSON.stringify({ ts: new Date().toISOString(), ...entry })}\n`);
	} catch {
		// best effort
	}
}
