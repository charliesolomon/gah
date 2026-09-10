/**
 * Prompted tool calling: tool use through an inference server that refuses
 * native tool calls (#42).
 *
 * Some corporate gateways strip or reject the `tools` field, and the
 * `tool_calls` / `tool` roles that come with it, as a matter of policy, even
 * when the model behind them supports tools. Without tools the agent cannot
 * touch the machine, and the model fabricates results instead of saying so.
 *
 * This module gives such a provider a text protocol, the way Continue's
 * "system message tools" does:
 *
 *   1. rewriteContext() renders the tool definitions into the system prompt
 *      and drops them from the request. Earlier tool calls and results in the
 *      history are rendered as ordinary text, so the wire never carries a tool
 *      role or a tools array.
 *   2. The model is told to emit a fenced block:
 *
 *        ```tool
 *        TOOL_NAME: read
 *        BEGIN_ARG: path
 *        docs/GITLAB.md
 *        END_ARG
 *        ```
 *
 *   3. ToolBlockParser scans the streamed text for such blocks and
 *      promptedStream() turns them into toolCall content, the same shape a
 *      native call produces. The agent loop, the policy allowlist and the
 *      audit log are untouched: they see an ordinary tool call.
 *
 * Pure: no pi imports at runtime, so `make test-policy` covers it without a
 * build. providers.ts wires it to every provider marked `"tools": "prompted"`.
 */

import type {
	AssistantMessage,
	AssistantMessageEvent,
	Context,
	ImageContent,
	Message,
	Model,
	SimpleStreamOptions,
	TextContent,
	Tool,
	ToolCall,
	ToolResultMessage,
} from "@earendil-works/pi-ai";

export type ToolMode = "native" | "prompted";
export const TOOL_MODES: readonly ToolMode[] = ["native", "prompted"];
/** Where the protocol text goes: the system prompt, or the front of the current user turn. */
export type PromptPlacement = "system" | "user";
export const PROMPT_PLACEMENTS: readonly PromptPlacement[] = ["system", "user"];

const OPEN_PREFIX = "```tool";
const FENCE_OPEN = /^```\s*tool\s*$/;
const FENCE_CLOSE = /^```\s*$/;
const TOOL_NAME = /^TOOL_NAME:\s*(\S+)\s*$/;
const BEGIN_ARG = /^BEGIN_ARG:\s*(\S+)\s*$/;
const END_ARG = /^END_ARG\s*$/;

// --- Prompt rendering ----------------------------------------------------------

interface JsonSchema {
	type?: string | string[];
	description?: string;
	properties?: Record<string, JsonSchema>;
	required?: string[];
	enum?: unknown[];
	items?: JsonSchema;
	anyOf?: JsonSchema[];
}

function schemaType(schema: JsonSchema | undefined): string {
	if (!schema) return "string";
	if (Array.isArray(schema.type)) return schema.type.join("|");
	if (schema.type) return schema.type;
	if (schema.enum) return "string";
	if (schema.anyOf) return schema.anyOf.map(schemaType).join("|");
	return "string";
}

/** The tools section appended to the system prompt: the protocol, then every tool. */
export function renderToolsPrompt(tools: readonly Tool[]): string {
	const lines: string[] = [
		"# Tool calling: text protocol",
		"",
		"This endpoint does not accept native tool calls, so tools are called in text. To call a tool, end your reply with one fenced block in exactly this form:",
		"",
		"```tool",
		"TOOL_NAME: <tool name>",
		"BEGIN_ARG: <argument name>",
		"<argument value; may span several lines>",
		"END_ARG",
		"```",
		"",
		"Rules:",
		"- One BEGIN_ARG/END_ARG pair per argument. Omit optional arguments you do not need.",
		"- Argument values are raw text. Write numbers, booleans, arrays and objects as JSON.",
		"- One tool call per reply, at the end. Stop after the closing fence; the result arrives in the next message inside <tool_result>.",
		"- Never write a <tool_result> yourself and never guess what a tool would return. Without a result you do not know.",
		"- Use the ```tool fence for nothing else.",
		"",
		"Available tools:",
	];
	for (const tool of tools) {
		lines.push("", `## ${tool.name}`);
		if (tool.description) lines.push(tool.description.trim());
		const schema = tool.parameters as unknown as JsonSchema;
		const props = schema?.properties ?? {};
		const required = new Set(schema?.required ?? []);
		const names = Object.keys(props);
		lines.push(names.length ? "Arguments:" : "Arguments: none");
		for (const name of names) {
			const p = props[name];
			const type = schemaType(p);
			let detail = p.description ? `: ${p.description.trim()}` : "";
			if (p.enum) detail += ` (one of: ${p.enum.map((v) => JSON.stringify(v)).join(", ")})`;
			if (type.includes("object") || type.includes("array")) detail += ` (JSON, schema: ${JSON.stringify(p)})`;
			lines.push(`- ${name} (${type}, ${required.has(name) ? "required" : "optional"})${detail}`);
		}
	}
	return lines.join("\n");
}

/** A tool call as the model is expected to write it; used to replay history. */
export function renderToolCall(call: ToolCall): string {
	const lines = ["```tool", `TOOL_NAME: ${call.name}`];
	for (const [key, value] of Object.entries(call.arguments ?? {})) {
		lines.push(`BEGIN_ARG: ${key}`, typeof value === "string" ? value : JSON.stringify(value), "END_ARG");
	}
	lines.push("```");
	return lines.join("\n");
}

/** A tool result as the model sees it: a tagged block in the next user message. */
export function renderToolResult(result: ToolResultMessage): string {
	const text = result.content
		.filter((c): c is TextContent => c.type === "text")
		.map((c) => c.text)
		.join("\n");
	const status = result.isError ? "error" : "ok";
	return `<tool_result tool="${result.toolName}" call="${result.toolCallId}" status="${status}">\n${text}\n</tool_result>`;
}

// --- Context rewriting ---------------------------------------------------------

export interface RewriteOptions {
	/**
	 * "system" (default) appends the protocol to the system prompt. "user"
	 * prepends it to the last user message instead, for a gateway that drops
	 * system prompts; the request is rebuilt from the stored context every
	 * turn, so nothing accumulates in the session.
	 */
	placement?: PromptPlacement;
}

/**
 * The request as the server must see it: tools in the system prompt (or the
 * current user turn), tool traffic in the history rendered as text, no tools
 * array. Consecutive tool results merge into one user message.
 */
export function rewriteContext(context: Context, options: RewriteOptions = {}): Context {
	const tools = context.tools ?? [];
	const messages: Message[] = [];
	let pendingResults: ToolResultMessage[] = [];
	const flushResults = () => {
		if (pendingResults.length === 0) return;
		const content: (TextContent | ImageContent)[] = [
			{ type: "text", text: pendingResults.map(renderToolResult).join("\n\n") },
		];
		for (const r of pendingResults) {
			for (const c of r.content) if (c.type === "image") content.push(c);
		}
		messages.push({
			role: "user",
			content,
			timestamp: pendingResults[pendingResults.length - 1].timestamp,
		});
		pendingResults = [];
	};
	for (const msg of context.messages) {
		if (msg.role === "toolResult") {
			pendingResults.push(msg);
			continue;
		}
		flushResults();
		if (msg.role === "assistant") {
			const content: TextContent[] = [];
			for (const c of msg.content) {
				if (c.type === "text") content.push(c);
				else if (c.type === "toolCall") content.push({ type: "text", text: renderToolCall(c) });
				// thinking is dropped: it was never meant for replay as text
			}
			if (content.length === 0) content.push({ type: "text", text: "" });
			messages.push({ ...msg, content });
			continue;
		}
		messages.push(msg);
	}
	flushResults();
	if (tools.length === 0) return { systemPrompt: context.systemPrompt, messages, tools: undefined };
	const protocol = renderToolsPrompt(tools);
	if (options.placement === "user") {
		const last = messages.length - 1;
		const target = messages[last];
		if (target?.role === "user") {
			const content: (TextContent | ImageContent)[] =
				typeof target.content === "string" ? [{ type: "text", text: target.content }] : [...target.content];
			messages[last] = { ...target, content: [{ type: "text", text: `${protocol}\n\n---\n\n` }, ...content] };
		} else {
			messages.push({ role: "user", content: protocol, timestamp: Date.now() });
		}
		return { systemPrompt: context.systemPrompt, messages, tools: undefined };
	}
	const systemPrompt = `${context.systemPrompt ? `${context.systemPrompt.trimEnd()}\n\n` : ""}${protocol}`;
	return { systemPrompt, messages, tools: undefined };
}

// --- Parsing the model's text --------------------------------------------------

export type ParsedPiece =
	| { type: "text"; text: string }
	| {
			type: "call";
			name: string;
			args: Record<string, unknown>;
			complete: boolean;
	  };

/** Coerce a raw argument value by the tool's parameter schema. */
export function coerceArg(value: string, schema: JsonSchema | undefined): unknown {
	const type = schemaType(schema);
	if (type.split("|").includes("string")) return value;
	if (type === "boolean") {
		const t = value.trim().toLowerCase();
		if (t === "true") return true;
		if (t === "false") return false;
	}
	try {
		return JSON.parse(value.trim());
	} catch {
		return value;
	}
}

/**
 * Incremental scanner. Text outside a ```tool block is passed through as it
 * arrives, line by line; a line that could still become the opening fence is
 * held back until it is decided. Inside a block the lines are consumed and
 * the finished call is returned as one piece.
 */
export class ToolBlockParser {
	private line = "";
	private emitted = 0;
	private state: "text" | "block" | "arg" = "text";
	private raw: string[] = [];
	private name: string | undefined;
	private args: Record<string, string> = {};
	private argName: string | undefined;
	private argLines: string[] = [];
	private lastTerminated = false;

	constructor(private readonly tools: readonly Tool[]) {}

	feed(delta: string): ParsedPiece[] {
		const out: ParsedPiece[] = [];
		const buf = this.line + delta;
		let start = 0;
		let idx = buf.indexOf("\n");
		while (idx !== -1) {
			this.handleLine(buf.slice(start, idx), true, out);
			start = idx + 1;
			idx = buf.indexOf("\n", start);
		}
		this.line = buf.slice(start);
		if (this.state === "text" && !this.couldOpenFence(this.line) && this.line.length > this.emitted) {
			out.push({ type: "text", text: this.line.slice(this.emitted) });
			this.emitted = this.line.length;
		}
		return out;
	}

	/**
	 * End of stream: flush held text, or close an unterminated block. A block
	 * that has its name and no argument left open is complete even without
	 * the closing fence: some gateways end the stream with "length" exactly
	 * there (a Gemini gateway counting thinking tokens against the output cap
	 * did), and the call is whole. Only a cut inside an argument value is
	 * reported incomplete.
	 */
	finish(): ParsedPiece[] {
		const out: ParsedPiece[] = [];
		if (this.line.length > 0) this.handleLine(this.line, false, out);
		this.line = "";
		this.emitted = 0;
		if (this.state !== "text") this.finishBlock(this.state === "block", out);
		return out;
	}

	private couldOpenFence(partial: string): boolean {
		if (partial.length === 0) return false;
		if (OPEN_PREFIX.startsWith(partial)) return true;
		return partial.startsWith(OPEN_PREFIX) && partial.slice(OPEN_PREFIX.length).trim() === "";
	}

	private handleLine(rawLine: string, terminated: boolean, out: ParsedPiece[]): void {
		const line = rawLine.replace(/\r$/, "");
		this.lastTerminated = terminated;
		if (this.state === "text") {
			if (FENCE_OPEN.test(line)) {
				this.state = "block";
				this.raw = [];
				this.name = undefined;
				this.args = {};
			} else {
				const text = rawLine.slice(this.emitted) + (terminated ? "\n" : "");
				if (text) out.push({ type: "text", text });
			}
			this.emitted = 0;
			return;
		}
		this.raw.push(rawLine);
		if (this.state === "arg") {
			if (END_ARG.test(line)) {
				this.args[this.argName!] = this.argLines.join("\n");
				this.state = "block";
			} else {
				this.argLines.push(line);
			}
			return;
		}
		if (FENCE_CLOSE.test(line)) {
			this.finishBlock(true, out);
			return;
		}
		const name = line.match(TOOL_NAME);
		if (name) {
			this.name = name[1];
			return;
		}
		const arg = line.match(BEGIN_ARG);
		if (arg) {
			this.state = "arg";
			this.argName = arg[1];
			this.argLines = [];
		}
		// anything else inside a block is noise and ignored
	}

	private finishBlock(complete: boolean, out: ParsedPiece[]): void {
		if (this.state === "arg" && this.argName !== undefined) {
			this.args[this.argName] = this.argLines.join("\n");
		}
		if (this.name) {
			const tool = this.tools.find((t) => t.name === this.name);
			const props = (tool?.parameters as unknown as JsonSchema | undefined)?.properties ?? {};
			const args: Record<string, unknown> = {};
			for (const [k, v] of Object.entries(this.args)) args[k] = coerceArg(v, props[k]);
			out.push({ type: "call", name: this.name, args, complete });
		} else {
			// A ```tool fence with no TOOL_NAME was not a call; give the text back.
			const body = this.raw.length > 0 ? `\n${this.raw.join("\n")}` : "";
			out.push({
				type: "text",
				text: `${OPEN_PREFIX}${body}${this.lastTerminated ? "\n" : ""}`,
			});
		}
		this.state = "text";
		this.raw = [];
		this.name = undefined;
		this.args = {};
		this.argName = undefined;
		this.argLines = [];
	}
}

// --- The stream wrapper ---------------------------------------------------------

/**
 * The event stream promptedStream() returns. Same contract as pi-ai's
 * AssistantMessageEventStream, which upstream's composer consumes by async
 * iteration plus result(): kept local so this module needs no runtime import
 * from pi-ai (the root entry re-exports the class type-only for extensions).
 */
export class PromptedEventStream implements AsyncIterable<AssistantMessageEvent> {
	private queue: AssistantMessageEvent[] = [];
	private waiting: ((r: IteratorResult<AssistantMessageEvent>) => void)[] = [];
	private done = false;
	private resolveResult!: (m: AssistantMessage) => void;
	private readonly finalResult = new Promise<AssistantMessage>((resolve) => {
		this.resolveResult = resolve;
	});

	push(event: AssistantMessageEvent): void {
		if (this.done) return;
		if (event.type === "done") {
			this.done = true;
			this.resolveResult(event.message);
		} else if (event.type === "error") {
			this.done = true;
			this.resolveResult(event.error);
		}
		const waiter = this.waiting.shift();
		if (waiter) waiter({ value: event, done: false });
		else this.queue.push(event);
	}

	end(result?: AssistantMessage): void {
		this.done = true;
		if (result !== undefined) this.resolveResult(result);
		while (this.waiting.length > 0) this.waiting.shift()!({ value: undefined as never, done: true });
	}

	async *[Symbol.asyncIterator](): AsyncIterator<AssistantMessageEvent> {
		while (true) {
			if (this.queue.length > 0) {
				yield this.queue.shift()!;
			} else if (this.done) {
				return;
			} else {
				const next = await new Promise<IteratorResult<AssistantMessageEvent>>((resolve) =>
					this.waiting.push(resolve),
				);
				if (next.done) return;
				yield next.value;
			}
		}
	}

	result(): Promise<AssistantMessage> {
		return this.finalResult;
	}
}

export interface BaseStreams {
	streamSimple(
		model: Model<string>,
		context: Context,
		options?: SimpleStreamOptions,
	): AsyncIterable<AssistantMessageEvent>;
}

let callCounter = 0;
function nextCallId(): string {
	callCounter += 1;
	return `prompted-${Date.now().toString(36)}-${callCounter}`;
}

/** One line per request, for GAH_PROMPTED_DEBUG: what went out and what the model wrote back. */
export interface PromptedDebugEntry {
	ts: string;
	model: string;
	placement: PromptPlacement;
	systemPromptChars: number;
	protocolInSystem: boolean;
	roles: string[];
	stopReason: string;
	/** What the base streamer reported before this wrapper decided, and the provider's raw finish reason. */
	baseStopReason?: string;
	rawStopReason?: string;
	text: string;
	calls: { name: string; args: Record<string, unknown> }[];
	error?: string;
}

export interface PromptedStreamOptions extends RewriteOptions {
	/** Receives one entry per request; providers.ts appends it to $GAH_PROMPTED_DEBUG. */
	debug?: (entry: PromptedDebugEntry) => void;
}

/**
 * Stream a request through `base` with the rewritten context, and re-emit its
 * events with tool blocks converted to toolCall content. Text and thinking
 * pass through; the base's own text block boundaries are replaced by ours.
 */
export function promptedStream(
	base: BaseStreams,
	model: Model<string>,
	context: Context,
	options?: SimpleStreamOptions,
	promptedOptions: PromptedStreamOptions = {},
): PromptedEventStream {
	const out = new PromptedEventStream();
	const tools = context.tools ?? [];
	const parser = new ToolBlockParser(tools);
	const placement = promptedOptions.placement ?? "system";
	let rawText = "";
	let baseStopReason: string | undefined;
	const report = (error?: string) => {
		if (!promptedOptions.debug) return;
		try {
			promptedOptions.debug({
				ts: new Date().toISOString(),
				model: model.id,
				placement,
				systemPromptChars: rewritten.systemPrompt?.length ?? 0,
				protocolInSystem: rewritten.systemPrompt?.includes("TOOL_NAME: <tool name>") ?? false,
				roles: rewritten.messages.map((m) => m.role),
				stopReason: output.stopReason,
				...(baseStopReason ? { baseStopReason } : {}),
				...(output.rawStopReason ? { rawStopReason: output.rawStopReason } : {}),
				text: rawText,
				calls: output.content
					.filter((c): c is ToolCall => c.type === "toolCall")
					.map((c) => ({ name: c.name, args: c.arguments })),
				...(error ? { error } : {}),
			});
		} catch {
			/* debug output must never break a request */
		}
	};
	const rewritten = rewriteContext(context, { placement });
	const output: AssistantMessage = {
		role: "assistant",
		content: [],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "pending",
		timestamp: Date.now(),
	};
	let textIndex = -1; // index of the open text block in output.content, or -1
	let thinkingIndex = -1;
	let sawCall = false;
	let truncatedCall = false;

	const closeText = () => {
		if (textIndex < 0) return;
		const block = output.content[textIndex] as TextContent;
		out.push({
			type: "text_end",
			contentIndex: textIndex,
			content: block.text,
			partial: output,
		});
		textIndex = -1;
	};
	const emitPieces = (pieces: ParsedPiece[]) => {
		for (const piece of pieces) {
			if (piece.type === "text") {
				if (textIndex < 0) {
					output.content.push({ type: "text", text: "" });
					textIndex = output.content.length - 1;
					out.push({
						type: "text_start",
						contentIndex: textIndex,
						partial: output,
					});
				}
				(output.content[textIndex] as TextContent).text += piece.text;
				out.push({
					type: "text_delta",
					contentIndex: textIndex,
					delta: piece.text,
					partial: output,
				});
				continue;
			}
			closeText();
			const call: ToolCall = {
				type: "toolCall",
				id: nextCallId(),
				name: piece.name,
				arguments: piece.args,
			};
			output.content.push(call);
			const contentIndex = output.content.length - 1;
			sawCall = true;
			if (!piece.complete) truncatedCall = true;
			out.push({ type: "toolcall_start", contentIndex, partial: output });
			out.push({
				type: "toolcall_delta",
				contentIndex,
				delta: JSON.stringify(call.arguments),
				partial: output,
			});
			out.push({
				type: "toolcall_end",
				contentIndex,
				toolCall: call,
				partial: output,
			});
		}
	};
	const fail = (reason: "error" | "aborted", message: string) => {
		output.stopReason = reason;
		output.errorMessage = message;
		report(message);
		out.push({ type: "error", reason, error: output });
		out.end(output);
	};

	(async () => {
		try {
			const inner = base.streamSimple(model, rewritten, options);
			for await (const event of inner) {
				switch (event.type) {
					case "start":
						out.push({ type: "start", partial: output });
						break;
					case "text_delta":
						rawText += event.delta;
						emitPieces(parser.feed(event.delta));
						break;
					case "text_start":
					case "text_end":
						break; // our own text blocks follow the parser, not the base
					case "thinking_start":
						closeText();
						output.content.push({ type: "thinking", thinking: "" });
						thinkingIndex = output.content.length - 1;
						out.push({
							type: "thinking_start",
							contentIndex: thinkingIndex,
							partial: output,
						});
						break;
					case "thinking_delta":
						if (thinkingIndex >= 0) {
							(output.content[thinkingIndex] as { thinking: string }).thinking += event.delta;
							out.push({
								type: "thinking_delta",
								contentIndex: thinkingIndex,
								delta: event.delta,
								partial: output,
							});
						}
						break;
					case "thinking_end":
						if (thinkingIndex >= 0) {
							const block = output.content[thinkingIndex] as {
								thinking: string;
								thinkingSignature?: string;
							};
							const source = event.partial.content[event.contentIndex] as
								| { thinkingSignature?: string }
								| undefined;
							if (source?.thinkingSignature) block.thinkingSignature = source.thinkingSignature;
							out.push({
								type: "thinking_end",
								contentIndex: thinkingIndex,
								content: block.thinking,
								partial: output,
							});
							thinkingIndex = -1;
						}
						break;
					case "done": {
						baseStopReason = event.reason;
						emitPieces(parser.finish());
						closeText();
						const m = event.message;
						output.usage = m.usage;
						if (m.responseModel) output.responseModel = m.responseModel;
						if (m.responseId) output.responseId = m.responseId;
						if (m.rawStopReason) output.rawStopReason = m.rawStopReason;
						if (m.providerThinkingLevel) output.providerThinkingLevel = m.providerThinkingLevel;
						if (m.diagnostics) output.diagnostics = m.diagnostics;
						if (m.endTurn !== undefined) output.endTurn = m.endTurn;
						// A call cut off inside an argument must not run: "length" makes
						// the agent loop fail it instead of executing it. A structurally
						// complete call runs even when the base reported "length", since
						// the protocol shows the arguments are whole (see finish()).
						const reason = truncatedCall ? "length" : sawCall ? "toolUse" : event.reason;
						output.stopReason = reason;
						report();
						out.push({ type: "done", reason, message: output });
						out.end(output);
						return;
					}
					case "error":
						fail(event.reason, event.error.errorMessage ?? "unknown provider error");
						return;
				}
			}
			if (output.stopReason === "pending") fail("error", "provider stream ended without a stop reason");
		} catch (error) {
			fail(options?.signal?.aborted ? "aborted" : "error", error instanceof Error ? error.message : String(error));
		}
	})();

	return out;
}
