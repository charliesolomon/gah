/**
 * GAH: /login never saves an empty API key (0015-login-empty-key).
 */

import type { AuthInteraction, Model, Provider } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { ModelRuntime } from "../src/core/model-runtime.ts";

const model: Model<"openai-completions"> = {
	id: "m",
	name: "M",
	api: "openai-completions",
	provider: "corp",
	baseUrl: "https://example.test/v1",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 1000,
	maxTokens: 100,
};

const corp: Provider<"openai-completions"> = {
	id: "corp",
	name: "corp",
	auth: {
		apiKey: {
			name: "API key",
			login: async (interaction: AuthInteraction) => ({
				type: "api_key",
				key: await interaction.prompt({ type: "secret", message: "Enter API key" }),
			}),
			check: async ({ credential }) => (credential?.key ? { type: "api_key", source: "stored" } : undefined),
			resolve: async ({ credential }) =>
				credential?.key ? { auth: { apiKey: credential.key }, source: "stored" } : undefined,
		},
	},
	getModels: () => [model],
	stream: () => {
		throw new Error("unused");
	},
	streamSimple: () => {
		throw new Error("unused");
	},
};

async function setup() {
	const credentials = AuthStorage.inMemory();
	const runtime = await ModelRuntime.create({ credentials, modelsPath: null, allowModelNetwork: false });
	runtime.registerNativeProvider(corp);
	await runtime.refresh({ allowNetwork: false, providers: ["corp"] });
	return { credentials, runtime };
}
const typed = (value: string): AuthInteraction => ({ prompt: async () => value, notify: () => {} });

describe("login with an empty API key", () => {
	it("is refused and leaves a working key in place", async () => {
		const { credentials, runtime } = await setup();
		await runtime.login("corp", "api_key", typed("good-key"));
		for (const empty of ["", "   ", "\n"]) {
			await expect(runtime.login("corp", "api_key", typed(empty))).rejects.toThrow(/no API key was entered/);
		}
		expect(await credentials.read("corp")).toEqual({ type: "api_key", key: "good-key" });
		expect(runtime.getAvailableSnapshot().some((m) => m.provider === "corp")).toBe(true);
	});

	it("trims what was pasted", async () => {
		const { credentials, runtime } = await setup();
		await runtime.login("corp", "api_key", typed("  pasted-key\n"));
		expect(await credentials.read("corp")).toEqual({ type: "api_key", key: "pasted-key" });
	});
});
