/**
 * GAH: the network egress allowlist (0011-egress-allowlist). Runs against a
 * local HTTP server only; nothing leaves the machine.
 */

import { readFileSync, rmSync } from "node:fs";
import http from "node:http";
import http2 from "node:http2";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { gahAllowsHost, GahEgressError } from "../src/core/gah-egress.ts";
import { configureHttpDispatcher } from "../src/core/http-dispatcher.ts";

const savedHosts = process.env.GAH_ALLOWED_HOSTS;
const savedAudit = process.env.GAH_AUDIT_LOG;
const auditPath = join(tmpdir(), `gah-egress-audit-${process.pid}.log`);

let server: http.Server;
let port: number;

beforeAll(async () => {
	process.env.GAH_AUDIT_LOG = auditPath;
	server = http.createServer((_req, res) => res.end("hello")).listen(0, "127.0.0.1");
	await new Promise<void>((resolve) => server.once("listening", resolve));
	port = (server.address() as { port: number }).port;
	configureHttpDispatcher();
});

afterAll(() => {
	server.close();
	rmSync(auditPath, { force: true });
	if (savedHosts === undefined) delete process.env.GAH_ALLOWED_HOSTS;
	else process.env.GAH_ALLOWED_HOSTS = savedHosts;
	if (savedAudit === undefined) delete process.env.GAH_AUDIT_LOG;
	else process.env.GAH_AUDIT_LOG = savedAudit;
});

afterEach(() => {
	delete process.env.GAH_ALLOWED_HOSTS;
});

function nodeGet(url: string): Promise<string> {
	return new Promise((resolve, reject) => {
		try {
			http.get(url, (res) => {
				let body = "";
				res.on("data", (c) => (body += c));
				res.on("end", () => resolve(body));
			}).on("error", reject);
		} catch (error) {
			reject(error);
		}
	});
}

describe("GAH egress allowlist", () => {
	it("matches hostname globs, case-insensitively, hostname only", () => {
		process.env.GAH_ALLOWED_HOSTS = "api.anthropic.com, *.amazonaws.com";
		expect(gahAllowsHost("api.anthropic.com")).toBe(true);
		expect(gahAllowsHost("API.Anthropic.COM")).toBe(true);
		expect(gahAllowsHost("bedrock-runtime.us-west-1.amazonaws.com")).toBe(true);
		expect(gahAllowsHost("evil-amazonaws.com")).toBe(false);
		expect(gahAllowsHost("api.anthropic.com.evil.example")).toBe(false);
		expect(gahAllowsHost("platform.claude.com")).toBe(false);
	});

	it("denies everything when unset or empty, allows everything for *", () => {
		delete process.env.GAH_ALLOWED_HOSTS;
		expect(gahAllowsHost("api.anthropic.com")).toBe(false);
		process.env.GAH_ALLOWED_HOSTS = "";
		expect(gahAllowsHost("api.anthropic.com")).toBe(false);
		process.env.GAH_ALLOWED_HOSTS = "*";
		expect(gahAllowsHost("anything.example")).toBe(true);
	});

	it("blocks fetch (undici) to a host that is not allowlisted, and audits it once", async () => {
		process.env.GAH_ALLOWED_HOSTS = "";
		const url = `http://127.0.0.1:${port}/`;
		for (let i = 0; i < 2; i++) {
			await expect(fetch(url)).rejects.toSatisfy((error: unknown) => {
				const cause = (error as { cause?: unknown }).cause;
				return cause instanceof GahEgressError && cause.host === "127.0.0.1" && cause.via === "undici";
			});
		}
		const lines = readFileSync(auditPath, "utf8").trim().split("\n");
		const blocked = lines.map((l) => JSON.parse(l)).filter((e) => e.kind === "egress_blocked" && e.host === "127.0.0.1");
		expect(blocked).toHaveLength(1);
	});

	it("blocks node:http requests that bypass undici", async () => {
		process.env.GAH_ALLOWED_HOSTS = "";
		await expect(nodeGet(`http://127.0.0.1:${port}/`)).rejects.toBeInstanceOf(GahEgressError);
		expect(() => http.request({ hostname: "127.0.0.1", port, path: "/" })).toThrow(GahEgressError);
		expect(() => http.request({ host: "127.0.0.1:443", path: "/" })).toThrow(GahEgressError);
	});

	it("blocks node:http2 sessions that bypass undici", () => {
		process.env.GAH_ALLOWED_HOSTS = "";
		expect(() => http2.connect(`http://127.0.0.1:${port}`)).toThrow(GahEgressError);
	});

	it("lets allowlisted hosts through on every path", async () => {
		process.env.GAH_ALLOWED_HOSTS = "127.0.0.1";
		expect(await (await fetch(`http://127.0.0.1:${port}/`)).text()).toBe("hello");
		expect(await nodeGet(`http://127.0.0.1:${port}/`)).toBe("hello");
		const session = http2.connect(`http://127.0.0.1:${port}`);
		session.on("error", () => {}); // the test server is HTTP/1.1; only the policy decision is under test
		session.destroy();
	});

	it("re-reads the allowlist on every request", async () => {
		process.env.GAH_ALLOWED_HOSTS = "";
		await expect(fetch(`http://127.0.0.1:${port}/`)).rejects.toThrow();
		process.env.GAH_ALLOWED_HOSTS = "127.0.0.1";
		expect((await fetch(`http://127.0.0.1:${port}/`)).ok).toBe(true);
	});
});
