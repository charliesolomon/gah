#!/usr/bin/env node
/**
 * bridge.mjs — the least that has to run beside GAH for a browser to reach it (#119).
 *
 * Exploratory prototype, not a product. Zero dependencies: Node is already a
 * GAH prerequisite on Linux and on Windows, so this runs wherever gah does.
 *
 * It starts ONE policed `gah --mode rpc` child as the current user and relays:
 *   GET  /        -> index.html (the page, next to this file)
 *   GET  /events  -> Server-Sent Events: every JSONL record the child writes
 *                    to stdout, replayed from the start for a late or
 *                    reconnecting page (startup notices fire before any page
 *                    is connected)
 *   POST /cmd     -> one JSON command, written to the child's stdin
 *
 * A browser cannot read a child's stdio or a Unix socket, so something like
 * this is unavoidable; the question is only how small and how safe.
 *
 * Exposure. Anything that can POST here can run the agent -- and the shell,
 * if policy allows one -- as you. So:
 *   - TCP binds 127.0.0.1 only, and every request needs the random token
 *     printed at startup (then a cookie); Host must be the loopback address
 *     (DNS rebinding) and a POST's Origin must match (cross-site requests).
 *   - --socket PATH listens on a Unix socket (mode 0600) instead, which is
 *     what a shared Linux host needs: other users on that host can reach a
 *     loopback port, but not a 0600 socket in your home. Reach it from a
 *     laptop with `ssh -L 8765:PATH host` (OpenSSH on Windows 11 does this).
 *     The token still applies.
 *
 * Usage:
 *   node bridge.mjs [--port N | --socket PATH] [--cwd DIR] [-- <gah command...>]
 * Default command: bin/gah (Linux/macOS) or bin\gah.ps1 via Windows
 * PowerShell (Windows), with --mode rpc, from the checkout this file sits in.
 * GAH_SKIP_SETUP=1 is set for the child: the launcher's interactive setup
 * steps write to stdout, which is the protocol channel in RPC mode.
 */

import { spawn } from "node:child_process";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { chmodSync, existsSync, readFileSync, unlinkSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "..", "..");
const REPLAY_LIMIT = 20_000; // records kept for a reconnecting page

// --- arguments ---------------------------------------------------------------
const argv = process.argv.slice(2);
const dash = argv.indexOf("--");
const own = dash >= 0 ? argv.slice(0, dash) : argv;
const opt = (name) => {
	const i = own.indexOf(name);
	return i >= 0 ? own[i + 1] : undefined;
};
const port = Number(opt("--port") ?? 8765);
const socketPath = opt("--socket");
const cwd = resolve(opt("--cwd") ?? process.cwd());
const command =
	dash >= 0
		? argv.slice(dash + 1)
		: process.platform === "win32"
			? ["powershell.exe", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", join(REPO, "bin", "gah.ps1"), "--mode", "rpc"]
			: [join(REPO, "bin", "gah"), "--mode", "rpc"];

const token = randomBytes(18).toString("base64url");
const page = readFileSync(join(HERE, "index.html"));

// --- the child ------------------------------------------------------------------
const child = spawn(command[0], command.slice(1), {
	cwd,
	env: { ...process.env, GAH_SKIP_SETUP: "1" },
	stdio: ["pipe", "pipe", "pipe"],
	windowsHide: true,
});
const records = []; // raw JSON lines, in order
const clients = new Set();
let buffered = "";

function publish(line) {
	records.push(line);
	if (records.length > REPLAY_LIMIT) records.splice(0, records.length - REPLAY_LIMIT);
	for (const res of clients) res.write(`data: ${line}\n\n`);
}

// Split on LF only: readline would also split on U+2028/U+2029, which are
// legal inside JSON strings (docs/rpc.md, "Framing").
child.stdout.setEncoding("utf8");
child.stdout.on("data", (chunk) => {
	buffered += chunk;
	let nl;
	while ((nl = buffered.indexOf("\n")) >= 0) {
		const line = buffered.slice(0, nl).replace(/\r$/, "");
		buffered = buffered.slice(nl + 1);
		// Only protocol records go to the page. A launcher that writes anything
		// else to stdout (Windows PowerShell's Write-Host can) goes to stderr.
		if (line.startsWith("{")) publish(line);
		else if (line.trim()) process.stderr.write(`gah stdout (not protocol): ${line}\n`);
	}
});
child.stderr.setEncoding("utf8");
child.stderr.on("data", (text) => process.stderr.write(text)); // diagnostics, never protocol
child.on("exit", (code, signal) => {
	publish(JSON.stringify({ type: "bridge_exit", code, signal }));
	console.error(`bridge: gah exited (${signal ?? code}); the page shows it. Ctrl+C to stop the bridge.`);
});
child.on("error", (err) => publish(JSON.stringify({ type: "bridge_exit", error: String(err) })));

// --- HTTP --------------------------------------------------------------------------
function sameToken(a) {
	const x = Buffer.from(a ?? "");
	const y = Buffer.from(token);
	return x.length === y.length && timingSafeEqual(x, y);
}
function cookieToken(req) {
	return /(?:^|;\s*)gah_bridge=([^;]+)/.exec(req.headers.cookie ?? "")?.[1];
}

const server = createServer((req, res) => {
	const url = new URL(req.url ?? "/", "http://localhost");
	// Over TCP, only a loopback Host is served: a page on some other site that
	// rebinds its name to 127.0.0.1 still sends its own name here.
	if (!socketPath && !/^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/.test(req.headers.host ?? "")) {
		res.writeHead(421).end();
		return;
	}
	const authed = sameToken(url.searchParams.get("t") ?? undefined) || sameToken(cookieToken(req));
	if (!authed) {
		res.writeHead(401, { "content-type": "text/plain" }).end("Open the URL the bridge printed (it carries a token).\n");
		return;
	}
	if (req.method === "GET" && url.pathname === "/") {
		res.writeHead(200, {
			"content-type": "text/html; charset=utf-8",
			"set-cookie": `gah_bridge=${token}; HttpOnly; SameSite=Strict; Path=/`,
			"cache-control": "no-store",
			"content-security-policy": "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:",
		});
		res.end(page);
		return;
	}
	if (req.method === "GET" && url.pathname === "/events") {
		res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive" });
		// Write at once: Node holds the headers until the first body write, and
		// with nothing to replay yet the page's EventSource would never open --
		// while the page waits for it to open before sending anything.
		res.write(": connected\n\n");
		for (const line of records) res.write(`data: ${line}\n\n`);
		clients.add(res);
		// A comment every 25 s keeps an idle SSH forward or proxy from dropping the stream.
		const beat = setInterval(() => res.write(": \n\n"), 25_000);
		req.on("close", () => {
			clearInterval(beat);
			clients.delete(res);
		});
		return;
	}
	if (req.method === "POST" && url.pathname === "/cmd") {
		// A cross-site form or fetch carries its own Origin; SameSite=Strict
		// already withholds the cookie, this is the second lock.
		const origin = req.headers.origin;
		if (origin && origin !== `http://${req.headers.host}`) {
			res.writeHead(403).end();
			return;
		}
		let body = "";
		req.setEncoding("utf8");
		req.on("data", (d) => {
			body += d;
			if (body.length > 20_000_000) req.destroy(); // images are base64; cap it
		});
		req.on("end", () => {
			try {
				const cmd = JSON.parse(body);
				if (!cmd || typeof cmd.type !== "string") throw new Error("not a command");
				// An answered dialog must not reopen when a page reconnects and the
				// stream is replayed: drop its request from the replay buffer.
				if (cmd.type === "extension_ui_response") {
					const i = records.findIndex((l) => l.includes(`"id":${JSON.stringify(cmd.id)}`) && l.includes('"extension_ui_request"'));
					if (i >= 0) records.splice(i, 1);
				}
				child.stdin.write(`${JSON.stringify(cmd)}\n`);
				res.writeHead(204).end();
			} catch (err) {
				res.writeHead(400, { "content-type": "text/plain" }).end(String(err));
			}
		});
		return;
	}
	res.writeHead(404).end();
});

if (socketPath) {
	if (existsSync(socketPath)) unlinkSync(socketPath);
	const old = process.umask(0o177);
	server.listen(socketPath, () => {
		process.umask(old);
		chmodSync(socketPath, 0o600);
		console.error(`bridge: listening on ${socketPath} (0600). From your machine:`);
		console.error(`  ssh -N -L 8765:${socketPath} <host>   then open http://127.0.0.1:8765/?t=${token}`);
	});
} else {
	server.listen(port, "127.0.0.1", () => {
		console.error(`bridge: open http://127.0.0.1:${server.address().port}/?t=${token}`);
	});
}

function shutdown() {
	child.stdin.end(); // orderly: gah exits when stdin closes (docs/rpc.md)
	setTimeout(() => child.kill(), 3000).unref();
	server.close();
	if (socketPath && existsSync(socketPath)) unlinkSync(socketPath);
	setTimeout(() => process.exit(0), 3500).unref();
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
