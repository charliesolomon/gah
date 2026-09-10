/**
 * Remember the last model a person picked, so the next session starts with it
 * (#77). Upstream keeps the pick for the session and saves it as the default
 * only on Ctrl+S in /model; in a deployment the person is not expected to know
 * that. providers.ts calls rememberModel() on every model_select that came
 * from the person (not from a session restore).
 *
 * The record goes where upstream reads its own default at startup:
 * <agent dir>/settings.json, keys defaultProvider and defaultModel. Upstream's
 * writer merges only the fields it changed into the file, so this write
 * survives its saves, and its reader picks it up on the next launch. Every
 * other key in the file is preserved. Pure: fs only, testable without pi.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/** Upstream's agent dir: $GAH_CODING_AGENT_DIR, else ~/.gah/agent. */
export function agentDir(env: NodeJS.ProcessEnv = process.env, home: string = homedir()): string {
	const fromEnv = env.GAH_CODING_AGENT_DIR;
	if (fromEnv) return fromEnv.startsWith("~/") ? join(home, fromEnv.slice(2)) : fromEnv;
	return join(home, ".gah", "agent");
}

export function settingsPath(dir: string = agentDir()): string {
	return join(dir, "settings.json");
}

/**
 * Write defaultProvider/defaultModel into settings.json, keeping everything
 * else. Returns false (and leaves the file alone) when it exists but is not
 * JSON: a person's hand edit is not ours to overwrite.
 */
export function rememberModel(provider: string, modelId: string, path: string = settingsPath()): boolean {
	let current: Record<string, unknown> = {};
	if (existsSync(path)) {
		try {
			const parsed = JSON.parse(readFileSync(path, "utf-8").replace(/^﻿/, ""));
			if (parsed && typeof parsed === "object" && !Array.isArray(parsed))
				current = parsed as Record<string, unknown>;
			else return false;
		} catch {
			return false;
		}
	}
	if (current.defaultProvider === provider && current.defaultModel === modelId) return true;
	const next = { ...current, defaultProvider: provider, defaultModel: modelId };
	mkdirSync(dirname(path), { recursive: true });
	// Write-then-rename so a crash mid-write cannot leave a half file behind.
	const tmp = `${path}.${process.pid}.tmp`;
	writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, "utf-8");
	renameSync(tmp, path);
	return true;
}
