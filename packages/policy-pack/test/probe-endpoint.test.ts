// Unit tests for scripts/probe-endpoint.mjs with an injected fetch: no network.
// Run: make test-policy
import assert from "node:assert/strict";
import { test } from "node:test";
import { buildProvider } from "../../../scripts/add-provider.mjs";
import {
	ABSURD_MAX_TOKENS,
	formatReport,
	HISTORY_WORD,
	historyBody,
	historyBodyWith,
	historyOpeningBody,
	limitsFromError,
	parseModelList,
	probeBody,
	probeEndpoint,
	promptPlacementFor,
	replyExcerpt,
	replyWasCut,
	sawHistoryWord,
	sawToolBlock,
	sawToolCall,
	systemBody,
	toolModeFor,
} from "../../../scripts/probe-endpoint.mjs";

const BASE = "https://gw.example.com/openai/v1";

/** A fake endpoint: `routes(path, body)` returns { status, json | text, contentType }. */
function fakeFetch(routes: (path: string, body: any, method: string) => any, seen: any[] = []) {
	return async (url: string, init: any) => {
		const path = url.slice(BASE.length);
		const body = init?.body ? JSON.parse(init.body) : undefined;
		seen.push({ path, method: init.method, body, headers: init.headers });
		const r = routes(path, body, init.method) ?? { status: 404, json: { error: { message: "no route" } } };
		const text = r.text ?? JSON.stringify(r.json ?? {});
		return {
			ok: r.status >= 200 && r.status < 300,
			status: r.status,
			headers: { get: (k: string) => (k === "content-type" ? (r.contentType ?? "application/json") : null) },
			text: async () => text,
		};
	};
}

const chatOk = { status: 200, json: { choices: [{ message: { role: "assistant", content: "OK" } }] } };
const chatToolCall = {
	status: 200,
	json: {
		choices: [
			{
				message: {
					role: "assistant",
					tool_calls: [{ id: "c1", type: "function", function: { name: "ls", arguments: "{\"path\":\".\"}" } }],
				},
			},
		],
	},
};
const sse = {
	status: 200,
	contentType: "text/event-stream",
	text: 'data: {"choices":[{"delta":{"content":"OK"}}]}\n\ndata: [DONE]\n\n',
};
/** A streamed ping/ok reply — unless the request carries the tool protocol, which the protocol probe streams. */
const streamOrAnswer = (body: any, opts: any = {}) =>
	body.stream && !JSON.stringify(body.messages ?? body.input ?? "").includes("TOOL_NAME") ? sse : answer(body, opts);
const PING_BLOCK = "Sure.\n```tool\nTOOL_NAME: ls\nBEGIN_ARG: path\n.\nEND_ARG\n```";
const reply = (content: string) => ({ status: 200, json: { choices: [{ message: { role: "assistant", content } }] } });
/** A model behind a Chat Completions endpoint: honours the system prompt (or not), follows the protocol (from where). */
const capError = {
	status: 400,
	json: {
		error: {
			message: `max_tokens is too large: ${ABSURD_MAX_TOKENS}. This model supports at most 8192 completion tokens, whereas you provided ${ABSURD_MAX_TOKENS}.`,
		},
	},
};
function answer(
	body: any,
	opts: { honourSystem?: boolean; followFrom?: "system" | "user" | "never"; clamp?: boolean; keepHistory?: boolean; ownTurnsOnly?: boolean } = {},
) {
	const { honourSystem = true, followFrom = "system", clamp = false, keepHistory = true, ownTurnsOnly = false } = opts;
	if (body.max_tokens === ABSURD_MAX_TOKENS && !clamp) return capError;
	// The history probe, two steps: the opening turn alone gets this gateway's own
	// reply; the three-turn body answers from turn 1 unless the gateway is single-turn
	// (keepHistory: false) or validates the assistant slot against what it said
	// itself (ownTurnsOnly: true).
	const opening = `Understood — ${HISTORY_WORD} noted. OK`;
	if (body.messages.length === 1 && body.messages[0].content.includes(HISTORY_WORD)) return reply(opening);
	if (body.messages.length === 3 && body.messages[0].content.includes(HISTORY_WORD)) {
		if (!keepHistory) return reply("I don't have a code word from you.");
		if (ownTurnsOnly && body.messages[1].content !== opening) return reply("None");
		return reply(`The code word is ${HISTORY_WORD}.`);
	}
	const system = body.messages.find((m: any) => m.role === "system")?.content ?? "";
	const user = body.messages.find((m: any) => m.role === "user")?.content ?? "";
	if (honourSystem && /PINEAPPLE/.test(system)) return reply("PINEAPPLE");
	const protocolIn = /TOOL_NAME: <tool name>/.test(system)
		? "system"
		: /TOOL_NAME: <tool name>/.test(user)
			? "user"
			: null;
	if (protocolIn === "system" && honourSystem && followFrom === "system") return reply(PING_BLOCK);
	if (protocolIn === "user" && followFrom !== "never") return reply(PING_BLOCK);
	return chatOk;
}

test("parseModelList reads OpenAI, vLLM, LiteLLM, OpenRouter and Ollama shapes", () => {
	assert.deepEqual(parseModelList({ data: [{ id: "a" }, { id: "b", max_model_len: 32768 }] }), [
		{ id: "a" },
		{ id: "b", contextWindow: 32768 },
	]);
	assert.deepEqual(
		parseModelList({ data: [{ id: "l", model_info: { max_input_tokens: 200000, max_output_tokens: 8192 } }] }),
		[{ id: "l", contextWindow: 200000, maxTokens: 8192 }],
	);
	assert.deepEqual(
		parseModelList({ data: [{ id: "o", context_length: 128000, top_provider: { max_completion_tokens: 4096 } }] }),
		[{ id: "o", contextWindow: 128000, maxTokens: 4096 }],
	);
	assert.deepEqual(parseModelList({ models: [{ name: "llama3:8b" }] }), [{ id: "llama3:8b" }]);
	assert.deepEqual(parseModelList(["x"]), [{ id: "x" }]);
	assert.deepEqual(parseModelList({ nonsense: true }), []);
});

test("probeBody shapes a Chat Completions and a Responses request, with and without the ls tool", () => {
	const c = probeBody("openai-completions", "m", { tools: true });
	assert.equal(c.messages[0].role, "user");
	assert.equal(c.tools[0].function.name, "ls");
	assert.equal(c.stream, false);
	const r = probeBody("openai-responses", "m", { stream: true });
	assert.equal(typeof r.input, "string");
	assert.equal(r.stream, true);
	assert.ok(!("tools" in r));
});

test("historyBody puts the answer in the first turn for both wire shapes; sawHistoryWord reads a reply", () => {
	const c = historyBody("openai-completions", "m");
	assert.equal(c.messages.length, 3);
	assert.deepEqual(c.messages.map((m: any) => m.role), ["user", "assistant", "user"]);
	assert.ok(c.messages[0].content.includes(HISTORY_WORD));
	const r = historyBody("openai-responses", "m");
	assert.equal(r.input.length, 3);
	assert.equal(historyOpeningBody("openai-completions", "m").messages.length, 1);
	assert.equal(historyBodyWith("openai-completions", "m", "Sure thing").messages[1].content, "Sure thing");
	assert.equal(historyBodyWith("openai-completions", "m", "").messages[1].content, "OK", "an empty own reply falls back to OK");
	assert.ok(!("max_tokens" in c) && !("max_output_tokens" in r), "no output cap: a verbose model must be allowed to reach the word");
	assert.ok(sawHistoryWord(`Sure: ${HISTORY_WORD}`));
	assert.ok(sawHistoryWord("### 🔑 Codeword\n\n| Item | Value |\n|---|---|\n| Codeword | `Pelican‑4471` |"), "markdown, capitals and a unicode hyphen still count");
	assert.ok(!sawHistoryWord("I don't know"));
	assert.ok(replyWasCut('{"choices":[{"message":{"content":"### Codeword\\n\\n| Item"},"finish_reason":"length"}]}'));
	assert.ok(!replyWasCut('{"choices":[{"message":{"content":"x"},"finish_reason":"stop"}]}'));
});

test("a gateway that only honours its own assistant turns: history kept, with a note", async () => {
	const fetchFn = fakeFetch((path, body) => {
		if (path === "/models") return { status: 200, json: { data: [{ id: "m" }] } };
		if (path === "/chat/completions") return streamOrAnswer(body, { ownTurnsOnly: true });
		return undefined;
	});
	const report = await probeEndpoint({ baseUrl: BASE, apiKey: "k", fetchFn, pauseMs: 0 });
	assert.equal(report.history, "kept", "the two-step probe uses the gateway's own reply");
	assert.equal(report.historyOwnTurnsOnly, true);
	assert.ok(report.notes.some((n: string) => /fabricated "OK".*None/.test(n)), `notes: ${report.notes}`);
});

test("a quota rejection of the absurd cap states no limit", async () => {
	const fetchFn = fakeFetch((path, body) => {
		if (path === "/models") return { status: 200, json: { data: [{ id: "m" }] } };
		if (path === "/chat/completions") {
			if (body.max_tokens === ABSURD_MAX_TOKENS)
				return { status: 429, json: { error: { message: "You've used 16319 of your 50000000 token allowance for this 24-hour window. Your limit resets in 23h 50m." } } };
			return streamOrAnswer(body, { clamp: true });
		}
		return undefined;
	});
	const report = await probeEndpoint({ baseUrl: BASE, apiKey: "k", fetchFn, pauseMs: 0 });
	assert.equal(report.outputCap.rateLimited, true);
	assert.equal(report.outputCap.maxTokens, undefined, "16319 is usage, not a limit");
	assert.equal(report.models[0].maxTokens, undefined);
	assert.match(formatReport(report), /Max output tokens: not determined/);
});

test("transient failures: one retry, timeouts are failures not refusals, no fabricated turn", async () => {
	let modelsCalls = 0;
	const fetchFn = fakeFetch((path, body) => {
		if (path === "/models") return ++modelsCalls === 1 ? { status: 503, text: "no healthy upstream" } : { status: 200, json: { data: [{ id: "m" }] } };
		if (path === "/chat/completions") {
			if (body.tools) throw Object.assign(new Error("aborted"), { name: "AbortError" }); // the tools request times out, twice
			if (body.messages.length === 1 && body.messages[0].content.includes(HISTORY_WORD)) return { status: 502, text: "bad gateway" }; // the opening turn fails, twice
			return streamOrAnswer(body);
		}
		return undefined;
	});
	const report = await probeEndpoint({ baseUrl: BASE, apiKey: "k", fetchFn, pauseMs: 0 });
	assert.equal(report.models.length, 1, "GET /models succeeded on the retry");
	assert.ok(report.retried >= 1);
	assert.equal(report.tools, "failed");
	assert.equal(toolModeFor(report), undefined, "a failed tool probe recommends nothing");
	assert.match(formatReport(report), /Tool calls: could not be tested/);
	assert.equal(report.history, "inconclusive");
	assert.ok(report.notes.some((n: string) => /opening turn failed .*fabricated/.test(n)), `notes: ${report.notes}`);
});

test("the output cap is probed last, so its quota side effect cannot poison the other probes", async () => {
	const order: string[] = [];
	const fetchFn = fakeFetch((path, body) => {
		if (path === "/models") return { status: 200, json: { data: [{ id: "m" }] } };
		if (path === "/chat/completions") {
			order.push(body.max_tokens === ABSURD_MAX_TOKENS ? "cap" : "other");
			return streamOrAnswer(body);
		}
		return undefined;
	});
	await probeEndpoint({ baseUrl: BASE, apiKey: "k", fetchFn, pauseMs: 0 });
	assert.equal(order.at(-1), "cap");
	assert.equal(order.filter((o) => o === "cap").length, 1);
});

test("a reply cut by the output limit is inconclusive, not dropped", async () => {
	const fetchFn = fakeFetch((path, body) => {
		if (path === "/models") return { status: 200, json: { data: [{ id: "m" }] } };
		if (path === "/chat/completions") {
			if (body.messages.length === 3 && body.messages[0].content.includes(HISTORY_WORD))
				return { status: 200, json: { choices: [{ message: { role: "assistant", content: "### 🔑 Codeword Verification\n\n| Item |" }, finish_reason: "length" }] } };
			return streamOrAnswer(body);
		}
		return undefined;
	});
	const report = await probeEndpoint({ baseUrl: BASE, apiKey: "k", fetchFn, pauseMs: 0 });
	assert.equal(report.history, "inconclusive");
	assert.match(formatReport(report), /Conversation history: inconclusive/);
	assert.ok(report.notes.some((n: string) => /output limit/.test(n)));
});

test("a single-turn gateway that forwards only the last message is reported as dropping history (#96)", async () => {
	const fetchFn = fakeFetch((path, body) => {
		if (path === "/models") return { status: 200, json: { data: [{ id: "m" }] } };
		if (path === "/chat/completions") return streamOrAnswer(body, { keepHistory: false });
		return undefined;
	});
	const report = await probeEndpoint({ baseUrl: BASE, apiKey: "k", fetchFn, pauseMs: 0 });
	assert.equal(report.history, "dropped");
	assert.match(formatReport(report), /Conversation history: DROPPED/);
	assert.ok(report.notes.some((n: string) => /history probe reply .*I don't have a code word/.test(n)), "the model's actual reply is in the notes");
});

test("replyExcerpt reads Chat Completions, Responses and streamed bodies", () => {
	assert.equal(replyExcerpt('{"choices":[{"message":{"content":"### Hi\\n\\n| a |  b |"}}]}'), "### Hi | a | b |");
	assert.equal(replyExcerpt('{"output":[{"type":"message","content":[{"type":"output_text","text":"yes"}]}]}'), "yes");
	assert.equal(replyExcerpt('data: {"choices":[{"delta":{"content":"pel"}}]}\n\ndata: {"choices":[{"delta":{"content":"ican"}}]}\n\ndata: [DONE]\n'), "pelican");
	assert.equal(replyExcerpt("x".repeat(300), 10), `${"x".repeat(10)}…`);
});

test("sawToolCall recognises both wire shapes", () => {
	assert.ok(sawToolCall(JSON.stringify(chatToolCall.json)));
	assert.ok(sawToolCall('{"output":[{"type":"function_call","name":"ls"}]}'));
	assert.ok(!sawToolCall(JSON.stringify(chatOk.json)));
});

test("a gateway that refuses tools: completions only, streaming, tools refused -> prompted", async () => {
	const seen: any[] = [];
	const fetchFn = fakeFetch((path, body) => {
		if (path === "/models")
			return { status: 200, json: { data: [{ id: "gemini-flash", max_model_len: 1000000 }, { id: "gpt-4.1" }] } };
		if (path === "/chat/completions") {
			if (body.tools) return { status: 400, json: { error: { message: "tools are disabled on this endpoint" } } };
			return streamOrAnswer(body);
		}
		return undefined;
	}, seen);
	const report = await probeEndpoint({ baseUrl: BASE, apiKey: "k", fetchFn, pauseMs: 0 });
	assert.deepEqual(report.models, [
		{ id: "gemini-flash", contextWindow: 1000000, maxTokens: 8192 },
		{ id: "gpt-4.1" },
	]);
	assert.equal(report.model, "gemini-flash");
	assert.equal(report.api, "openai-completions");
	assert.match(report.apis["openai-responses"], /^404/);
	assert.equal(report.streaming, true);
	assert.equal(report.history, "kept");
	assert.match(formatReport(report), /Conversation history: kept/);
	assert.equal(report.tools, "refused");
	assert.equal(toolModeFor(report), "prompted");
	assert.equal(report.protocolSource, "gah", "inside the checkout the real preamble is used");
	assert.ok(
		seen.some((r) => r.body && JSON.stringify(r.body).includes("Good Agent Harness") && JSON.stringify(r.body).includes("## ls")),
		"the protocol probe carried SYSTEM.md and the real protocol",
	);
	assert.ok(
		seen.every((r) => r.headers.authorization === "Bearer k"),
		"key sent as bearer",
	);
	assert.ok(
		seen.every((r) => !r.path.includes("k")),
		"key never in a URL",
	);
	assert.equal(report.systemPrompt, "honoured");
	assert.equal(report.protocol, "system");
	assert.equal(promptPlacementFor(report), undefined, "system placement is the default, nothing to write");
	assert.deepEqual(report.outputCap, {
		enforced: true,
		maxTokens: 8192,
		note: `400: max_tokens is too large: ${ABSURD_MAX_TOKENS}. This model supports at most 8192 completion tokens, whereas you provided ${ABSURD_MAX_TOKENS}.`.slice(
			0,
			165,
		),
	});
	assert.equal(report.models[0].maxTokens, 8192, "the probed model gets the cap the endpoint stated");
	assert.equal(report.models[1].maxTokens, undefined, "other models are not assumed");
	assert.match(formatReport(report), /Max output tokens: 8192 \(the endpoint said so\)/);
	const text = formatReport(report);
	assert.match(text, /Tool calls: refused/);
	assert.match(text, /"tools": "prompted"/);
	assert.match(text, /System prompt: reaches the model/);
	assert.match(text, /Prompted tool protocol: followed \(protocol in the system prompt\)/);
	assert.match(text, /gemini-flash {2}\(context 1000000, max output 8192\)/);
});

test("limitsFromError reads the common error shapes", () => {
	assert.deepEqual(
		limitsFromError(
			"max_tokens is too large: 100000000. This model supports at most 16384 completion tokens, whereas you provided 100000000.",
		),
		{ maxTokens: 16384 },
	);
	assert.deepEqual(
		limitsFromError(
			"This model's maximum context length is 128000 tokens. However, you requested 100000010 tokens (10 in the messages, 100000000 in the completion).",
		),
		{ contextWindow: 128000 },
	);
	assert.deepEqual(
		limitsFromError(
			"max_tokens: 100000000 > 65536, which is the maximum allowed number of output tokens for this model",
		),
		{ maxTokens: 65536 },
	);
	assert.deepEqual(limitsFromError("The maximum allowed value for max_output_tokens is 65,536."), {
		maxTokens: 65536,
	});
	assert.deepEqual(limitsFromError("Invalid request"), {});
});

test("an endpoint that clamps the output cap silently is reported as not enforced", async () => {
	const fetchFn = fakeFetch((path, body) => {
		if (path === "/models") return { status: 200, json: { data: [{ id: "m" }] } };
		if (path === "/chat/completions") return streamOrAnswer(body, { clamp: true });
		return undefined;
	});
	const report = await probeEndpoint({ baseUrl: BASE, fetchFn, pauseMs: 0 });
	assert.deepEqual(report.outputCap, { enforced: false, note: `accepted max_tokens: ${ABSURD_MAX_TOKENS}` });
	assert.match(formatReport(report), /Max output tokens: not enforced/);
});

test("sawToolBlock and systemBody", () => {
	assert.ok(sawToolBlock(PING_BLOCK));
	assert.ok(sawToolBlock("```tool\r\nTOOL_NAME:   ls\r\n```"));
	assert.ok(!sawToolBlock("I would call ls but cannot."));
	assert.ok(!sawToolBlock("```tool\nTOOL_NAME: lsof\n```"), "ls is a whole word");
	const sys = systemBody("openai-completions", "m", "SYS", "USER");
	assert.deepEqual(
		sys.messages.map((m: any) => m.role),
		["system", "user"],
	);
	const usr = systemBody("openai-completions", "m", "SYS", "USER", "user");
	assert.deepEqual(
		usr.messages.map((m: any) => m.role),
		["user"],
	);
	assert.match(usr.messages[0].content, /^SYS\n\n---\n\nUSER$/);
	const resp = systemBody("openai-responses", "m", "SYS", "USER");
	assert.equal(resp.instructions, "SYS");
	assert.equal(resp.input, "USER");
});

test("a gateway that drops system prompts: protocol followed only from the user turn -> toolsPrompt user", async () => {
	const fetchFn = fakeFetch((path, body) => {
		if (path === "/models") return { status: 200, json: { data: [{ id: "m" }] } };
		if (path === "/chat/completions")
			return streamOrAnswer(body, { honourSystem: false, followFrom: "user" });
		return undefined;
	});
	const report = await probeEndpoint({ baseUrl: BASE, fetchFn, pauseMs: 0 });
	assert.equal(report.tools, "ignored");
	assert.equal(report.systemPrompt, "ignored");
	assert.equal(report.protocol, "user");
	assert.equal(promptPlacementFor(report), "user");
	const text = formatReport(report);
	assert.match(text, /System prompt: IGNORED/);
	assert.match(text, /"toolsPrompt": "user"/);
});

test("a model that never follows the protocol is reported as not-followed", async () => {
	const fetchFn = fakeFetch((path, body) => {
		if (path === "/models") return { status: 200, json: { data: [{ id: "m" }] } };
		if (path === "/chat/completions") return streamOrAnswer(body, { followFrom: "never" });
		return undefined;
	});
	const report = await probeEndpoint({ baseUrl: BASE, fetchFn, pauseMs: 0 });
	assert.equal(report.systemPrompt, "honoured");
	assert.equal(report.protocol, "not-followed");
	assert.equal(promptPlacementFor(report), undefined);
	assert.match(formatReport(report), /NOT FOLLOWED/);
	assert.match(formatReport(report), /GAH_PROMPTED_DEBUG/);
});

test("a gateway that silently strips tools -> ignored -> prompted", async () => {
	const fetchFn = fakeFetch((path, body) => {
		if (path === "/models") return { status: 200, json: { data: [{ id: "m" }] } };
		if (path === "/chat/completions") return body.stream ? sse : chatOk; // tools accepted, never called
		return undefined;
	});
	const report = await probeEndpoint({ baseUrl: BASE, fetchFn, pauseMs: 0 });
	assert.equal(report.tools, "ignored");
	assert.equal(toolModeFor(report), "prompted");
	assert.match(formatReport(report), /Tool calls: ignored/);
	assert.equal(report.systemPrompt, "ignored", "this fake never echoes the marker");
	assert.equal(report.protocol, "not-followed");
});

test("a full-featured endpoint: Responses preferred, tools native", async () => {
	const fetchFn = fakeFetch((path, body) => {
		if (path === "/models") return { status: 200, json: { data: [{ id: "gpt-5" }] } };
		if (path === "/responses") {
			if (body.tools)
				return { status: 200, json: { output: [{ type: "function_call", name: "ls", arguments: "{\"path\":\".\"}" }] } };
			return body.stream
				? { status: 200, contentType: "text/event-stream", text: "data: {}\n\n" }
				: { status: 200, json: { output: [] } };
		}
		if (path === "/chat/completions") return body.tools ? chatToolCall : chatOk;
		return undefined;
	});
	const report = await probeEndpoint({ baseUrl: BASE, apiKey: "k", fetchFn, pauseMs: 0 });
	assert.equal(report.api, "openai-responses");
	assert.equal(report.apis["openai-completions"], "ok");
	assert.equal(report.streaming, true);
	assert.equal(report.tools, "native");
	assert.equal(toolModeFor(report), "native");
	assert.equal(report.systemPrompt, undefined, "no protocol probes when tools are native");
	assert.equal(report.protocol, undefined);
});

test("nothing answers: report says so and never throws", async () => {
	const fetchFn = fakeFetch(() => ({ status: 401, json: { error: { message: "bad key" } } }));
	const report = await probeEndpoint({ baseUrl: BASE, apiKey: "k", fetchFn, pauseMs: 0 });
	assert.equal(report.api, undefined);
	assert.equal(report.model, undefined);
	assert.ok(report.notes.some((n) => /GET \/models failed \(401: bad key\)/.test(n)));
	assert.ok(report.notes.some((n) => /pass --model/.test(n)));
	// With a model given, the protocol probes still run and fail cleanly.
	const r2 = await probeEndpoint({ baseUrl: BASE, model: "m", fetchFn, pauseMs: 0 });
	assert.equal(r2.api, undefined);
	assert.match(r2.apis["openai-completions"], /^401/);
	assert.ok(r2.notes.some((n) => /neither/.test(n)));
});

test("a fetch that throws (DNS, proxy, timeout) is reported, not thrown", async () => {
	const fetchFn = async () => {
		throw new Error("getaddrinfo ENOTFOUND gw.example.com");
	};
	const report = await probeEndpoint({ baseUrl: BASE, model: "m", fetchFn, pauseMs: 0 });
	assert.ok(report.notes.some((n) => /ENOTFOUND/.test(n)));
	assert.equal(report.api, undefined);
});

test("buildProvider writes per-model limits from the probe and the prompted mode", () => {
	const p = buildProvider({
		name: "gw",
		baseUrl: BASE,
		api: "openai-completions",
		apiKey: "$K",
		ids: ["a", "b"],
		reasoning: false,
		image: false,
		contextWindow: 128000,
		maxTokens: 16384,
		tools: "prompted",
		modelInfo: { a: { id: "a", contextWindow: 1000000, maxTokens: 8192 } },
	});
	assert.equal(p.tools, "prompted");
	assert.ok(!("toolsPrompt" in p), "system placement is the default and is not written");
	const viaUser = buildProvider({
		name: "u",
		baseUrl: BASE,
		api: "openai-completions",
		apiKey: "$K",
		ids: ["m"],
		reasoning: false,
		image: false,
		contextWindow: 1,
		maxTokens: 1,
		tools: "prompted",
		toolsPrompt: "user",
	});
	assert.equal(viaUser.toolsPrompt, "user");
	assert.deepEqual(
		p.models.map((m) => [m.id, m.contextWindow, m.maxTokens]),
		[
			["a", 1000000, 8192],
			["b", 128000, 16384],
		],
	);
	const native = buildProvider({
		name: "n",
		baseUrl: BASE,
		api: "openai-completions",
		apiKey: undefined,
		ids: ["m"],
		reasoning: false,
		image: false,
		contextWindow: 1,
		maxTokens: 1,
		tools: "native",
	});
	assert.ok(!("tools" in native), "native is the default and is not written");
});
