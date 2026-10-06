/**
 * GAH: the built-in model allowlist (0010) and the provider surface it
 * implies. Runs without network or stored credentials.
 */

import { type AnyModel, InMemoryCredentialStore } from "@earendil-works/pi-ai";
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

/**
 * The raw anthropic built-in with one image and one classifier model added.
 * GAH's seed ships chat models only, so the other two types are synthetic;
 * registered under a built-in id, they take the same re-wrap path as any
 * native re-registration.
 */
function anthropicWithEveryType() {
	const raw = builtinProviders().find((p) => p.id === "anthropic")!;
	const base = { provider: "anthropic", baseUrl: "https://api.anthropic.com", input: ["text"] as ("text" | "image")[] };
	const cost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
	const image = { ...base, type: "image", id: "gah-test-image", name: "Image", api: "openrouter-images", output: ["image"], cost };
	const classifier = { ...base, type: "classifier", id: "gah-test-classifier", name: "Classifier", api: "system-one", contextWindow: 1000, cost };
	const provider = {
		...raw,
		getAllModels: () => [...raw.getModels(), image, classifier] as unknown as readonly AnyModel[],
	};
	return { provider, image, classifier };
}

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

	// v0.99 added image and classifier models beside chat, read through
	// getAllModels(). That list carries chat models too, so it has to be
	// filtered like getModels() or every read of every type fails open.
	it("deny-all exposes no models of any type", async () => {
		const runtime = await runtimeWith(undefined);
		expect(runtime.getAllModels()).toHaveLength(0);
		expect(runtime.getModelsOfType("chat")).toHaveLength(0);
		expect(runtime.getModelsOfType("image")).toHaveLength(0);
		expect(runtime.getModelsOfType("classifier")).toHaveLength(0);
		expect(await runtime.getAllAvailable()).toHaveLength(0);
	});

	it("filters getAllModels() by the same allowlist as getModels()", async () => {
		const runtime = await runtimeWith("anthropic/claude-sonnet-4-6");
		expect(runtime.getAllModels().map((m) => `${m.provider}/${m.id}`)).toEqual(["anthropic/claude-sonnet-4-6"]);
	});

	for (const type of ["image", "classifier"] as const) {
		it(`allows a ${type} model only when the allowlist names it`, async () => {
			const runtime = await runtimeWith(undefined);
			const everyType = anthropicWithEveryType();
			runtime.registerNativeProvider(everyType.provider as never);
			expect(runtime.getModelsOfType(type)).toHaveLength(0);
			expect(runtime.getProvider("anthropic")).toBeUndefined();

			const target = everyType[type];
			process.env.GAH_BUILTIN_MODELS = `anthropic/${target.id}`;
			expect(runtime.getModelsOfType(type).map((m) => m.id)).toEqual([target.id]);
			expect(runtime.getModelOfType(type, "anthropic", target.id)?.id).toBe(target.id);
			expect(runtime.getModelsOfType("chat")).toHaveLength(0);
			expect(providerIds(runtime)).toEqual(["anthropic"]);
		});
	}

	// The model a request carries is the caller's object, not a catalogue
	// lookup, so the dispatch path checks it too.
	it("refuses to dispatch a chat model the allowlist denies", async () => {
		const runtime = await runtimeWith("anthropic/claude-sonnet-4-6");
		const raw = builtinProviders().find((p) => p.id === "anthropic")!;
		const denied = raw.getModels().find((m) => m.id !== "claude-sonnet-4-6")!;
		const result = await runtime.completeSimple(denied, { messages: [] });
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toMatch(/not allowed by GAH_BUILTIN_MODELS/);
	});

	it("refuses to dispatch a denied image or classifier model", async () => {
		const runtime = await runtimeWith(undefined);
		const { image, classifier } = anthropicWithEveryType();
		const images = await runtime.generateImages(image as never, { prompt: "x" } as never);
		expect(images.stopReason).toBe("error");
		expect(images.errorMessage).toMatch(/not allowed by GAH_BUILTIN_MODELS/);
		const classified = await runtime.classify(classifier as never, {} as never);
		expect(classified.stopReason).toBe("error");
		expect(classified.errorMessage).toMatch(/not allowed by GAH_BUILTIN_MODELS/);
	});
});
