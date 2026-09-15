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

// A realistic tool, the one every session calls first. A first version used a
// toy "ping" that "reports that tool calling works"; a model can decline a tool
// that does nothing (and gemini flash models did, #96) while calling ls the
// moment it is asked to list a directory.
const LS_PARAMETERS = {
	type: "object",
	properties: { path: { type: "string", description: "Directory to list, relative to the working directory." } },
	required: ["path"],
	additionalProperties: false,
};
const LS_TOOL_COMPLETIONS = {
	type: "function",
	function: { name: "ls", description: "List the files and directories at a path.", parameters: LS_PARAMETERS },
};
const LS_TOOL_RESPONSES = { type: "function", name: "ls", description: "List the files and directories at a path.", parameters: LS_PARAMETERS };

const SAY_OK = "Reply with the single word OK.";
const CALL_LS = "List the files in the current directory. Use the ls tool with path \".\"; do not answer from memory.";

// Does a system prompt reach the model at all? A gateway that drops it also
// drops the prompted tool protocol, whichever the model is.
const SYSTEM_MARKER = "PINEAPPLE";
const SYSTEM_TEST = `Whatever the user asks, reply with the single word ${SYSTEM_MARKER} and nothing else.`;
const SYSTEM_TEST_USER = "What is 2 + 2?";

// A compact copy of the protocol packages/policy-pack/extensions/lib/prompted-tools.ts
// renders (same block shape, one tool), to see whether this model follows it
// before a session depends on it.
const PROTOCOL_TEST = [
	"# Tool calling: text protocol",
	"",
	"This endpoint does not accept native tool calls, so tools are called in text. To call a tool, end your reply with one fenced block in exactly this form:",
	"",
	"```tool",
	"TOOL_NAME: <tool name>",
	"BEGIN_ARG: <argument name>",
	"<argument value>",
	"END_ARG",
	"```",
	"",
	"Rules: one tool call per reply, at the end; stop after the closing fence. Never guess what a tool would return.",
	"",
	"Available tools:",
	"",
	"## ls",
	"List the files and directories at a path.",
	"Arguments: path (string, required) — the directory to list, relative to the working directory.",
].join("\n");
const PROTOCOL_TEST_USER = "List the files in the current directory: call the ls tool with path \".\" now, then stop.";

// An output cap far beyond any model. The error that rejects it usually
// states the real limit, and a 200 means the endpoint clamps silently.
export const ABSURD_MAX_TOKENS = 100_000_000;

/**
 * Read the limits an endpoint states when it rejects an oversized output cap.
 * Two shapes are common: "supports at most N completion tokens" (the output
 * cap) and "maximum context length is N tokens" (the context window). Any
 * other message: the largest number that is not the one we sent, if it is
 * plausibly a token count.
 */
export function limitsFromError(text, sent = ABSURD_MAX_TOKENS) {
	const out = {};
	const clean = text.replace(/[,_](?=\d{3}\b)/g, "");
	const cap = clean.match(
		/(?:at most|maximum(?: allowed)?(?: value)?(?: of| for| is)?|max(?:imum)?_?output_?tokens?[^\d]{0,40}?)\s*[:=]?\s*(\d{3,})\s*(?:completion|output)?\s*tokens?/i,
	);
	const ctx = clean.match(/context (?:length|window)(?: is| of)?\s*[:=]?\s*(\d{3,})/i);
	if (ctx) out.contextWindow = Number(ctx[1]);
	if (cap && Number(cap[1]) !== sent && Number(cap[1]) !== out.contextWindow) out.maxTokens = Number(cap[1]);
	if (out.maxTokens === undefined && !cap) {
		// Not the value we sent, nor anything near it (a message may restate it plus the prompt size).
		const numbers = (clean.match(/\d{3,}/g) ?? [])
			.map(Number)
			.filter((n) => n < sent / 10 && n !== out.contextWindow && n >= 256);
		if (numbers.length > 0) out.maxTokens = Math.max(...numbers);
	}
	return out;
}

/** The model answered a prompted-protocol request with an ls block. */
export function sawToolBlock(text) {
	return /```\s*tool[\s\S]*?TOOL_NAME:\s*ls\b/.test(text);
}

/**
 * What the model actually said, for the report: the assistant text out of a
 * Chat Completions or Responses body (streamed or not), else the raw body,
 * whitespace collapsed and clipped. Every negative verdict carries one, so a
 * surprising result can be read instead of guessed at (#96).
 */
export function replyText(text) {
	let out = "";
	try {
		const j = JSON.parse(text);
		out =
			j?.choices?.[0]?.message?.content ??
			j?.output_text ??
			(Array.isArray(j?.output) ? j.output.flatMap((o) => o?.content ?? []).map((c) => c?.text ?? "").join("") : "") ??
			"";
		if (typeof out !== "string") out = JSON.stringify(out);
		if (!out) out = j?.error?.message ?? "";
	} catch {
		const deltas = [...text.matchAll(/"content"\s*:\s*"((?:[^"\\]|\\.)*)"/g)].map((m) => JSON.parse(`"${m[1]}"`));
		out = deltas.join("") || text;
	}
	return String(out);
}

export function replyExcerpt(text, limit = 240) {
	const out = replyText(text).replace(/\s+/g, " ").trim();
	return out.length > limit ? `${out.slice(0, limit)}…` : out;
}

/**
 * The preamble a real prompted session sends — the policy pack's SYSTEM.md and
 * the protocol as lib/prompted-tools.ts renders it for one `ls` tool — loaded
 * through jiti from this checkout. A probe with a bare protocol and no persona
 * got "I am Gemini Enterprise, I do not have access to tools like ls" from a
 * model that calls ls all day inside a session (#96); the model has to see
 * what the session shows it. Null outside a checkout; the compact copy is
 * used then, and the report says so.
 */
export async function loadGahPreamble(repoRoot = REPO_ROOT) {
	try {
		const systemPath = join(repoRoot, "packages", "policy-pack", "SYSTEM.md");
		const libPath = join(repoRoot, "packages", "policy-pack", "extensions", "lib", "prompted-tools.ts");
		const jitiPath = join(repoRoot, "vendor", "pi", "node_modules", "jiti", "lib", "jiti.mjs");
		if (!existsSync(systemPath) || !existsSync(libPath) || !existsSync(jitiPath)) return null;
		const { createJiti } = await import(pathToFileURL(jitiPath).href);
		const jiti = createJiti(import.meta.url);
		const lib = await jiti.import(libPath);
		const protocol = lib.renderToolsPrompt([{ name: "ls", description: LS_TOOL_COMPLETIONS.function.description, parameters: LS_PARAMETERS }]);
		const systemMd = readFileSync(systemPath, "utf8").replaceAll("{{ALLOWED_TOOLS}}", "`ls`");
		return `${systemMd.trimEnd()}\n\n${protocol}`;
	} catch (err) {
		if (process.env.GAH_PROBE_DEBUG) console.error(`probe: real preamble unavailable: ${err?.message ?? err}`);
		return null;
	}
}

/** Chat/Responses body carrying a system prompt (or the same text at the front of the user turn). */
export function systemBody(api, model, system, user, placement = "system") {
	const userText = placement === "user" ? `${system}\n\n---\n\n${user}` : user;
	if (api === "openai-responses") {
		return { model, ...(placement === "system" ? { instructions: system } : {}), input: userText, stream: false };
	}
	return {
		model,
		messages: [
			...(placement === "system" ? [{ role: "system", content: system }] : []),
			{ role: "user", content: userText },
		],
		stream: false,
	};
}

/** The request body for one probe. */
export const HISTORY_WORD = "pelican-4471";
const HISTORY_TURNS = [
	{ role: "user", text: `The code word is ${HISTORY_WORD}. Reply with the single word OK.` },
	{ role: "assistant", text: "OK" },
	{ role: "user", text: "What is the code word? Reply with only the code word." },
];

/**
 * A three-turn conversation whose answer lives in the first turn. A gateway
 * that forwards only the latest message cannot answer it, and an agent behind
 * such an endpoint loses its own tool results and the person's earlier
 * instructions every turn (#96). No output cap, like the other probes: a
 * first version capped the reply at 32 tokens, and a model that opens every
 * answer with a heading and a table never reached the code word — a false
 * "dropped" on an endpoint that keeps history perfectly well.
 */
export function historyBody(api, model, turns = HISTORY_TURNS) {
	if (api === "openai-responses") {
		return { model, input: turns.map((m) => ({ role: m.role, content: m.text })), stream: false };
	}
	return { model, messages: turns.map((m) => ({ role: m.role, content: m.text })), stream: false };
}

/** The first turn alone, to collect the gateway's own reply for the assistant slot. */
export function historyOpeningBody(api, model) {
	return historyBody(api, model, HISTORY_TURNS.slice(0, 1));
}

/** The three turns with the assistant slot filled by what the gateway actually said. */
export function historyBodyWith(api, model, assistantText) {
	const turns = [HISTORY_TURNS[0], { role: "assistant", text: assistantText || HISTORY_TURNS[1].text }, HISTORY_TURNS[2]];
	return historyBody(api, model, turns);
}

/** Did the reply carry the code word? Case-insensitive; any hyphen-like dash between the parts. */
export function sawHistoryWord(text) {
	const [word, digits] = HISTORY_WORD.split("-");
	return new RegExp(`${word}[\\s\\-\\u2010-\\u2015_]*${digits}`, "i").test(text);
}

/** Was the reply cut off by an output limit before it could say anything useful? */
export function replyWasCut(text) {
	return /"finish_reason"\s*:\s*"length"|"reason"\s*:\s*"max_output_tokens"|"status"\s*:\s*"incomplete"/.test(text);
}

export function probeBody(api, model, { stream = false, tools = false } = {}) {
	if (api === "openai-responses") {
		return {
			model,
			input: tools ? CALL_LS : SAY_OK,
			stream,
			...(tools ? { tools: [LS_TOOL_RESPONSES] } : {}),
		};
	}
	return {
		model,
		messages: [{ role: "user", content: tools ? CALL_LS : SAY_OK }],
		stream,
		...(tools ? { tools: [LS_TOOL_COMPLETIONS] } : {}),
	};
}

export function probePath(api) {
	return api === "openai-responses" ? "/responses" : "/chat/completions";
}

/** Did a (non-streamed or streamed) response body contain a tool call? */
export function sawToolCall(text) {
	// Chat Completions: message.tool_calls / delta.tool_calls; Responses: output
	// items of type function_call. Either form, streamed or not, names ls.
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
		systemPrompt: undefined,
		protocol: undefined,
		outputCap: undefined,
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

	// 3. Output cap. Ask for far more than any model can produce: a rejection
	//    usually names the real limit (and sometimes the context window), a 200
	//    means the endpoint clamps silently and the cap in providers.json is
	//    documentation, not a control.
	const capField = report.api === "openai-responses" ? "max_output_tokens" : "max_tokens";
	let cap = await call("POST", probePath(report.api), {
		...probeBody(report.api, report.model),
		[capField]: ABSURD_MAX_TOKENS,
	});
	if (
		!cap.ok &&
		capField === "max_tokens" &&
		/max_completion_tokens/.test(cap.text) &&
		!/at most|maximum/i.test(cap.text)
	) {
		cap = await call("POST", probePath(report.api), {
			...probeBody(report.api, report.model),
			max_completion_tokens: ABSURD_MAX_TOKENS,
		});
	}
	if (cap.ok) {
		report.outputCap = { enforced: false, note: `accepted ${capField}: ${ABSURD_MAX_TOKENS}` };
	} else if (cap.status === 0) {
		report.notes.push(`output cap probe failed (${cap.error})`);
	} else if (cap.status === 429 || /allowance|quota|rate.?limit/i.test(cap.text)) {
		// A quota message restates the account's usage, not the model's limit;
		// parsing a number out of it gave a "max output" that grew with every run.
		report.outputCap = { enforced: undefined, rateLimited: true, note: errorSummary(cap.status, cap.text) };
		report.notes.push(`output cap probe was rate-limited, so the limit is unknown: ${errorSummary(cap.status, cap.text)}`);
	} else {
		const limits = limitsFromError(cap.text);
		report.outputCap = { enforced: true, ...limits, note: errorSummary(cap.status, cap.text) };
		// The number above is parsed from this message; when it looks wrong, this is the evidence.
		report.notes.push(`output cap rejection: ${errorSummary(cap.status, cap.text)}`);
		const m = report.models.find((x) => x.id === report.model);
		if (m) {
			if (limits.maxTokens && !m.maxTokens) m.maxTokens = limits.maxTokens;
			if (limits.contextWindow && !m.contextWindow) m.contextWindow = limits.contextWindow;
		}
	}

	// 4. Streaming.
	const s = await call("POST", probePath(report.api), probeBody(report.api, report.model, { stream: true }));
	report.streaming = s.ok && (/text\/event-stream/i.test(s.contentType) || /^data:/m.test(s.text));
	if (s.ok && !report.streaming) report.notes.push("stream: true was accepted but the reply was not an event stream");
	if (!s.ok) report.notes.push(`streaming request failed (${s.error ?? errorSummary(s.status, s.text)})`);

	// 5. Conversation history. Every agent turn resends the whole conversation;
	//    an endpoint that keeps only the last message answers each turn from a
	//    blank slate (#96: "the writeup was not attached", no tool calls).
	//    Two requests, as an agent would make them: the first turn alone, then all
	//    three with the assistant slot holding what the gateway itself replied. A
	//    fabricated assistant turn is not the same test: one gateway kept history
	//    in sessions yet answered "None" to a three-turn body with an invented
	//    "OK" in the middle (#96) — it appears to discard turns it did not produce.
	const opening = await call("POST", probePath(report.api), historyOpeningBody(report.api, report.model));
	const ownReply = opening.ok ? replyText(opening.text).trim() : "";
	const hist = await call("POST", probePath(report.api), historyBodyWith(report.api, report.model, ownReply));
	if (!hist.ok) {
		report.history = "failed";
		report.notes.push(`history probe failed (${hist.error ?? errorSummary(hist.status, hist.text)})`);
	} else if (sawHistoryWord(hist.text)) {
		report.history = "kept";
		// Informational: does it also accept an assistant turn it never produced?
		// GAH replays history verbatim, so this rarely matters, but a gateway that
		// checks turns against its own transcript is worth knowing about.
		const synthetic = await call("POST", probePath(report.api), historyBody(report.api, report.model));
		if (synthetic.ok && !sawHistoryWord(synthetic.text) && !replyWasCut(synthetic.text)) {
			report.historyOwnTurnsOnly = true;
			report.notes.push(
				`history probe: the code word came back only when the assistant turn was the gateway's own reply; with a fabricated "OK" in that slot it answered: ${replyExcerpt(synthetic.text)} — this gateway seems to discard assistant turns it did not produce`,
			);
		}
	} else if (replyWasCut(hist.text)) {
		report.history = "inconclusive";
		report.notes.push("history probe: the reply was cut by an output limit before it could answer; raise the endpoint's default output cap or retry");
		report.notes.push(`history probe reply: ${replyExcerpt(hist.text)}`);
	} else {
		report.history = "dropped";
		report.notes.push(`history probe reply (asked for the code word from turn 1): ${replyExcerpt(hist.text)}`);
	}

	// 6. Tools. Three outcomes matter for providers.json:
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
		report.notes.push(`tool probe reply (asked to call ls natively): ${replyExcerpt(t.text)}`);
	}
	if (report.tools === "native") return report;

	// 7. The prompted protocol needs two things a gateway can break: the system
	//    prompt must reach the model, and the model must follow the block
	//    format. Check both, and fall back to the user turn for the protocol.
	const sys = await call(
		"POST",
		probePath(report.api),
		systemBody(report.api, report.model, SYSTEM_TEST, SYSTEM_TEST_USER),
	);
	report.systemPrompt = sys.ok ? (sys.text.includes(SYSTEM_MARKER) ? "honoured" : "ignored") : "failed";
	if (report.systemPrompt === "ignored") report.notes.push(`system prompt probe reply (should have been ${SYSTEM_MARKER}): ${replyExcerpt(sys.text)}`);
	if (!sys.ok) report.notes.push(`system prompt probe failed (${sys.error ?? errorSummary(sys.status, sys.text)})`);
	const gahPreamble = await loadGahPreamble();
	report.protocolSource = gahPreamble ? "gah" : "compact";
	const protocolText = gahPreamble ?? PROTOCOL_TEST;
	for (const placement of ["system", "user"]) {
		if (placement === "system" && report.systemPrompt === "ignored") continue;
		const r = await call(
			"POST",
			probePath(report.api),
			systemBody(report.api, report.model, protocolText, PROTOCOL_TEST_USER, placement),
		);
		if (r.ok && sawToolBlock(r.text)) {
			report.protocol = placement;
			break;
		}
		if (r.ok) report.notes.push(`protocol probe reply (${placement} placement, asked to call ls): ${replyExcerpt(r.text)}`);
		if (!r.ok)
			report.notes.push(`protocol probe (${placement}) failed (${r.error ?? errorSummary(r.status, r.text)})`);
	}
	if (!report.protocol) report.protocol = "not-followed";
	return report;
}

/** The providers.json `toolsPrompt` placement a probe result calls for, if any. */
export function promptPlacementFor(report) {
	return report.protocol === "user" ? "user" : undefined;
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
	if (report.outputCap) {
		const c = report.outputCap;
		if (c.rateLimited) lines.push("Max output tokens: not determined (the endpoint rate-limited the probe; see notes)");
		else if (!c.enforced)
			lines.push(
				`Max output tokens: not enforced by the endpoint (${c.note}); it clamps silently, so maxTokens is documentation here`,
			);
		else if (c.maxTokens)
			lines.push(
				`Max output tokens: ${c.maxTokens} (the endpoint said so${c.contextWindow ? `; context window ${c.contextWindow}` : ""})`,
			);
		else lines.push(`Max output tokens: enforced, but the limit was not stated (${c.note})`);
	}
	if (report.streaming !== undefined) lines.push(`Streaming: ${report.streaming ? "yes" : "no"}`);
	if (report.history) {
		const meaning = {
			kept: "kept (the model could answer from an earlier turn)",
			dropped: "DROPPED — the endpoint forwarded only the last message; unusable for an agent (every turn starts blank, tool results never return)",
			inconclusive: "inconclusive (the reply was cut by an output limit before it answered; see notes)",
			failed: "probe failed (see notes)",
		}[report.history];
		lines.push(`Conversation history: ${meaning}`);
	}
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
	if (report.systemPrompt) {
		const meaning = {
			honoured: "reaches the model",
			ignored: "IGNORED: the model did not follow it",
			failed: "could not be tested",
		}[report.systemPrompt];
		lines.push(`System prompt: ${meaning}`);
	}
	if (report.protocol) {
		const meaning = {
			system: "followed (protocol in the system prompt)",
			user: "followed only when placed in the user turn",
			"not-followed": "NOT FOLLOWED: the model answered without a tool block",
		}[report.protocol];
		lines.push(`Prompted tool protocol: ${meaning}`);
		if (report.protocol === "user") lines.push(`  -> also set "toolsPrompt": "user" on this provider`);
		if (report.protocol === "not-followed")
			lines.push(
				"  -> this model will fabricate instead of calling tools; try another model on this endpoint, or run a session with GAH_PROMPTED_DEBUG=<file> to see its raw replies",
			);
	}
	for (const n of report.notes) lines.push(`note: ${n}`);
	return lines.join("\n");
}

// --- CLI ---------------------------------------------------------------------------

import { argv, env, exit, stderr, stdout } from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

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
