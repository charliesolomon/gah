// Unit tests for extensions/lib/usage.ts. Run: make test-policy
import assert from "node:assert/strict";
import { test } from "node:test";
import { promptTemplateName, turnUsage } from "../extensions/lib/usage.ts";

test("turnUsage reads an assistant message's tokens and cost", () => {
	const msg = {
		role: "assistant",
		model: "us.anthropic.claude-sonnet-5",
		provider: "amazon-bedrock",
		usage: { input: 2, output: 162, cacheRead: 4268, cacheWrite: 10, totalTokens: 4442, cost: { total: 0.0123 } },
	};
	assert.deepEqual(turnUsage(msg), {
		model: "us.anthropic.claude-sonnet-5",
		provider: "amazon-bedrock",
		input: 2,
		output: 162,
		cacheRead: 4268,
		cacheWrite: 10,
		totalTokens: 4442,
		cost: 0.0123,
	});
});

test("turnUsage ignores non-assistant and usage-less messages, and fills gaps with 0", () => {
	assert.equal(turnUsage({ role: "user", content: "hi" }), null);
	assert.equal(turnUsage({ role: "toolResult", toolName: "read" }), null);
	assert.equal(turnUsage(null), null);
	assert.equal(turnUsage(undefined), null);
	assert.equal(turnUsage({ role: "assistant", model: "m" }), null, "no usage object");
	const partial = turnUsage({ role: "assistant", usage: { input: 5, totalTokens: 5 } });
	assert.deepEqual(partial, { model: "", provider: "", input: 5, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 5, cost: 0 });
});

test("promptTemplateName matches a template, with or without args", () => {
	assert.equal(promptTemplateName("/morning"), "morning");
	assert.equal(promptTemplateName("/brief 18746"), "brief");
	assert.equal(promptTemplateName("/help-card"), "help-card");
	assert.equal(promptTemplateName("/daily_report now"), "daily_report");
});

test("promptTemplateName rejects plain text, skill commands, and bare slashes", () => {
	assert.equal(promptTemplateName("what's next"), null);
	assert.equal(promptTemplateName("look at /etc/hosts"), null, "slash not at start");
	assert.equal(promptTemplateName("/skill:triage"), null, "colon = skill invocation, excluded");
	assert.equal(promptTemplateName("/"), null);
	assert.equal(promptTemplateName("//"), null);
	assert.equal(promptTemplateName("/ leading space"), null);
	assert.equal(promptTemplateName(""), null);
});
