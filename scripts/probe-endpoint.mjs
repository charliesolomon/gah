#!/usr/bin/env node
/**
 * probe-endpoint.mjs — ask an OpenAI-compatible endpoint what it can do, so
 * add-provider.mjs can prefill its questions and a gateway's tool-call policy
 * is known before the first session (#75, #42).
 *
 *   node scripts/probe-endpoint.mjs https://gateway.example.com/openai/v1 [--key-env VAR] [--model ID]
 *
 * Reports: the models GET /models lists (with context/output limits when the
 * server includes them: vLLM, LiteLLM, OpenRouter and Ollama-style keys are
 * recognised), which wire protocol answers (Responses, Chat Completions),
 * whether streaming works, and whether tool calls are accepted, ignored, or
 * refused — the last two are the cases for `"tools": "prompted"`.
 *
 * Every probe is one tiny request asking for a one-word reply. Nothing is
 * written. The key comes from the environment variable named by --key-env
 * (never from the command line, which would land in shell history); omit it
 * for an endpoint that needs none. Behind a corporate proxy set NODE_OPTIONS
 * as docs/WINDOWS.md describes for the build.
 */

// --- Pure helpers (fetch is injected, so tests need no network) ------------------

const CONTEXT_KEYS = ["context_length", "context_window", "max_model_len", "max_context_length", "max_input_tokens"];
const OUTPUT_KEYS = ["max_output_tokens", "max_completion_tokens", "max_tokens"];

function firstNumber(obj, keys) {
	for (const key of keys) {
		const v = obj?.[key];
		if (typeof v === "number" && v > 0) return v;
	}
	return undefined;
}

/** Normalise a GET /models response: OpenAI `data`, Ollama `models`, or a bare array. */
export function parseModelList(json) {
	const list = Array.isArray(json?.data)
		? json.data
		: Array.isArray(json?.models)
			? json.models
			: Array.isArray(json)
				? json
				: [];
	const models = [];
	for (const m of list) {
		const id = typeof m === "string" ? m : (m?.id ?? m?.name ?? m?.model);
		if (!id) continue;
		const entry = { id: String(id) };
		// Limits live at the top level (vLLM, OpenRouter), under model_info
		// (LiteLLM), or under top_provider (OpenRouter's output cap).
		const contextWindow = firstNumber(m, CONTEXT_KEYS) ?? firstNumber(m?.model_info, CONTEXT_KEYS);
		const maxTokens =
			firstNumber(m, OUTPUT_KEYS) ??
			firstNumber(m?.model_info, OUTPUT_KEYS) ??
			firstNumber(m?.top_provider, OUTPUT_KEYS);
		if (contextWindow) entry.contextWindow = contextWindow;
		if (maxTokens) entry.maxTokens = maxTokens;
		models.push(entry);
	}
	return models;
}

const PING_TOOL_COMPLETIONS = {
	type: "function",
	function: {
		name: "ping",
		description: "Reports that tool calling works. Call it with no arguments.",
		parameters: { type: "object", properties: {}, additionalProperties: false },
	},
};
const PING_TOOL_RESPONSES = {
	type: "function",
	name: "ping",
	description: "Reports that tool calling works. Call it with no arguments.",
	parameters: { type: "object", properties: {}, additionalProperties: false },
};

const SAY_OK = "Reply with the single word OK.";
const CALL_PING = "Call the ping tool now. Do not reply with text.";

/** The request body for one probe. */
export function probeBody(api, model, { stream = false, tools = false } = {}) {
	if (api === "openai-responses") {
		return {
			model,
			input: tools ? CALL_PING : SAY_OK,
			stream,
			...(tools ? { tools: [PING_TOOL_RESPONSES] } : {}),
		};
	}
	return {
		model,
		messages: [{ role: "user", content: tools ? CALL_PING : SAY_OK }],
		stream,
		...(tools ? { tools: [PING_TOOL_COMPLETIONS] } : {}),
	};
}

export function probePath(api) {
	return api === "openai-responses" ? "/responses" : "/chat/completions";
}

/** Did a (non-streamed or streamed) response body contain a tool call? */
export function sawToolCall(text) {
	// Chat Completions: message.tool_calls / delta.tool_calls; Responses: output
	// items of type function_call. Either form, streamed or not, names ping.
	return /"tool_calls"\s*:\s*\[/.test(text) || /"type"\s*:\s*"function_call"/.test(text);
}

function joinUrl(baseUrl, path) {
	return `${baseUrl.replace(/\/+$/, "")}${path}`;
}

async function readText(res, limit = 200_000) {
	try {
		const text = await res.text();
		return text.length > limit ? text.slice(0, limit) : text;
	} catch {
		return "";
	}
}

function errorSummary(status, text) {
	let message = "";
	try {
		const j = JSON.parse(text);
		message = j?.error?.message ?? j?.message ?? j?.detail ?? "";
		if (typeof message !== "string") message = JSON.stringify(message);
	} catch {
		message = text.replace(/\s+/g, " ").trim();
	}
	return `${status}${message ? `: ${message.slice(0, 160)}` : ""}`;
}

/**
 * Probe one endpoint. `fetchFn` defaults to global fetch; tests inject one.
 * Never throws for a failing endpoint: every finding is in the report.
 */
export async function probeEndpoint({
	baseUrl,
	apiKey,
	model,
	headers = {},
	fetchFn = globalThis.fetch,
	timeoutMs = 20_000,
}) {
	const h = {
		"content-type": "application/json",
		...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
		...headers,
	};
	const report = {
		baseUrl,
		models: [],
		model: undefined,
		api: undefined,
		apis: {},
		streaming: undefined,
		tools: undefined,
		notes: [],
	};

	const call = async (method, path, body) => {
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), timeoutMs);
		try {
			const res = await fetchFn(joinUrl(baseUrl, path), {
				method,
				headers: h,
				...(body !== undefined ? { body: JSON.stringify(body) } : {}),
				signal: controller.signal,
			});
			const text = await readText(res);
			return { ok: res.ok, status: res.status, text, contentType: res.headers?.get?.("content-type") ?? "" };
		} catch (error) {
			return {
				ok: false,
				status: 0,
				text: "",
				contentType: "",
				error: error?.name === "AbortError" ? "timeout" : (error?.message ?? String(error)),
			};
		} finally {
			clearTimeout(timer);
		}
	};

	// 1. Models.
	const listed = await call("GET", "/models");
	if (listed.ok) {
		try {
			report.models = parseModelList(JSON.parse(listed.text));
		} catch {
			report.notes.push("GET /models answered but was not JSON");
		}
		if (report.models.length === 0) report.notes.push("GET /models listed no models");
	} else {
		report.notes.push(`GET /models failed (${listed.error ?? errorSummary(listed.status, listed.text)})`);
	}
	report.model = model ?? report.models[0]?.id;
	if (!report.model) {
		report.notes.push("no model id to probe with; pass --model");
		return report;
	}

	// 2. Wire protocol: which of the two OpenAI shapes answers a plain request.
	for (const api of ["openai-responses", "openai-completions"]) {
		const r = await call("POST", probePath(api), probeBody(api, report.model));
		report.apis[api] = r.ok ? "ok" : (r.error ?? errorSummary(r.status, r.text));
	}
	// Prefer Responses when both answer: it is what gpt-5-class models are
	// served through on corporate gateways, and the script's default (#35).
	report.api =
		report.apis["openai-responses"] === "ok"
			? "openai-responses"
			: report.apis["openai-completions"] === "ok"
				? "openai-completions"
				: undefined;
	if (!report.api) {
		report.notes.push(
			"neither /responses nor /chat/completions answered a plain request; check the base URL, the key, and whether this is an Anthropic-style endpoint (anthropic-messages)",
		);
		return report;
	}

	// 3. Streaming.
	const s = await call("POST", probePath(report.api), probeBody(report.api, report.model, { stream: true }));
	report.streaming = s.ok && (/text\/event-stream/i.test(s.contentType) || /^data:/m.test(s.text));
	if (s.ok && !report.streaming) report.notes.push("stream: true was accepted but the reply was not an event stream");
	if (!s.ok) report.notes.push(`streaming request failed (${s.error ?? errorSummary(s.status, s.text)})`);

	// 4. Tools. Three outcomes matter for providers.json:
	//    native   - the model answered the ping with a tool call
	//    refused  - the request with tools was rejected while the same request
	//               without tools succeeded (a gateway policy, #42)
	//    ignored  - accepted, but no tool call came back: the definitions were
	//               most likely stripped before the model saw them (#42)
	const t = await call("POST", probePath(report.api), probeBody(report.api, report.model, { tools: true }));
	if (!t.ok) {
		report.tools = "refused";
		report.notes.push(`tools request rejected (${t.error ?? errorSummary(t.status, t.text)})`);
	} else if (sawToolCall(t.text)) {
		report.tools = "native";
	} else {
		report.tools = "ignored";
	}
	return report;
}

/** The providers.json `tools` mode a probe result calls for. */
export function toolModeFor(report) {
	return report.tools === "native" ? "native" : report.tools ? "prompted" : undefined;
}

/** Human-readable report. */
export function formatReport(report) {
	const lines = [`Endpoint: ${report.baseUrl}`];
	if (report.models.length > 0) {
		lines.push(`Models (${report.models.length}):`);
		for (const m of report.models.slice(0, 40)) {
			const limits = [
				m.contextWindow ? `context ${m.contextWindow}` : null,
				m.maxTokens ? `max output ${m.maxTokens}` : null,
			]
				.filter(Boolean)
				.join(", ");
			lines.push(`  ${m.id}${limits ? `  (${limits})` : ""}`);
		}
		if (report.models.length > 40) lines.push(`  … ${report.models.length - 40} more`);
	}
	if (report.model) lines.push(`Probed with: ${report.model}`);
	for (const [api, result] of Object.entries(report.apis)) lines.push(`${api}: ${result}`);
	if (report.api) lines.push(`Protocol to use: ${report.api}`);
	if (report.streaming !== undefined) lines.push(`Streaming: ${report.streaming ? "yes" : "no"}`);
	if (report.tools) {
		const meaning = {
			native: "yes (model returned a tool call)",
			refused: "refused by the endpoint",
			ignored: "ignored (accepted, but no tool call came back)",
		}[report.tools];
		lines.push(`Tool calls: ${meaning}`);
		const mode = toolModeFor(report);
		if (mode === "prompted") lines.push(`  -> set "tools": "prompted" on this provider (docs/PROVIDERS.md)`);
	}
	for (const n of report.notes) lines.push(`note: ${n}`);
	return lines.join("\n");
}

// --- CLI ---------------------------------------------------------------------------

import { fileURLToPath } from "node:url";
import { argv, env, exit, stdout, stderr } from "node:process";

function flag(name) {
	const i = argv.indexOf(name);
	return i !== -1 ? argv[i + 1] : undefined;
}

async function main() {
	const baseUrl = argv
		.slice(2)
		.find((a) => !a.startsWith("--") && !["--key-env", "--model"].includes(argv[argv.indexOf(a) - 1]));
	if (!baseUrl || argv.includes("--help")) {
		stderr.write("usage: node scripts/probe-endpoint.mjs <baseUrl> [--key-env VAR] [--model ID]\n");
		exit(2);
	}
	const keyEnv = flag("--key-env");
	const apiKey = keyEnv ? env[keyEnv] : undefined;
	if (keyEnv && !apiKey) {
		stderr.write(`probe-endpoint: $${keyEnv} is not set\n`);
		exit(2);
	}
	const report = await probeEndpoint({ baseUrl, apiKey, model: flag("--model") });
	stdout.write(`${formatReport(report)}\n`);
	exit(report.api ? 0 : 1);
}

if (argv[1] && fileURLToPath(import.meta.url) === argv[1]) {
	main().catch((e) => {
		stderr.write(`probe-endpoint: ${e?.message ?? e}\n`);
		exit(1);
	});
}
