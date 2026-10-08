/**
 * GAH: proxy variables without a scheme (0012-proxy-env-scheme).
 */

import { describe, expect, it } from "vitest";
import { configureHttpDispatcher, gahNormalizeProxyEnv } from "../src/core/http-dispatcher.ts";

describe("gahNormalizeProxyEnv", () => {
	it("reads a value without a scheme as http://, as curl does", () => {
		const env: NodeJS.ProcessEnv = { https_proxy: "10.0.0.1:8080", HTTP_PROXY: " proxy.example:3128 " };
		gahNormalizeProxyEnv(env);
		expect(env.https_proxy).toBe("http://10.0.0.1:8080");
		expect(env.HTTP_PROXY).toBe("http://proxy.example:3128");
	});

	it("leaves a full URL and unset variables alone", () => {
		const env: NodeJS.ProcessEnv = { HTTPS_PROXY: "http://p.example:8080/", http_proxy: "" };
		gahNormalizeProxyEnv(env);
		expect(env.HTTPS_PROXY).toBe("http://p.example:8080/");
		expect(env.http_proxy).toBe("");
		expect("HTTP_PROXY" in env).toBe(false);
	});

	it("drops a value that is still not a URL", () => {
		const env: NodeJS.ProcessEnv = { https_proxy: "http://exa mple:80" };
		gahNormalizeProxyEnv(env);
		expect("https_proxy" in env).toBe(false);
	});

	it("configureHttpDispatcher no longer throws on a scheme-less https_proxy", () => {
		const saved = process.env.https_proxy;
		process.env.https_proxy = "127.0.0.1:9";
		try {
			expect(() => configureHttpDispatcher()).not.toThrow();
		} finally {
			if (saved === undefined) delete process.env.https_proxy;
			else process.env.https_proxy = saved;
		}
	});
});
