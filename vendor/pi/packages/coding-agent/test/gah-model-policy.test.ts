/**
 * GAH: the built-in model allowlist (0010) and the provider surface it
 * implies. Runs without network or stored credentials.
 */

import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import { afterEach, describe, expect, it } from "vitest";
import { ModelRuntime } from "../src/core/model-runtime.ts";

const saved = process.env.GAH_BUILTIN_MODELS;
afterEach(() => {
	if (saved === undefined) delete process.env.GAH_BUILTIN_MODELS;
	else process.env.GAH_BUILTIN_MODELS = saved;
});

async function runtimeWith(allowlist: string | undefined): Promise<ModelRuntime> {
	if (allowlist === undefined) delete process.env.GAH_BUILTIN_MODELS;
	else process.env.GAH_BUILTIN_MODELS = allowlist;
	return ModelRuntime.create({
		credentials: new InMemoryCredentialStore(),
		modelsPath: null,
		allowModelNetwork: false,
	});
}

const providerIds = (runtime: ModelRuntime) => runtime.getProviders().map((p) => p.id).sort();

function testModel(id: string) {
	return {
		id,
		name: id,
		reasoning: false,
		input: ["text"] as ("text" | "image")[],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 10000,
		maxTokens: 1000,
	};
}

describe("GAH model policy", () => {
	it("deny-all exposes no models and no providers", async () => {
		const runtime = await runtimeWith(undefined);
		expect(runtime.getModels()).toHaveLength(0);
		expect(providerIds(runtime)).toEqual([]);
		expect(runtime.getProvider("anthropic")).toBeUndefined();
	});

	it("shows exactly the providers with an allowed model", async () => {
		const runtime = await runtimeWith("anthropic/*,amazon-bedrock/us.anthropic.*");
		expect(providerIds(runtime)).toEqual(["amazon-bedrock", "anthropic"]);
		expect(runtime.getProvider("anthropic")?.id).toBe("anthropic");
		expect(runtime.getProvider("openai")).toBeUndefined();
		for (const model of runtime.getModels("amazon-bedrock")) {
			expect(model.id.startsWith("us.anthropic.")).toBe(true);
		}
	});

	it("hides a provider whose allowlist entry matches nothing", async () => {
		const runtime = await runtimeWith("anthropic/no-such-model");
		expect(providerIds(runtime)).toEqual([]);
	});

	it("keeps extension-registered providers visible under deny-all", async () => {
		const runtime = await runtimeWith(undefined);
		runtime.registerProvider("corp", {
			baseUrl: "https://corp.example.invalid/v1",
			api: "openai-completions",
			apiKey: "x",
			models: [testModel("corp-model")],
		});
		expect(providerIds(runtime)).toEqual(["corp"]);
		expect(runtime.getModels("corp").map((m) => m.id)).toEqual(["corp-model"]);
	});

	it("keeps native providers under new ids visible under deny-all", async () => {
		const runtime = await runtimeWith(undefined);
		const raw = builtinProviders().find((p) => p.id === "anthropic")!;
		const model = { ...testModel("corp-native-model"), api: "anthropic-messages" as const, provider: "corp-native", baseUrl: "https://corp.example.invalid" };
		runtime.registerNativeProvider({ ...raw, id: "corp-native", name: "Corp Native", getModels: () => [model] });
		expect(providerIds(runtime)).toEqual(["corp-native"]);
		expect(runtime.getModels("corp-native").map((m) => m.id)).toEqual(["corp-native-model"]);
	});

	it("re-applies the allowlist to a built-in re-registered as a native provider", async () => {
		// What the policy pack does to strip OAuth flows when providers.json is
		// present: registerProvider({ ...rawBuiltin, auth: withoutOAuth }).
		const runtime = await runtimeWith(undefined);
		const raw = builtinProviders().find((p) => p.id === "anthropic")!;
		const { oauth: _oauth, ...auth } = raw.auth;
		runtime.registerNativeProvider({ ...raw, auth });
		expect(runtime.getModels("anthropic")).toHaveLength(0);
		expect(runtime.getProvider("anthropic")).toBeUndefined();

		process.env.GAH_BUILTIN_MODELS = "anthropic/claude-sonnet-4-6";
		expect(runtime.getModels("anthropic").map((m) => m.id)).toEqual(["claude-sonnet-4-6"]);
		expect(runtime.getProvider("anthropic")?.auth.oauth).toBeUndefined();
	});
});
