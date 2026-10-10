/**
 * GAH: the --help page (patch 0002). Renderer tests on a private env; the
 * skill counts read small skill folders made for the test.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { gahSessionRows, renderGahHelp } from "../src/cli/gah-help.ts";

const scratch = mkdtempSync(join(tmpdir(), "gah-help-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

/** A folder holding one valid skill, as pi loads it. */
function skill(parent: string, name: string): string {
	const dir = join(parent, name);
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "SKILL.md"), `---\nname: ${name}\ndescription: ${name}. Use when testing.\n---\nBody.\n`);
	return dir;
}

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
		for (const name of [
			"GAH_BUILTIN_MODELS",
			"GAH_ALLOWED_HOSTS",
			"GAH_ALLOW_TOOLS",
			"GAH_SKILLS_DIR",
			"GAH_AUDIT_LOG",
		]) {
			expect(page).toContain(name);
		}
	});

	it("reports skills a launcher passed with --skill, and says plainly when there are none", () => {
		const { GAH_SKILLS_DIR: _, ...noDir } = base;
		const passed = renderGahHelp({
			env: noDir,
			home: "/home/u",
			argv: ["node", "cli.js", "--skill", "/cache/abc/skills"],
		});
		expect(passed).toContain("/cache/abc/skills");
		const none = renderGahHelp({ env: noDir, home: "/home/u", argv: ["node", "cli.js"] });
		expect(none).toContain("none (your team's skills are not loaded)");
		expect(none).not.toContain("a session needs one");
	});

	it("hides options the policy makes inert and points at the upstream reference", () => {
		const page = renderGahHelp({ env: base, home: "/home/u" });
		for (const flag of [
			"--provider",
			"--api-key",
			"--system-prompt",
			"--extension",
			"--no-tools",
			"--offline",
			"install <source>",
		]) {
			expect(page).not.toContain(flag);
		}
		expect(page).toContain("--help --verbose");
	});

	// The launcher handles these and never passes them on, so the page can only
	// know them if the launcher says so. Listing them unconditionally is how it
	// went stale three times, and how a packaged deployment came to advertise an
	// `init` its own launcher refuses.
	it("lists the scaffolding subcommands the launcher says it handles", () => {
		const page = renderGahHelp({
			env: { ...base, GAH_SCAFFOLD_COMMANDS: "init init-kb update-kb update-skills" },
			home: "/home/u",
		});
		expect(page).toContain("gah init <directory>");
		expect(page).toContain("gah init-kb <directory>");
		expect(page).toContain("gah update-kb <directory>");
		expect(page).toContain("gah update-skills <directory>");
		expect(page).toContain("Refresh the starter skills gah maintains");
		expect(page).toContain("gah auth check");
	});

	it("lists none of them when the launcher scaffolds nothing", () => {
		const page = renderGahHelp({ env: base, home: "/home/u" });
		for (const name of ["init <directory>", "init-kb", "update-kb", "update-skills"]) {
			expect(page).not.toContain(name);
		}
		// The page is still usable: auth check works in every deployment.
		expect(page).toContain("gah auth check");
	});

	it("accepts a comma-separated list, ignores repeats, and keeps the launcher's order", () => {
		const page = renderGahHelp({
			env: { ...base, GAH_SCAFFOLD_COMMANDS: "update-skills, init, init" },
			home: "/home/u",
		});
		expect(page.indexOf("gah update-skills")).toBeLessThan(page.indexOf("gah init <directory>"));
		expect(page.match(/gah init <directory>/g)).toHaveLength(1);
	});

	it("still lists a subcommand it has no wording for, rather than hiding it", () => {
		const page = renderGahHelp({ env: { ...base, GAH_SCAFFOLD_COMMANDS: "init-future" }, home: "/home/u" });
		expect(page).toContain("gah init-future <directory>");
		expect(page).toContain("handled by the launcher");
	});

	it("describes deny-all and unrestricted network states plainly", () => {
		expect(renderGahHelp({ env: { ...base, GAH_ALLOWED_HOSTS: "" }, home: "/home/u" })).toContain("none (deny all)");
		expect(renderGahHelp({ env: { ...base, GAH_ALLOWED_HOSTS: "*" }, home: "/home/u" })).toContain(
			"any (no restriction)",
		);
		const { GAH_ALLOWED_HOSTS: _h, ...unset } = base;
		expect(renderGahHelp({ env: unset, home: "/home/u" })).toContain("none (deny all)");
	});

	it("mentions the AWS variables only when Bedrock is allowlisted", () => {
		expect(renderGahHelp({ env: base, home: "/home/u" })).not.toContain("AWS_PROFILE");
		expect(
			renderGahHelp({ env: { ...base, GAH_BUILTIN_MODELS: "amazon-bedrock/us.anthropic.*" }, home: "/home/u" }),
		).toContain("AWS_PROFILE");
	});

	it("says when the policy pack is not loaded, and lists extension flags", () => {
		const { GAH_EFFECTIVE_TOOLS: _t, ...noPolicy } = base;
		expect(renderGahHelp({ env: noPolicy, home: "/home/u" })).toContain("policy pack not loaded");
		const page = renderGahHelp({
			env: base,
			home: "/home/u",
			extensionFlags: [{ name: "plan", type: "boolean", description: "Start in plan mode" }],
		});
		expect(page).toContain("--plan");
		expect(page).toContain("Start in plan mode");
	});

	// #142: the shared host passes every skill folder with its own --skill.
	describe("the Skills row", () => {
		const skillsRow = (env: NodeJS.ProcessEnv, argv: string[]) =>
			gahSessionRows({ env, home: "/home/u", argv: ["node", "cli.js", ...argv] }).find((r) => r.key === "skills")!
				.value;
		const { GAH_SKILLS_DIR: _, ...noDir } = base;

		it("counts a folder of skills the way pi loads them, nested ones included", () => {
			const folder = join(scratch, "repo", "skills");
			skill(folder, "a");
			skill(folder, "b");
			skill(join(folder, "group"), "c");
			mkdirSync(join(folder, "not-a-skill"), { recursive: true });
			expect(skillsRow(noDir, ["--skill", folder])).toBe(`${folder} (3 skills)`);
		});

		it("counts skills passed one by one under their folder, and keeps a lone one's path", () => {
			const shared = join(scratch, "host", "skills");
			const mine = join(scratch, "host", "my-skills");
			const argv = [
				"--skill",
				skill(mine, "notes"),
				"--skill",
				skill(shared, "brief"),
				"--skill",
				skill(shared, "triage"),
			];
			expect(skillsRow(noDir, argv)).toBe(`${join(mine, "notes")}, ${shared} (2 skills)`);
		});

		it("says when a skill folder is missing or holds no skills", () => {
			const empty = join(scratch, "empty");
			mkdirSync(empty, { recursive: true });
			expect(skillsRow(noDir, ["--skill", join(scratch, "nowhere"), "--skill", empty])).toBe(
				`${join(scratch, "nowhere")} (missing), ${empty} (no skills)`,
			);
		});

		it("includes the folder a skills fetch added during the session", () => {
			const fetched = join(scratch, "fetched");
			skill(join(fetched, "skills"), "x");
			expect(skillsRow({ ...noDir, GAH_SESSION_SKILLS_DIR: fetched }, [])).toBe(
				`${join(fetched, "skills")} (1 skill)`,
			);
		});
	});

	describe("gahSessionRows, shared with /help in a session (#142)", () => {
		it("returns the page's rows in its order, with every value on the page", () => {
			const rows = gahSessionRows({ env: base, home: "/home/u" });
			expect(rows.map((r) => r.key)).toEqual(["tools", "models", "endpoints", "network", "skills", "audit"]);
			const page = renderGahHelp({ env: base, home: "/home/u" });
			for (const r of rows) {
				expect(page).toContain(r.value);
				if (r.note) expect(page).toContain(r.note);
			}
		});

		it("marks the endpoints file absent only when it is", () => {
			const endpoints = (env: NodeJS.ProcessEnv) =>
				gahSessionRows({ env, home: "/home/u" }).find((r) => r.key === "endpoints")!;
			expect(endpoints({ ...base, GAH_PROVIDERS_FILE: join(scratch, "none.json") }).absent).toBe(true);
			const file = join(scratch, "providers.json");
			writeFileSync(file, "{}");
			expect(endpoints({ ...base, GAH_PROVIDERS_FILE: file })).toMatchObject({ value: file, absent: false });
		});
	});

	describe("on the shared host (#142)", () => {
		const page = renderGahHelp({
			env: { ...base, GAH_LAUNCHER_KIND: "host", GAH_SCAFFOLD_COMMANDS: "init init-kb update-kb update-skills" },
			home: "/home/u",
			extensionFlags: [{ name: "plan", type: "boolean", description: "Start in plan mode" }],
		});

		it("shows the session's rows and where to go next", () => {
			expect(page).toContain("This session");
			expect(page).toContain("read, grep, find, ls, edit, write");
			expect(page).toContain("On this host");
			expect(page).toContain("/help");
			expect(page).toContain("gah-launch --help");
			expect(page).toContain("set up by the administrator");
			expect(page).toContain("Documentation:");
		});

		it("lists nothing anyone there could type: no usage, options, flags or examples", () => {
			for (const text of [
				"Usage:",
				"Options:",
				"Environment:",
				"Examples:",
				"--continue",
				"--list-models",
				"--help --verbose",
				"gah auth check",
				"gah init <directory>",
				"--plan",
			]) {
				expect(page).not.toContain(text);
			}
		});
	});
});
