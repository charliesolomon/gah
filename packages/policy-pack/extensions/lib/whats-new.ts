/**
 * What's new (#117): the pieces behind whats-new.ts. Pure functions over a
 * notes file and settings.json, no pi imports, so test/whats-new.test.ts can
 * drive them directly.
 *
 * The notes are the deployment's, not upstream's: a Markdown file the
 * administrator keeps (GAH_WHATS_NEW; deploy/host/gah-launch points it at
 * /etc/gah/whats-new.md), one `## ` section per announcement, newest first.
 * A person is shown the sections they have not been told about yet; which
 * ones they have is recorded in settings.json as the section headings.
 */

import { existsSync, readFileSync } from "node:fs";
import { type ChangelogEntry, capLines, parseChangelog, readSettings, writeSettings } from "./skills-freshness.ts";

/** settings.json key: the `## ` headings this person has been told about. */
export const WHATS_NEW_SEEN_KEY = "whatsNewSeen";

/** Most headings kept in the marker; the oldest fall off. A long-lived file stays a short list. */
export const SEEN_LIMIT = 200;

/** The notes file's sections, or [] when there is no file or it cannot be read. */
export function readNotes(path: string | undefined): ChangelogEntry[] {
	if (!path || !existsSync(path)) return [];
	try {
		return parseChangelog(readFileSync(path, "utf-8").replace(/^﻿/, ""));
	} catch {
		return [];
	}
}

/** Headings already shown, or undefined when this person has never been marked. */
export function readNotesSeen(settingsPath: string): string[] | undefined {
	const raw = readSettings(settingsPath)?.[WHATS_NEW_SEEN_KEY];
	if (!Array.isArray(raw)) return undefined;
	return raw.filter((h): h is string => typeof h === "string");
}

/**
 * The sections to show at startup. Someone never marked sees only the newest:
 * a person new to the deployment, or everyone on the first launch after this
 * feature arrives, should hear the latest news, not the file's whole history.
 */
export function unseenNotes(entries: readonly ChangelogEntry[], seen: readonly string[] | undefined): ChangelogEntry[] {
	if (seen === undefined) return entries.slice(0, 1);
	const known = new Set(seen);
	return entries.filter((e) => !known.has(e.heading));
}

/**
 * Record every current heading as seen, keeping earlier marks for headings the
 * file no longer has (an entry removed and restored stays seen). Returns false
 * when settings.json could not be honoured; nothing is written then.
 */
export function markNotesSeen(settingsPath: string, entries: readonly ChangelogEntry[]): boolean {
	const settings = readSettings(settingsPath);
	if (settings === null) return false;
	const previous = readNotesSeen(settingsPath) ?? [];
	const headings = entries.map((e) => e.heading);
	if (headings.every((h) => previous.includes(h)) && previous.length > 0) return true;
	const merged = [...headings, ...previous.filter((h) => !headings.includes(h))].slice(0, SEEN_LIMIT);
	writeSettings(settingsPath, { ...settings, [WHATS_NEW_SEEN_KEY]: merged });
	return true;
}

/** Forget the marker: the next launch behaves as a first one (newest section only). */
export function clearNotesSeen(settingsPath: string): boolean {
	const settings = readSettings(settingsPath);
	if (settings === null) return false;
	if (!(WHATS_NEW_SEEN_KEY in settings)) return true;
	const { [WHATS_NEW_SEEN_KEY]: _dropped, ...rest } = settings;
	writeSettings(settingsPath, rest);
	return true;
}

/** Startup text for the unseen sections: each as written, capped so a long note cannot fill the screen. */
export function formatNotes(entries: readonly ChangelogEntry[], cap = 12): string | undefined {
	if (entries.length === 0) return undefined;
	const lines = entries.flatMap((e, i) => [...(i > 0 ? [""] : []), ...e.content.split("\n")]);
	const capped = capLines(lines, cap).map((l) => l.replace("(/skills-changelog)", "(/whats-new)"));
	return ["What's new", "", ...capped].join("\n");
}
