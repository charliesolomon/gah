// Unit tests for lib/today.ts. Run: make test-policy
import assert from "node:assert/strict";
import { test } from "node:test";
import { localDate, todayLine } from "../extensions/lib/today.ts";

test("localDate is the machine's own day, zero-padded", () => {
	assert.equal(localDate(new Date(2026, 8, 16, 12, 0, 0)), "2026-09-16");
	assert.equal(localDate(new Date(2026, 0, 5, 0, 0, 0)), "2026-01-05");
	assert.equal(localDate(new Date(2025, 11, 31, 23, 59, 59)), "2025-12-31");
});

test("localDate is local, not UTC — an evening on the west coast is still today", () => {
	// 17:00 local on the 16th is already the 17th in UTC. The wrapper scripts a
	// skill calls use `date +%F` and `Get-Date`, both local, so the model's date
	// must agree with its own tools.
	const evening = new Date(2026, 8, 16, 17, 0, 0);
	assert.equal(localDate(evening), "2026-09-16");
	assert.notEqual(localDate(evening), evening.toISOString().slice(0, 10) === "2026-09-16" ? "" : evening.toISOString().slice(0, 10));
});

test("todayLine carries the date, the weekday, and the instruction not to guess", () => {
	const line = todayLine(new Date(2026, 8, 16, 9, 0, 0));
	assert.match(line, /2026-09-16/);
	assert.match(line, /Wednesday/);
	assert.match(line, /never infer today's date from memory/);
	assert.equal(line.includes("\n"), false, "one line: it is appended to a prompt");
});
