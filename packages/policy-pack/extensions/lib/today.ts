/**
 * The date, for the system prompt.
 *
 * The harness tells the model its working directory, its tools and its skills,
 * and never what day it is. So a model asked to write a date has nothing to go
 * on but its training prior, and writes one that is months or years stale --
 * observed in a knowledge base article stamped 2025-08-13 during a session on
 * 2026-09-16, which then read as overdue for review the day it was written.
 *
 * Nothing downstream can catch that: a wrong date is a plausible date. Supplying
 * it costs one line of prompt and removes the guess entirely, for every skill
 * that records when something was true -- articles, ticket replies, reports.
 *
 * Local time, not UTC: the wrapper scripts a skill calls use `date +%F` and
 * `Get-Date`, which are local, and a model whose date disagrees with its own
 * tools by a day is worse than one that is simply told.
 */

/** YYYY-MM-DD in the machine's own timezone. */
export function localDate(now: Date = new Date()): string {
	const year = now.getFullYear();
	const month = String(now.getMonth() + 1).padStart(2, "0");
	const day = String(now.getDate()).padStart(2, "0");
	return `${year}-${month}-${day}`;
}

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/**
 * The line appended to the system prompt. The weekday earns its place: "what
 * closed last week", "is this due today" and "the Friday change window" are
 * ordinary requests, and a model counting back from a bare date gets them wrong.
 */
export function todayLine(now: Date = new Date()): string {
	return `Today's date is ${localDate(now)} (${WEEKDAYS[now.getDay()]}). Use it whenever you record or reason about a date; never infer today's date from memory.`;
}
