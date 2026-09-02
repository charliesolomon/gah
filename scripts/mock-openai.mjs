#!/usr/bin/env node
// mock-openai.mjs — a minimal OpenAI-compatible endpoint for tests. Records
// every request's tool definitions to $MOCK_LOG (one JSON line per request)
// and answers with a two-chunk SSE stream saying "ok". Listens on
// 127.0.0.1:$MOCK_PORT. Used by scripts/check-tool-surface.sh.
import { appendFileSync } from "node:fs";
import http from "node:http";

const log = process.env.MOCK_LOG;
const port = Number(process.env.MOCK_PORT || 0); // 0 = any free port; the chosen one is printed
if (!log) {
	console.error("mock-openai: MOCK_LOG is required");
	process.exit(2);
}

http
	.createServer((req, res) => {
		let body = "";
		req.on("data", (c) => (body += c));
		req.on("end", () => {
			let tools = [];
			try {
				const json = JSON.parse(body);
				tools = (json.tools ?? []).map((t) => t.function?.name ?? t.name);
			} catch {}
			appendFileSync(log, `${JSON.stringify({ path: req.url, tools })}\n`);
			res.writeHead(200, { "content-type": "text/event-stream" });
			const chunk = (d) => res.write(`data: ${JSON.stringify(d)}\n\n`);
			chunk({ id: "mock", object: "chat.completion.chunk", choices: [{ index: 0, delta: { role: "assistant", content: "ok" }, finish_reason: null }] });
			chunk({ id: "mock", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] });
			res.write("data: [DONE]\n\n");
			res.end();
		});
	})
	.listen(port, "127.0.0.1", function () {
		console.log(`mock-openai listening on ${this.address().port}`);
	});
