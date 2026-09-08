// Unit tests for scripts/add-provider.mjs pure helpers. Run: make test-policy
import assert from "node:assert/strict";
import { test } from "node:test";
import { buildProvider, mergeProvider } from "../../../scripts/add-provider.mjs";

test("buildProvider produces a schema-valid entry (openai-responses, env-var key)", () => {
	const p = buildProvider({
		name: "corp",
		baseUrl: "https://inference.example.com/v1",
		api: "openai-responses",
		apiKey: "$CORP_API_KEY",
		ids: ["gpt-4o-corp", "o4-mini-corp"],
		reasoning: true,
		image: false,
		contextWindow: 200000,
		maxTokens: 32768,
	});
	assert.equal(p.name, "corp");
	assert.equal(p.api, "openai-responses");
	assert.equal(p.apiKey, "$CORP_API_KEY");
	assert.equal(p.models.length, 2);
	// Every field the policy pack's provider loader requires on a model.
	for (const m of p.models) {
		for (const k of ["id", "name", "reasoning", "input", "cost", "contextWindow", "maxTokens"]) assert.ok(k in m, `model missing ${k}`);
		assert.deepEqual(m.input, ["text"]);
		assert.deepEqual(m.cost, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
	}
	assert.deepEqual(p.models.map((m) => m.id), ["gpt-4o-corp", "o4-mini-corp"]);
});

test("buildProvider omits apiKey for /login, and adds image input when asked", () => {
	const login = buildProvider({ name: "c", baseUrl: "u", api: "openai-responses", apiKey: undefined, ids: ["m"], reasoning: false, image: true, contextWindow: 1, maxTokens: 1 });
	assert.ok(!("apiKey" in login), "no apiKey key when omitted");
	assert.deepEqual(login.models[0].input, ["text", "image"]);
});

test("mergeProvider appends a new provider and replaces one of the same name", () => {
	const a = buildProvider({ name: "corp", baseUrl: "u1", api: "openai-responses", apiKey: undefined, ids: ["m1"], reasoning: false, image: false, contextWindow: 1, maxTokens: 1 });
	const empty = { providers: [] };
	const r1 = mergeProvider(empty, a);
	assert.equal(r1.existed, false);
	assert.equal(r1.config.providers.length, 1);

	const other = buildProvider({ name: "other", baseUrl: "u2", api: "openai-completions", apiKey: undefined, ids: ["m2"], reasoning: false, image: false, contextWindow: 1, maxTokens: 1 });
	const r2 = mergeProvider(r1.config, other);
	assert.equal(r2.existed, false);
	assert.deepEqual(r2.config.providers.map((p) => p.name), ["corp", "other"]);

	const corpV2 = buildProvider({ name: "corp", baseUrl: "u1-new", api: "openai-responses", apiKey: undefined, ids: ["m1b"], reasoning: false, image: false, contextWindow: 1, maxTokens: 1 });
	const r3 = mergeProvider(r2.config, corpV2);
	assert.equal(r3.existed, true);
	assert.equal(r3.config.providers.length, 2, "replaced, not appended");
	assert.equal(r3.config.providers.find((p) => p.name === "corp").baseUrl, "u1-new");
	assert.deepEqual(r3.config.providers.map((p) => p.name), ["corp", "other"], "order preserved");
});

test("mergeProvider tolerates a config with no providers array", () => {
	const p = buildProvider({ name: "x", baseUrl: "u", api: "openai-responses", apiKey: undefined, ids: ["m"], reasoning: false, image: false, contextWindow: 1, maxTokens: 1 });
	assert.equal(mergeProvider({}, p).config.providers.length, 1);
	assert.equal(mergeProvider(null, p).config.providers.length, 1);
});
