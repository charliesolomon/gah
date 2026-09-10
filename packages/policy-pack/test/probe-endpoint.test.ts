// Unit tests for scripts/probe-endpoint.mjs with an injected fetch: no network.
// Run: make test-policy
import assert from "node:assert/strict";
import { test } from "node:test";
import {
	formatReport,
	parseModelList,
	probeBody,
	probeEndpoint,
	promptPlacementFor,
	sawToolBlock,
	sawToolCall,
	systemBody,
	toolModeFor,
} from "../../../scripts/probe-endpoint.mjs";
import { buildProvider } from "../../../scripts/add-provider.mjs";

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
					tool_calls: [{ id: "c1", type: "function", function: { name: "ping", arguments: "{}" } }],
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
const PING_BLOCK = "Sure.\n```tool\nTOOL_NAME: ping\n```";
const reply = (content: string) => ({ status: 200, json: { choices: [{ message: { role: "assistant", content } }] } });
/** A model behind a Chat Completions endpoint: honours the system prompt (or not), follows the protocol (from where). */
function answer(body: any, opts: { honourSystem?: boolean; followFrom?: "system" | "user" | "never" } = {}) {
	const { honourSystem = true, followFrom = "system" } = opts;
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

test("probeBody shapes a Chat Completions and a Responses request, with and without the ping tool", () => {
	const c = probeBody("openai-completions", "m", { tools: true });
	assert.equal(c.messages[0].role, "user");
	assert.equal(c.tools[0].function.name, "ping");
	assert.equal(c.stream, false);
	const r = probeBody("openai-responses", "m", { stream: true });
	assert.equal(typeof r.input, "string");
	assert.equal(r.stream, true);
	assert.ok(!("tools" in r));
});

test("sawToolCall recognises both wire shapes", () => {
	assert.ok(sawToolCall(JSON.stringify(chatToolCall.json)));
	assert.ok(sawToolCall('{"output":[{"type":"function_call","name":"ping"}]}'));
	assert.ok(!sawToolCall(JSON.stringify(chatOk.json)));
});

test("a gateway that refuses tools: completions only, streaming, tools refused -> prompted", async () => {
	const seen: any[] = [];
	const fetchFn = fakeFetch((path, body) => {
		if (path === "/models")
			return { status: 200, json: { data: [{ id: "gemini-flash", max_model_len: 1000000 }, { id: "gpt-4.1" }] } };
		if (path === "/chat/completions") {
			if (body.tools) return { status: 400, json: { error: { message: "tools are disabled on this endpoint" } } };
			return body.stream ? sse : answer(body);
		}
		return undefined;
	}, seen);
	const report = await probeEndpoint({ baseUrl: BASE, apiKey: "k", fetchFn });
	assert.deepEqual(report.models, [{ id: "gemini-flash", contextWindow: 1000000 }, { id: "gpt-4.1" }]);
	assert.equal(report.model, "gemini-flash");
	assert.equal(report.api, "openai-completions");
	assert.match(report.apis["openai-responses"], /^404/);
	assert.equal(report.streaming, true);
	assert.equal(report.tools, "refused");
	assert.equal(toolModeFor(report), "prompted");
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
	const text = formatReport(report);
	assert.match(text, /Tool calls: refused/);
	assert.match(text, /"tools": "prompted"/);
	assert.match(text, /System prompt: reaches the model/);
	assert.match(text, /Prompted tool protocol: followed \(protocol in the system prompt\)/);
	assert.match(text, /gemini-flash {2}\(context 1000000\)/);
});

test("sawToolBlock and systemBody", () => {
	assert.ok(sawToolBlock(PING_BLOCK));
	assert.ok(sawToolBlock("```tool\r\nTOOL_NAME:   ping\r\n```"));
	assert.ok(!sawToolBlock("I would call ping but cannot."));
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
			return body.stream ? sse : answer(body, { honourSystem: false, followFrom: "user" });
		return undefined;
	});
	const report = await probeEndpoint({ baseUrl: BASE, fetchFn });
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
		if (path === "/chat/completions") return body.stream ? sse : answer(body, { followFrom: "never" });
		return undefined;
	});
	const report = await probeEndpoint({ baseUrl: BASE, fetchFn });
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
	const report = await probeEndpoint({ baseUrl: BASE, fetchFn });
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
				return { status: 200, json: { output: [{ type: "function_call", name: "ping", arguments: "{}" }] } };
			return body.stream
				? { status: 200, contentType: "text/event-stream", text: "data: {}\n\n" }
				: { status: 200, json: { output: [] } };
		}
		if (path === "/chat/completions") return body.tools ? chatToolCall : chatOk;
		return undefined;
	});
	const report = await probeEndpoint({ baseUrl: BASE, apiKey: "k", fetchFn });
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
	const report = await probeEndpoint({ baseUrl: BASE, apiKey: "k", fetchFn });
	assert.equal(report.api, undefined);
	assert.equal(report.model, undefined);
	assert.ok(report.notes.some((n) => /GET \/models failed \(401: bad key\)/.test(n)));
	assert.ok(report.notes.some((n) => /pass --model/.test(n)));
	// With a model given, the protocol probes still run and fail cleanly.
	const r2 = await probeEndpoint({ baseUrl: BASE, model: "m", fetchFn });
	assert.equal(r2.api, undefined);
	assert.match(r2.apis["openai-completions"], /^401/);
	assert.ok(r2.notes.some((n) => /neither/.test(n)));
});

test("a fetch that throws (DNS, proxy, timeout) is reported, not thrown", async () => {
	const fetchFn = async () => {
		throw new Error("getaddrinfo ENOTFOUND gw.example.com");
	};
	const report = await probeEndpoint({ baseUrl: BASE, model: "m", fetchFn });
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
