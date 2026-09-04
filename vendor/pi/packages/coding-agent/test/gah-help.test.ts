/**
 * GAH: the --help page (0003-gah-help). Pure renderer tests on a private env.
 */

import { describe, expect, it } from "vitest";
import { renderGahHelp } from "../src/cli/gah-help.ts";

const base: NodeJS.ProcessEnv = {
	GAH_EFFECTIVE_TOOLS: "read,grep,find,ls,edit,write",
	GAH_BUILTIN_MODELS: "anthropic/*",
	GAH_ALLOWED_HOSTS: "api.anthropic.com,platform.claude.com",
	GAH_SKILLS_DIR: "/srv/skills",
};

describe("GAH help page", () => {
	it("frames GAH as a harness and reports the session's effective policy", () => {
		const page = renderGahHelp({ env: base, home: "/home/u" });
		expect(page).toContain("Good agent harness");
		expect(page).not.toMatch(/coding assistant/i);
		expect(page).toContain("read, grep, find, ls, edit, write");
		expect(page).toContain("anthropic/*");
		expect(page).toContain("api.anthropic.com, platform.claude.com");
		expect(page).toContain("/srv/skills");
		expect(page).toContain("/home/u/.gah/audit.log");
	});

	it("documents GAH_* variables only: no PI_* names, no provider API keys, no /share", () => {
		const page = renderGahHelp({ env: base, home: "/home/u" });
		expect(page).not.toContain("PI_");
		expect(page).not.toContain("API_KEY");
		expect(page).not.toContain("share");
		for (const name of ["GAH_BUILTIN_MODELS", "GAH_ALLOWED_HOSTS", "GAH_ALLOW_TOOLS", "GAH_SKILLS_DIR", "GAH_AUDIT_LOG"]) {
			expect(page).toContain(name);
		}
	});

	it("hides options the policy makes inert and points at the upstream reference", () => {
		const page = renderGahHelp({ env: base, home: "/home/u" });
		for (const flag of ["--provider", "--api-key", "--system-prompt", "--extension", "--no-tools", "--offline", "install <source>"]) {
			expect(page).not.toContain(flag);
		}
		expect(page).toContain("--help --verbose");
	});

	it("describes deny-all and unrestricted network states plainly", () => {
		expect(renderGahHelp({ env: { ...base, GAH_ALLOWED_HOSTS: "" }, home: "/home/u" })).toContain("none (deny all)");
		expect(renderGahHelp({ env: { ...base, GAH_ALLOWED_HOSTS: "*" }, home: "/home/u" })).toContain("any (no restriction)");
		const { GAH_ALLOWED_HOSTS: _h, ...unset } = base;
		expect(renderGahHelp({ env: unset, home: "/home/u" })).toContain("none (deny all)");
	});

	it("mentions the AWS variables only when Bedrock is allowlisted", () => {
		expect(renderGahHelp({ env: base, home: "/home/u" })).not.toContain("AWS_PROFILE");
		expect(renderGahHelp({ env: { ...base, GAH_BUILTIN_MODELS: "amazon-bedrock/us.anthropic.*" }, home: "/home/u" })).toContain("AWS_PROFILE");
	});

	it("says when the policy pack is not loaded, and lists extension flags", () => {
		const { GAH_EFFECTIVE_TOOLS: _t, ...noPolicy } = base;
		expect(renderGahHelp({ env: noPolicy, home: "/home/u" })).toContain("policy pack not loaded");
		const page = renderGahHelp({ env: base, home: "/home/u", extensionFlags: [{ name: "plan", type: "boolean", description: "Start in plan mode" }] });
		expect(page).toContain("--plan");
		expect(page).toContain("Start in plan mode");
	});
});
