#!/usr/bin/env node
// mock-openai.mjs — a minimal OpenAI-compatible endpoint for tests. Records
// every request's tool definitions to $MOCK_LOG (one JSON line per request)
// and answers with a two-chunk SSE stream saying "ok". Listens on
// 127.0.0.1:$MOCK_PORT. Used by scripts/check-tool-surface.sh.
//
// MOCK_MODE=prompted plays a gateway that has tool calls disabled
// (scripts/check-prompted-tools.sh): a request carrying a `tools` field or a
// tool/assistant tool_calls message is answered 400, the first request gets a
// text reply containing a ```tool block that calls $MOCK_TOOL (default ls)
// with the arguments in $MOCK_ARGS (JSON object, default {"path":"."}), split
// mid-fence across chunks, and a request whose history already holds a
// <tool_result> gets "done". Each log line also records hasTools, the message
// roles, and whether the system prompt carried the text protocol. MOCK_CUT=1
// drops the closing fence and ends that reply with finish_reason "length".
// GET /models lists m1 (with a vLLM-style max_model_len), /responses is 404,
// and a max_tokens above 32768 is rejected with OpenAI's wording, so
// scripts/probe-endpoint.mjs can be tried against this mock too.
import { appendFileSync } from "node:fs";
import http from "node:http";

const log = process.env.MOCK_LOG;
const port = Number(process.env.MOCK_PORT || 0); // 0 = any free port; the chosen one is printed
const prompted = process.env.MOCK_MODE === "prompted";
const mockTool = process.env.MOCK_TOOL || "ls";
const mockArgs = JSON.parse(process.env.MOCK_ARGS || '{"path":"."}');
// MOCK_CUT=1: end the tool-block reply before its closing fence with
// finish_reason "length", as a gateway seen on #74 does.
const cutBeforeFence = process.env.MOCK_CUT === "1";
if (!log) {
	console.error("mock-openai: MOCK_LOG is required");
	process.exit(2);
}

http
	.createServer((req, res) => {
		// The two routes probe-endpoint.mjs also touches: a model list, and no
		// Responses API on this mock (so the probe settles on Chat Completions).
		if (req.method === "GET" && /\/models\/?$/.test(req.url)) {
			res.writeHead(200, { "content-type": "application/json" });
			res.end(JSON.stringify({ object: "list", data: [{ id: "m1", object: "model", max_model_len: 32768 }] }));
			return;
		}
		if (/\/responses\/?$/.test(req.url)) {
			res.writeHead(404, { "content-type": "application/json" });
			res.end(JSON.stringify({ error: { message: "no such route" } }));
			return;
		}
		let body = "";
		req.on("data", (c) => (body += c));
		req.on("end", () => {
			let tools = [];
			let json = {};
			try {
				json = JSON.parse(body);
				tools = (json.tools ?? []).map((t) => t.function?.name ?? t.name);
			} catch {}
			const messages = Array.isArray(json.messages) ? json.messages : [];
			const text = (m) => (typeof m.content === "string" ? m.content : (m.content ?? []).map((c) => c.text ?? "").join(""));
			const roles = messages.map((m) => m.role);
			const hasTools = "tools" in json;
			const hasToolRoles = messages.some((m) => m.role === "tool" || m.tool_calls);
			const protocolInPrompt = messages.some((m) => (m.role === "system" || m.role === "developer") && text(m).includes("TOOL_NAME:"));
			const protocolInUser = messages.some((m) => m.role === "user" && text(m).includes("TOOL_NAME: <tool name>"));
			// The rendered tag carries attributes; the protocol text only mentions "<tool_result>".
			const hasResult = messages.some((m) => m.role === "user" && text(m).includes('<tool_result tool="'));
			// For probe-endpoint.mjs: this mock honours a system prompt and follows
			// the text protocol, so a probe against it shows the full happy path.
			const systemText = messages.filter((m) => m.role === "system" || m.role === "developer").map(text).join("\n");
			const userText = messages.filter((m) => m.role === "user").map(text).join("\n");
			const marker = systemText.match(/reply with the single word (\w+)/i)?.[1];
			// Exactly the probe's phrasing: a real session's prompt can contain the
			// protocol and the word "ping" inside other words, and must get the
			// tool-block reply below instead.
			const protocolPing = /## ping\n/.test(`${systemText}\n${userText}`) && /Use the ping tool now/.test(userText);
			appendFileSync(
				log,
				`${JSON.stringify({ path: req.url, tools, hasTools, hasToolRoles, roles, protocolInPrompt, protocolInUser, hasResult })}\n`,
			);
			const askedCap = json.max_tokens ?? json.max_completion_tokens;
			if (typeof askedCap === "number" && askedCap > 32768) {
				res.writeHead(400, { "content-type": "application/json" });
				res.end(JSON.stringify({ error: { message: `max_tokens is too large: ${askedCap}. This model supports at most 32768 completion tokens, whereas you provided ${askedCap}.` } }));
				return;
			}
			if (prompted && (hasTools || hasToolRoles)) {
				res.writeHead(400, { "content-type": "application/json" });
				res.end(JSON.stringify({ error: { message: "tool calls are disabled on this endpoint" } }));
				return;
			}
			res.writeHead(200, { "content-type": "text/event-stream" });
			const chunk = (d) => res.write(`data: ${JSON.stringify(d)}\n\n`);
			const say = (content) => chunk({ id: "mock", object: "chat.completion.chunk", choices: [{ index: 0, delta: { role: "assistant", content }, finish_reason: null }] });
			if (marker) say(marker);
			else if (protocolPing) say("```tool\nTOOL_NAME: ping\n```\n");
			else if (!prompted) say("ok");
			else if (hasResult) say("done");
			else {
				say("Let me look.\n``");
				say(`\`tool\nTOOL_NAME: ${mockTool}\n`);
				for (const [k, v] of Object.entries(mockArgs)) say(`BEGIN_ARG: ${k}\n${typeof v === "string" ? v : JSON.stringify(v)}\nEND_ARG\n`);
				if (!cutBeforeFence) say("```\n");
			}
			const finish = cutBeforeFence && prompted && !hasResult && !marker && !protocolPing ? "length" : "stop";
			chunk({ id: "mock", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: finish }] });
			res.write("data: [DONE]\n\n");
			res.end();
		});
	})
	.listen(port, "127.0.0.1", function () {
		console.log(`mock-openai listening on ${this.address().port}`);
	});
