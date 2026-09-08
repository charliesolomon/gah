/**
 * Date-based rotation for the audit log (issue #62). Self-managed: the log is
 * user-owned and written by the agent, so the agent rolls and prunes it — one
 * mechanism for the shared host, the Windows package, and dev, with no root
 * logrotate to install. Granularity is per session start: a session that spans
 * midnight keeps writing to one file, and each line's own `ts` carries the true
 * time regardless.
 *
 * Pure planning here (no fs), so it unit-tests; policy.ts does the rename/unlink.
 */

/** Local-time YYYY-MM-DD for a Date. */
export function ymd(d: Date): string {
	const y = d.getFullYear();
	const m = String(d.getMonth() + 1).padStart(2, "0");
	const day = String(d.getDate()).padStart(2, "0");
	return `${y}-${m}-${day}`;
}

/** "…/audit.log" + "2026-09-08" -> "…/audit-2026-09-08.log". */
export function datedPath(base: string, date: string): string {
	const slash = Math.max(base.lastIndexOf("/"), base.lastIndexOf("\\"));
	const dir = base.slice(0, slash + 1);
	const file = base.slice(slash + 1);
	const dot = file.lastIndexOf(".");
	const stem = dot > 0 ? file.slice(0, dot) : file;
	const ext = dot > 0 ? file.slice(dot) : "";
	return `${dir}${stem}-${date}${ext}`;
}

/** The regex that matches this base's rolled files and captures the date. */
export function datedPattern(base: string): RegExp {
	const slash = Math.max(base.lastIndexOf("/"), base.lastIndexOf("\\"));
	const file = base.slice(slash + 1);
	const dot = file.lastIndexOf(".");
	const stem = dot > 0 ? file.slice(0, dot) : file;
	const ext = dot > 0 ? file.slice(dot) : "";
	const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	return new RegExp(`^${esc(stem)}-(\\d{4}-\\d{2}-\\d{2})${esc(ext)}$`);
}

/** Days between two YYYY-MM-DD dates (a - b), by UTC midnight to avoid DST drift. */
export function daysBetween(a: string, b: string): number {
	const [ay, am, ad] = a.split("-").map(Number);
	const [by, bm, bd] = b.split("-").map(Number);
	return Math.round((Date.UTC(ay, am - 1, ad) - Date.UTC(by, bm - 1, bd)) / 86400000);
}

export interface RotationPlan {
	/** Date to rename the current log to (its content predates today), or null. */
	rollToDate: string | null;
	/** Dated files (by their date string) to delete as beyond retention. */
	pruneDates: string[];
}

/**
 * What to rotate, given the current log's last-modified date, the dates of the
 * already-rolled files, today, and retention. `retentionDays <= 0` keeps
 * everything (pruning disabled). A file dated D is pruned when it is strictly
 * older than retentionDays before today; the freshly rolled file is included in
 * that test so a stale current log left untouched for months is not resurrected.
 */
export function rotationPlan(opts: {
	currentDate: string | null;
	today: string;
	existingDates: string[];
	retentionDays: number;
}): RotationPlan {
	const { currentDate, today, existingDates, retentionDays } = opts;
	const rollToDate = currentDate && currentDate !== today ? currentDate : null;
	const candidates = new Set(existingDates);
	if (rollToDate) candidates.add(rollToDate);
	const pruneDates =
		retentionDays > 0
			? [...candidates].filter((d) => daysBetween(today, d) > retentionDays).sort()
			: [];
	return { rollToDate, pruneDates };
}

/** Parse GAH_AUDIT_RETENTION_DAYS; default 30, `<=0` or invalid handled by caller. */
export function parseRetentionDays(raw: string | undefined, fallback = 30): number {
	if (raw === undefined || raw.trim() === "") return fallback;
	const n = Number(raw);
	return Number.isFinite(n) ? Math.trunc(n) : fallback;
}
