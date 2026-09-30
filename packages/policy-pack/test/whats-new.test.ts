// Unit tests for lib/whats-new.ts (#117). Run: make test-policy
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
	clearNotesSeen,
	formatNotes,
	markNotesSeen,
	readNotes,
	readNotesSeen,
	SEEN_LIMIT,
	unseenNotes,
	WHATS_NEW_SEEN_KEY,
} from "../extensions/lib/whats-new.ts";

const NOTES = `# What's new

Preamble the reader never sees.

## 2026-09-30 — new default model

- The default model is now Model B.

## 2026-09-12 — skills refresh

- Skills now update while you work.
`;

function scratch(): { dir: string; notes: string; settings: string; done: () => void } {
	const dir = mkdtempSync(join(tmpdir(), "gah-whats-new-"));
	const notes = join(dir, "whats-new.md");
	writeFileSync(notes, NOTES);
	return { dir, notes, settings: join(dir, "settings.json"), done: () => rmSync(dir, { recursive: true, force: true }) };
}

test("readNotes: sections newest first, preamble dropped; no path or no file = none", () => {
	const s = scratch();
	try {
		const entries = readNotes(s.notes);
		assert.deepEqual(
			entries.map((e) => e.heading),
			["2026-09-30 — new default model", "2026-09-12 — skills refresh"],
		);
		assert.ok(!entries.some((e) => e.content.includes("Preamble")));
		assert.deepEqual(readNotes(undefined), []);
		assert.deepEqual(readNotes(join(s.dir, "absent.md")), []);
	} finally {
		s.done();
	}
});

test("never marked: only the newest section, not the file's history", () => {
	const s = scratch();
	try {
		const entries = readNotes(s.notes);
		assert.equal(readNotesSeen(s.settings), undefined);
		assert.deepEqual(
			unseenNotes(entries, readNotesSeen(s.settings)).map((e) => e.heading),
			["2026-09-30 — new default model"],
		);
	} finally {
		s.done();
	}
});

test("marked: nothing until a new section is added, then only that one", () => {
	const s = scratch();
	try {
		writeFileSync(s.settings, JSON.stringify({ defaultModel: "keep-me" }));
		assert.equal(markNotesSeen(s.settings, readNotes(s.notes)), true);
		assert.deepEqual(unseenNotes(readNotes(s.notes), readNotesSeen(s.settings)), []);
		assert.equal(JSON.parse(readFileSync(s.settings, "utf-8")).defaultModel, "keep-me", "other keys survive");

		writeFileSync(s.notes, NOTES.replace("## 2026-09-30", "## 2026-10-15 — tickets\n\n- New ticket skill.\n\n## 2026-09-30"));
		assert.deepEqual(
			unseenNotes(readNotes(s.notes), readNotesSeen(s.settings)).map((e) => e.heading),
			["2026-10-15 — tickets"],
		);
	} finally {
		s.done();
	}
});

test("a section removed from the file stays seen if it comes back", () => {
	const s = scratch();
	try {
		markNotesSeen(s.settings, readNotes(s.notes));
		writeFileSync(s.notes, "## only new\n\n- x\n");
		markNotesSeen(s.settings, readNotes(s.notes));
		writeFileSync(s.notes, NOTES);
		assert.deepEqual(unseenNotes(readNotes(s.notes), readNotesSeen(s.settings)), []);
	} finally {
		s.done();
	}
});

test("the marker is bounded", () => {
	const s = scratch();
	try {
		const many = Array.from({ length: SEEN_LIMIT + 50 }, (_, i) => `## note ${i}\n\n- n\n`).join("\n");
		writeFileSync(s.notes, many);
		markNotesSeen(s.settings, readNotes(s.notes));
		assert.equal(readNotesSeen(s.settings)?.length, SEEN_LIMIT);
	} finally {
		s.done();
	}
});

test("unparseable settings.json is left alone", () => {
	const s = scratch();
	try {
		writeFileSync(s.settings, "{ not json");
		assert.equal(markNotesSeen(s.settings, readNotes(s.notes)), false);
		assert.equal(clearNotesSeen(s.settings), false);
		assert.equal(readFileSync(s.settings, "utf-8"), "{ not json");
	} finally {
		s.done();
	}
});

test("clearNotesSeen: back to first-launch behaviour, other keys kept", () => {
	const s = scratch();
	try {
		writeFileSync(s.settings, JSON.stringify({ tuiMode: "fullscreen" }));
		markNotesSeen(s.settings, readNotes(s.notes));
		assert.equal(clearNotesSeen(s.settings), true);
		const settings = JSON.parse(readFileSync(s.settings, "utf-8"));
		assert.equal(WHATS_NEW_SEEN_KEY in settings, false);
		assert.equal(settings.tuiMode, "fullscreen");
		assert.equal(unseenNotes(readNotes(s.notes), readNotesSeen(s.settings)).length, 1);
	} finally {
		s.done();
	}
});

test("formatNotes: titled, capped with a pointer to /whats-new; nothing to show = undefined", () => {
	const s = scratch();
	try {
		const text = formatNotes(readNotes(s.notes), 3);
		assert.ok(text?.startsWith("What's new\n\n## 2026-09-30"));
		assert.match(text ?? "", /more \(\/whats-new\)$/);
		assert.equal(formatNotes([]), undefined);
	} finally {
		s.done();
	}
});
