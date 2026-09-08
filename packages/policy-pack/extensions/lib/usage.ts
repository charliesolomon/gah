/**
 * Helpers for the usage-audit lines (issue #48). Pure functions, no PI imports,
 * so they unit-test with node:test.
 *
 * A usage report (the deployment's business, not gah's) reads ~/.gah/audit.log
 * and needs two things the log did not carry: what each turn cost, and which
 * prompt templates people press. Both are attributed by a session id added to
 * every line.
 */

/** The four token counts a report sums, plus the cost the provider reported. */
export interface TurnUsage {
	model: string;
	provider: string;
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	totalTokens: number;
	cost: number;
}

interface UsageLike {
	input?: number;
	output?: number;
	cacheRead?: number;
	cacheWrite?: number;
	totalTokens?: number;
	cost?: { total?: number };
}
interface AssistantLike {
	role?: string;
	model?: string;
	provider?: string;
	usage?: UsageLike;
}

/**
 * The usage figures from a turn's assistant message, or null when the turn
 * carried none (a user or tool-result message, or a message without usage).
 */
export function turnUsage(message: unknown): TurnUsage | null {
	const m = message as AssistantLike | null | undefined;
	if (!m || m.role !== "assistant" || !m.usage) return null;
	const u = m.usage;
	return {
		model: m.model ?? "",
		provider: m.provider ?? "",
		input: u.input ?? 0,
		output: u.output ?? 0,
		cacheRead: u.cacheRead ?? 0,
		cacheWrite: u.cacheWrite ?? 0,
		totalTokens: u.totalTokens ?? 0,
		cost: u.cost?.total ?? 0,
	};
}

/**
 * The prompt-template name in an input, or null.
 *
 * By the time the `input` event fires, built-in TUI commands (/model, /quit …)
 * and extension commands have already been handled and returned; what remains
 * with a leading "/" is a prompt template (`/morning`, `/brief 123`) or plain
 * text. Skill invocations (`/skill:name`) are excluded — they carry a colon and
 * are visible through the SKILL.md read in the tool audit.
 */
export function promptTemplateName(text: string): string | null {
	const m = /^\/([A-Za-z0-9][A-Za-z0-9_-]*)(\s|$)/.exec(text);
	return m ? m[1] : null;
}
