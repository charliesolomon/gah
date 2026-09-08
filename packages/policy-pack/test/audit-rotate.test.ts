// Unit tests for extensions/lib/audit-rotate.ts. Run: make test-policy
import assert from "node:assert/strict";
import { test } from "node:test";
import { datedPath, datedPattern, daysBetween, parseRetentionDays, rotationPlan, ymd } from "../extensions/lib/audit-rotate.ts";

test("ymd formats local date", () => {
	assert.equal(ymd(new Date(2026, 8, 8, 23, 59)), "2026-09-08");
	assert.equal(ymd(new Date(2026, 0, 1, 0, 0)), "2026-01-01");
});

test("datedPath inserts the date before the extension, on both separators", () => {
	assert.equal(datedPath("/h/.gah/audit.log", "2026-09-08"), "/h/.gah/audit-2026-09-08.log");
	assert.equal(datedPath("C:\\Users\\x\\.gah\\audit.log", "2026-09-08"), "C:\\Users\\x\\.gah\\audit-2026-09-08.log");
	assert.equal(datedPath("audit.log", "2026-09-08"), "audit-2026-09-08.log");
});

test("datedPattern matches only this base's rolled files", () => {
	const re = datedPattern("audit.log");
	assert.equal("audit-2026-09-08.log".match(re)?.[1], "2026-09-08");
	assert.equal(re.test("audit.log"), false, "the live file is not a rolled file");
	assert.equal(re.test("audit-2026-09-08.log.bak"), false);
	assert.equal(re.test("other-2026-09-08.log"), false);
});

test("daysBetween counts calendar days across a month and DST boundaries", () => {
	assert.equal(daysBetween("2026-09-08", "2026-09-01"), 7);
	assert.equal(daysBetween("2026-03-09", "2026-03-08"), 1, "US spring-forward day");
	assert.equal(daysBetween("2026-01-01", "2025-12-31"), 1);
});

test("rotationPlan rolls yesterday's log and keeps today's", () => {
	assert.deepEqual(
		rotationPlan({ currentDate: "2026-09-07", today: "2026-09-08", existingDates: [], retentionDays: 30 }),
		{ rollToDate: "2026-09-07", pruneDates: [] },
	);
	assert.deepEqual(
		rotationPlan({ currentDate: "2026-09-08", today: "2026-09-08", existingDates: [], retentionDays: 30 }),
		{ rollToDate: null, pruneDates: [] },
	);
	assert.deepEqual(
		rotationPlan({ currentDate: null, today: "2026-09-08", existingDates: [], retentionDays: 30 }),
		{ rollToDate: null, pruneDates: [] },
	);
});

test("rotationPlan prunes files older than retention, including the one just rolled", () => {
	const p = rotationPlan({
		currentDate: "2026-07-01", // 69 days old -> rolled then pruned
		today: "2026-09-08",
		existingDates: ["2026-09-06", "2026-08-09", "2026-08-08", "2026-06-01"],
		retentionDays: 30,
	});
	assert.equal(p.rollToDate, "2026-07-01");
	// today-30 = 2026-08-09; strictly older than 30 days = before 2026-08-09
	assert.deepEqual(p.pruneDates, ["2026-06-01", "2026-07-01", "2026-08-08"]);
});

test("rotationPlan retention <= 0 keeps everything", () => {
	const p = rotationPlan({ currentDate: "2020-01-01", today: "2026-09-08", existingDates: ["2019-01-01"], retentionDays: 0 });
	assert.equal(p.rollToDate, "2020-01-01");
	assert.deepEqual(p.pruneDates, []);
});

test("parseRetentionDays: default 30, empty -> default, invalid -> default, truncates", () => {
	assert.equal(parseRetentionDays(undefined), 30);
	assert.equal(parseRetentionDays(""), 30);
	assert.equal(parseRetentionDays("  "), 30);
	assert.equal(parseRetentionDays("7"), 7);
	assert.equal(parseRetentionDays("0"), 0);
	assert.equal(parseRetentionDays("-1"), -1);
	assert.equal(parseRetentionDays("14.9"), 14);
	assert.equal(parseRetentionDays("nope"), 30);
});
