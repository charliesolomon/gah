// Unit tests for lib/prompted-tools.ts: prompt rendering, context rewriting,
// the streaming block parser, and the stream wrapper. Run: make test-policy
import assert from "node:assert/strict";
import { test } from "node:test";
import {
	CONTINUE_NOTE,
	coerceArg,
	type PromptedEventStream,
	promptedStream,
	renderToolCall,
	renderToolsPrompt,
	rewriteContext,
	ToolBlockParser,
} from "../extensions/lib/prompted-tools.ts";

const tools: any[] = [
	{
		name: "read",
		description: "Read a file.",
		parameters: {
			type: "object",
			properties: {
				path: { type: "string", description: "File path" },
				limit: { type: "number", description: "Max lines" },
			},
			required: ["path"],
		},
	},
	{
		name: "ls",
		description: "List a directory.",
		parameters: { type: "object", properties: { path: { type: "string" } } },
	},
];

const BLOCK = "```tool\nTOOL_NAME: read\nBEGIN_ARG: path\ndocs/GITLAB.md\nEND_ARG\nBEGIN_ARG: limit\n40\nEND_ARG\n```";

// --- rendering ---------------------------------------------------------------

test("renderToolsPrompt names every tool, argument type and requiredness", () => {
	const p = renderToolsPrompt(tools);
	assert.match(p, /```tool\nTOOL_NAME: <tool name>/);
	assert.match(
		p,
		/## read\nRead a file\.\nArguments:\n- path \(string, required\): File path\n- limit \(number, optional\): Max lines/,
	);
	assert.match(p, /## ls/);
	assert.match(p, /never guess what a tool would return/i);
});

test("renderToolCall round-trips through the parser", () => {
	const text = renderToolCall({
		type: "toolCall",
		id: "x",
		name: "read",
		arguments: { path: "a/b.md", limit: 40 },
	});
	assert.equal(text, "```tool\nTOOL_NAME: read\nBEGIN_ARG: path\na/b.md\nEND_ARG\nBEGIN_ARG: limit\n40\nEND_ARG\n```");
	const parser = new ToolBlockParser(tools);
	const pieces = [...parser.feed(`${text}\n`), ...parser.finish()];
	assert.deepEqual(pieces, [
		{
			type: "call",
			name: "read",
			args: { path: "a/b.md", limit: 40 },
			complete: true,
		},
	]);
});

test("coerceArg follows the schema and falls back to the raw string", () => {
	assert.equal(coerceArg("40", { type: "number" }), 40);
	assert.equal(coerceArg("40", { type: "string" }), "40");
	assert.equal(coerceArg("true", { type: "boolean" }), true);
	assert.deepEqual(coerceArg('["a","b"]', { type: "array" }), ["a", "b"]);
	assert.equal(coerceArg("not json", { type: "object" }), "not json");
	assert.equal(coerceArg("x", undefined), "x");
});

// --- context rewriting ---------------------------------------------------------

test("rewriteContext moves tools into the prompt and tool traffic into text", () => {
	const ctx: any = {
		systemPrompt: "You are GAH.",
		tools,
		messages: [
			{ role: "user", content: "list it", timestamp: 1 },
			{
				role: "assistant",
				content: [
					{ type: "thinking", thinking: "hmm" },
					{ type: "text", text: "Looking." },
					{ type: "toolCall", id: "c1", name: "ls", arguments: { path: "." } },
				],
				api: "openai-completions",
				provider: "corp",
				model: "m",
				usage: {},
				stopReason: "toolUse",
				timestamp: 2,
			},
			{
				role: "toolResult",
				toolCallId: "c1",
				toolName: "ls",
				content: [{ type: "text", text: "a.md\nb.md" }],
				isError: false,
				timestamp: 3,
			},
			{
				role: "toolResult",
				toolCallId: "c2",
				toolName: "read",
				content: [{ type: "text", text: "nope" }],
				isError: true,
				timestamp: 4,
			},
			{ role: "user", content: "thanks", timestamp: 5 },
		],
	};
	const out = rewriteContext(ctx);
	assert.equal(out.tools, undefined);
	assert.ok(out.systemPrompt!.startsWith("You are GAH.\n\n# Tool calling: text protocol"));
	assert.deepEqual(
		out.messages.map((m) => m.role),
		["user", "assistant", "user", "user"],
		"tool results become one user message; no toolResult role remains",
	);
	const assistant = out.messages[1] as any;
	assert.deepEqual(
		assistant.content.map((c: any) => c.type),
		["text", "text"],
		"thinking dropped, call rendered as text",
	);
	assert.equal(assistant.content[1].text, "```tool\nTOOL_NAME: ls\nBEGIN_ARG: path\n.\nEND_ARG\n```");
	const results = out.messages[2] as any;
	assert.equal(
		results.content[0].text,
		`<tool_result tool="ls" call="c1" status="ok">\na.md\nb.md\n</tool_result>\n\n<tool_result tool="read" call="c2" status="error">\nnope\n</tool_result>\n\n${CONTINUE_NOTE}`,
	);
	assert.equal(results.timestamp, 4);
	assert.deepEqual(ctx.messages.length, 5, "input untouched");
});

test("rewriteContext without tools leaves the prompt alone but still scrubs history", () => {
	const out = rewriteContext({
		systemPrompt: "S",
		messages: [
			{
				role: "toolResult",
				toolCallId: "c",
				toolName: "ls",
				content: [{ type: "text", text: "x" }],
				isError: false,
				timestamp: 1,
			},
		],
	} as any);
	assert.equal(out.systemPrompt, "S");
	assert.equal(out.messages[0].role, "user");
});

test("rewriteContext placement user: system prompt and protocol go on the person's last turn, results stay results", () => {
	const ctx: any = {
		systemPrompt: "S",
		tools,
		messages: [
			{ role: "user", content: "first", timestamp: 1 },
			{
				role: "assistant",
				content: [{ type: "text", text: "ok" }],
				api: "x",
				provider: "p",
				model: "m",
				usage: {},
				stopReason: "stop",
				timestamp: 2,
			},
			{ role: "user", content: "the task", timestamp: 3 },
			{
				role: "toolResult",
				toolCallId: "c",
				toolName: "ls",
				content: [{ type: "text", text: "x" }],
				isError: false,
				timestamp: 4,
			},
		],
	};
	const out = rewriteContext(ctx, { placement: "user" });
	assert.equal(out.systemPrompt, undefined, "nothing is sent as a system prompt: the gateway drops it anyway");
	assert.deepEqual(
		out.messages.map((m) => m.role),
		["user", "assistant", "user", "user"],
	);
	assert.equal((out.messages[0] as any).content, "first", "earlier turns untouched");
	const task = out.messages[2] as any;
	assert.match(
		task.content[0].text,
		/^S\n\n# Tool calling: text protocol/,
		"the whole system prompt travels with the protocol (#81)",
	);
	assert.equal(task.content[1].text, "the task");
	const results = out.messages[3] as any;
	assert.match(results.content[0].text, /^<tool_result tool="ls"/, "no protocol on the results message");
	assert.ok(results.content[0].text.endsWith(CONTINUE_NOTE));
	// A string user message is wrapped the same way; with no user turn at all the protocol leads.
	const plain = rewriteContext(
		{ systemPrompt: "S", tools, messages: [{ role: "user", content: "hi", timestamp: 1 }] } as any,
		{ placement: "user" },
	);
	assert.deepEqual(
		(plain.messages[0] as any).content.map((c: any) => c.text.slice(0, 8)),
		["S\n\n# Too", "hi"],
	);
	const none = rewriteContext({ systemPrompt: "S", tools, messages: [] } as any, { placement: "user" });
	assert.equal(none.messages[0].role, "user");
	assert.match(none.messages[0].content as string, /^S\n\n# Tool calling/);
	// No system prompt at all: just the protocol.
	const bare = rewriteContext({ tools, messages: [{ role: "user", content: "hi", timestamp: 1 }] } as any, {
		placement: "user",
	});
	assert.match((bare.messages[0] as any).content[0].text, /^# Tool calling/);
});

// --- parser --------------------------------------------------------------------

function run(chunks: string[]): any[] {
	const parser = new ToolBlockParser(tools);
	const pieces: any[] = [];
	for (const c of chunks) pieces.push(...parser.feed(c));
	pieces.push(...parser.finish());
	return pieces;
}
function joinText(pieces: any[]): string {
	return pieces
		.filter((p) => p.type === "text")
		.map((p) => p.text)
		.join("");
}

test("parser passes plain text through unchanged, whatever the chunking", () => {
	const text = "Hello there.\nThis has `code` and ``` fences\n```js\nx\n```\nend";
	for (const size of [1, 3, 7, 1000]) {
		const chunks: string[] = [];
		for (let i = 0; i < text.length; i += size) chunks.push(text.slice(i, i + size));
		const pieces = run(chunks);
		assert.equal(joinText(pieces), text, `chunk size ${size}`);
		assert.ok(pieces.every((p) => p.type === "text"));
	}
});

test("parser extracts a block split across arbitrary chunk boundaries", () => {
	const text = `Let me read it.\n${BLOCK}\n`;
	for (const size of [1, 2, 5, 11, 1000]) {
		const chunks: string[] = [];
		for (let i = 0; i < text.length; i += size) chunks.push(text.slice(i, i + size));
		const pieces = run(chunks);
		assert.equal(joinText(pieces), "Let me read it.\n", `chunk size ${size}`);
		const calls = pieces.filter((p) => p.type === "call");
		assert.deepEqual(calls, [
			{
				type: "call",
				name: "read",
				args: { path: "docs/GITLAB.md", limit: 40 },
				complete: true,
			},
		]);
	}
});

test("parser handles a block with no trailing newline and text after it", () => {
	const pieces = run([`${BLOCK}`]);
	assert.deepEqual(pieces, [
		{
			type: "call",
			name: "read",
			args: { path: "docs/GITLAB.md", limit: 40 },
			complete: true,
		},
	]);
	const after = run([`${BLOCK}\nDone.`]);
	assert.equal(after[0].type, "call");
	assert.equal(joinText(after), "Done.");
});

test("parser keeps multi-line argument values verbatim, including blank lines", () => {
	const body = "line one\n\n  indented\n```not a fence inside an arg\nlast";
	const pieces = run([`\`\`\`tool\nTOOL_NAME: read\nBEGIN_ARG: path\n${body}\nEND_ARG\n\`\`\`\n`]);
	assert.equal(pieces[0].args.path, body);
});

test("parser: a block cut inside an argument value is incomplete", () => {
	const pieces = run(["```tool\nTOOL_NAME: read\nBEGIN_ARG: path\ndocs/GI"]);
	assert.deepEqual(pieces, [{ type: "call", name: "read", args: { path: "docs/GI" }, complete: false }]);
});

test("parser: a block missing only its closing fence is complete", () => {
	// What a gateway that stops the stream right before the fence produces (#74).
	assert.deepEqual(run(["```tool\nTOOL_NAME: ls\nBEGIN_ARG: path\n.\nEND_ARG\n"]), [
		{ type: "call", name: "ls", args: { path: "." }, complete: true },
	]);
	assert.deepEqual(run(["```tool\nTOOL_NAME: ls\n"]), [{ type: "call", name: "ls", args: {}, complete: true }]);
	assert.deepEqual(run(["```tool\nTOOL_NAME: ls"]), [{ type: "call", name: "ls", args: {}, complete: true }]);
});

test("parser gives back a ```tool fence that never names a tool", () => {
	const pieces = run(["```tool\nnothing here\n```\nok\n"]);
	assert.ok(pieces.every((p) => p.type === "text"));
	assert.equal(joinText(pieces), "```tool\nnothing here\n```\nok\n");
});

test("parser tolerates CRLF and a fence with trailing spaces", () => {
	const pieces = run(["```tool  \r\nTOOL_NAME: ls\r\nBEGIN_ARG: path\r\n.\r\nEND_ARG\r\n```\r\n"]);
	assert.deepEqual(pieces, [{ type: "call", name: "ls", args: { path: "." }, complete: true }]);
});

test("parser handles two blocks in one reply", () => {
	const pieces = run([`${BLOCK}\n\`\`\`tool\nTOOL_NAME: ls\n\`\`\`\n`]);
	assert.deepEqual(
		pieces.filter((p) => p.type === "call").map((p) => p.name),
		["read", "ls"],
	);
});

// --- stream wrapper ------------------------------------------------------------

/** Drain a PromptedEventStream the way upstream's forwardStream does. */
async function collect(stream: PromptedEventStream) {
	const events: any[] = [];
	for await (const e of stream) events.push(e);
	return { events, result: await stream.result() };
}

function fakeBase(deltas: string[], reason = "stop", capture: { context?: any } = {}) {
	return {
		streamSimple(_model: any, context: any) {
			capture.context = context;
			const partial: any = { content: [] };
			async function* gen() {
				yield { type: "start", partial };
				yield { type: "text_start", contentIndex: 0, partial };
				for (const d of deltas) yield { type: "text_delta", contentIndex: 0, delta: d, partial };
				yield {
					type: "text_end",
					contentIndex: 0,
					content: deltas.join(""),
					partial,
				};
				yield {
					type: "done",
					reason,
					message: {
						usage: {
							input: 5,
							output: 7,
							cacheRead: 0,
							cacheWrite: 0,
							totalTokens: 12,
							cost: {},
						},
						responseId: "r1",
					},
				};
			}
			return gen();
		},
	};
}

const model: any = { id: "m1", api: "openai-completions", provider: "corp" };

test("promptedStream emits a toolCall block and stops with toolUse", async () => {
	const capture: { context?: any } = {};
	const base = fakeBase(["Sure.\n``", "`tool\nTOOL_NAME: ls\nBEGIN_ARG: path\n.\nEND_ARG\n```"], "stop", capture);
	const { events, result } = await collect(
		promptedStream(base as any, model, {
			systemPrompt: "S",
			messages: [],
			tools,
		} as any),
	);
	assert.equal(capture.context.tools, undefined, "no tools on the wire");
	assert.match(capture.context.systemPrompt, /## ls/);
	const types = events.map((e) => e.type);
	assert.deepEqual(types, [
		"start",
		"text_start",
		"text_delta",
		"text_end",
		"toolcall_start",
		"toolcall_delta",
		"toolcall_end",
		"done",
	]);
	const done = events.at(-1);
	assert.equal(done.reason, "toolUse");
	assert.equal(result, done.message, "result() resolves to the final message");
	assert.equal(done.message.stopReason, "toolUse");
	assert.equal(done.message.responseId, "r1");
	assert.equal(done.message.usage.totalTokens, 12);
	assert.deepEqual(
		done.message.content.map((c: any) => (c.type === "text" ? c.text : [c.type, c.name, c.arguments])),
		["Sure.\n", ["toolCall", "ls", { path: "." }]],
	);
	assert.match(done.message.content[1].id, /^prompted-/);
});

test("promptedStream honours placement and reports to the debug sink", async () => {
	const capture: { context?: any } = {};
	const entries: any[] = [];
	const base = fakeBase(["Text then\n```tool\nTOOL_NAME: ls\n```\n"], "stop", capture);
	await collect(
		promptedStream(
			base as any,
			model,
			{ systemPrompt: "S", messages: [{ role: "user", content: "go", timestamp: 1 }], tools } as any,
			undefined,
			{
				placement: "user",
				debug: (e) => entries.push(e),
			},
		),
	);
	assert.equal(capture.context.systemPrompt, undefined, "system prompt moved into the user turn");
	assert.match(capture.context.messages[0].content[0].text, /^S\n\n# Tool calling/);
	assert.equal(entries.length, 1);
	const e = entries[0];
	assert.equal(e.placement, "user");
	assert.equal(e.protocolInSystem, false);
	assert.deepEqual(e.roles, ["user"]);
	assert.equal(e.text, "Text then\n```tool\nTOOL_NAME: ls\n```\n");
	assert.deepEqual(e.calls, [{ name: "ls", args: {} }]);
	assert.equal(e.stopReason, "toolUse");
});

test("promptedStream passes a plain reply through with the base stop reason", async () => {
	const { events } = await collect(
		promptedStream(fakeBase(["Just ", "text."]) as any, model, {
			messages: [],
			tools,
		} as any),
	);
	const done = events.at(-1);
	assert.equal(done.reason, "stop");
	assert.deepEqual(done.message.content, [{ type: "text", text: "Just text." }]);
});

test("promptedStream reports length when the block was cut inside an argument, so the call is not run", async () => {
	const { events } = await collect(
		promptedStream(fakeBase(["```tool\nTOOL_NAME: read\nBEGIN_ARG: path\nx"], "length") as any, model, {
			messages: [],
			tools,
		} as any),
	);
	const done = events.at(-1);
	assert.equal(done.reason, "length");
	assert.equal(done.message.content[0].type, "toolCall");
});

test("promptedStream runs a whole call even when the base said length before the closing fence", async () => {
	const entries: any[] = [];
	const { events } = await collect(
		promptedStream(
			fakeBase(["```tool\nTOOL_NAME: ls\nBEGIN_ARG: path\n.\nEND_ARG\n"], "length") as any,
			model,
			{ messages: [], tools } as any,
			undefined,
			{ debug: (e) => entries.push(e) },
		),
	);
	const done = events.at(-1);
	assert.equal(done.reason, "toolUse");
	assert.deepEqual(done.message.content, [
		{ type: "toolCall", id: done.message.content[0].id, name: "ls", arguments: { path: "." } },
	]);
	assert.equal(entries[0].stopReason, "toolUse");
	assert.equal(entries[0].baseStopReason, "length");
	// No calls at all: a plain length stays length.
	const plain = await collect(
		promptedStream(fakeBase(["half a sen"], "length") as any, model, { messages: [], tools } as any),
	);
	assert.equal(plain.events.at(-1).reason, "length");
});

test("promptedStream turns a base error into an error event", async () => {
	const base = {
		streamSimple() {
			async function* gen() {
				yield { type: "start", partial: {} };
				yield {
					type: "error",
					reason: "error",
					error: { errorMessage: "boom" },
				};
			}
			return gen();
		},
	};
	const { events, result } = await collect(promptedStream(base as any, model, { messages: [], tools } as any));
	const last = events.at(-1);
	assert.equal(last.type, "error");
	assert.equal(last.error.errorMessage, "boom");
	assert.equal(last.error.stopReason, "error");
	assert.equal(result.stopReason, "error");
});
