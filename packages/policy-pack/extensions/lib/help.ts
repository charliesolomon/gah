/**
 * /help (#142): the pieces behind help.ts. Pure, no pi imports, so
 * test/help.test.ts can drive them directly.
 *
 * The rows are the --help page's own "This session" rows (gahSessionRows,
 * cli/gah-help.ts in patch 0002), handed in by help.ts, so the command and the
 * page cannot disagree about what a session may use. This only lays them out
 * for a person in a session: the values without the page's notes about
 * variables and flags, which nobody types here; a row naming something the
 * session does not have (an absent endpoints file) left out; then where to
 * look next.
 */

import type { LauncherKind } from "./onboarding.ts";

/** The fields of a gahSessionRows row that /help uses. */
export interface SessionRow {
	key: string;
	label: string;
	value: string;
	absent?: boolean;
}

/** The commands worth knowing first; `/` lists the rest with what each does. */
export const NEXT_COMMANDS: ReadonlyArray<readonly [string, string]> = [
	["/", "every command, with what it does"],
	["/hotkeys", "keyboard shortcuts"],
	["/whats-new", "this deployment's release notes"],
	["/skills-changelog", "what changed in the skills since you last used them"],
];

/** What /help shows: this session's rows, the next commands, and who can change the setup. */
export function formatSessionHelp(rows: readonly SessionRow[], options: { version: string; kind: LauncherKind }): string {
	const shown = rows.filter((r) => !r.absent);
	const width = Math.max(...shown.map((r) => r.label.length), ...NEXT_COMMANDS.map(([name]) => name.length)) + 2;
	const line = (name: string, text: string) => `  ${name.padEnd(width)}${text}`;
	return [
		`This session (gah ${options.version})`,
		...shown.map((r) => line(r.label, r.value)),
		"",
		"More",
		...NEXT_COMMANDS.map(([name, text]) => line(name, text)),
		"",
		options.kind === "host"
			? "Your administrator sets this session up; ask them to change it."
			: "In a terminal, gah --help shows the same rows and the command-line options.",
	].join("\n");
}
