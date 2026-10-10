/**
 * GAH: the --help page.
 *
 * Upstream's help is one large template in args.ts describing everything pi
 * can do: a package manager, credential printers, thirty provider API keys,
 * flags the GAH policy makes inert. For the people GAH targets that page is
 * mostly false -- it says bash is on and grep is off, that the default
 * provider is google, that PI_OFFLINE exists -- and args.ts changes every
 * release, so correcting it in place would be a recurring sync cost (#32).
 *
 * This module renders a short page from what is actually true in this
 * process: the environment the launcher set (GAH_*), the tool allowlist the
 * policy pack enforces (exported by policy.ts as GAH_EFFECTIVE_TOOLS at
 * extension load, which happens before help prints), and the extension
 * flags that registered. Upstream's full reference stays one flag away:
 * `gah --help --verbose`.
 *
 * The "This session" rows are also the policy pack's /help, for people who
 * never see a command line (#142): gahSessionRows is exported from the package
 * index, so the command and this page cannot disagree. On the shared host
 * (GAH_LAUNCHER_KIND=host) nobody can pass options, so the page is those rows
 * and where to go next, with no usage, options or examples.
 *
 * printHelp() in args.ts delegates here with a one-line hunk.
 */

import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import chalk from "chalk";
import { APP_NAME, CONFIG_DIR_NAME, ENV_AGENT_DIR, ENV_SESSION_DIR, VERSION } from "../config.ts";
import { loadSkillsFromDir } from "../core/skills.ts";

interface HelpExtensionFlag {
	name: string;
	type?: string;
	description?: string;
	extensionPath?: string;
}

export interface GahHelpOptions {
	env?: NodeJS.ProcessEnv;
	/** The command line, for the --skill paths a launcher passed. */
	argv?: readonly string[];
	extensionFlags?: readonly HelpExtensionFlag[];
	/** Home directory used to describe default paths. */
	home?: string;
}

/** One row of the "This session" section. */
export interface GahSessionRow {
	/** Stable name, for a caller that shows only some rows. */
	key: "tools" | "models" | "endpoints" | "network" | "skills" | "audit";
	label: string;
	value: string;
	/** Where the value comes from and how to change it, for the --help page. */
	note?: string;
	/** Set when the row names something this session does not have: an endpoints file that is absent. */
	absent?: boolean;
}

const COL = 34;

function row(name: string, description: string): string {
	return `  ${name.padEnd(COL)}${description}`;
}

function describeList(value: string | undefined, whenEmpty: string): string {
	const items = (value ?? "")
		.split(",")
		.map((s) => s.trim())
		.filter(Boolean);
	return items.length > 0 ? items.join(", ") : whenEmpty;
}

/**
 * The scaffolding subcommands, described.
 *
 * These are handled by the launcher, not by this process: it intercepts the
 * token before exec and never passes it on. So the CLI cannot discover them,
 * and listing them here unconditionally is how the page went stale three times
 * -- init-kb, update-kb and update-skills were each added to the launchers
 * without anyone editing this file, while `init` was advertised even in
 * packaged deployments, where the launcher refuses it because the templates it
 * copies are not shipped there.
 *
 * So the launcher publishes what it handles, in GAH_SCAFFOLD_COMMANDS, and this
 * renders exactly that. A launcher that scaffolds nothing sets nothing and the
 * section disappears, which is the honest page for an installed package.
 *
 * The names come from the launcher and the wording from here, so a subcommand
 * added to a launcher appears immediately, at worst under the generic
 * description below. scripts/check-skills.sh fails if one ships that way.
 */
const SCAFFOLD_DESCRIPTIONS: Record<string, string> = {
	init: "Create your organisation's skills repository (once)",
	"init-kb": "Create a knowledge base repository (optional)",
	"update-kb": "Refresh a knowledge base's scripts and skills, leaving articles alone",
	"update-skills": "Refresh the starter skills gah maintains, leaving your own alone",
};

/** Usage lines for whatever the launcher said it handles, in its order. */
function scaffoldUsage(app: string, value: string | undefined): string {
	const names = (value ?? "")
		.split(/[,\s]+/)
		.map((s) => s.trim())
		.filter(Boolean);
	const seen = new Set<string>();
	return names
		.filter((name) => (seen.has(name) ? false : (seen.add(name), true)))
		.map((name) =>
			row(
				`${app} ${name} <directory>`,
				SCAFFOLD_DESCRIPTIONS[name] ?? "Scaffolding subcommand handled by the launcher",
			),
		)
		.join("\n");
}

/** The --skill paths on a command line, in order. */
function skillArgs(argv: readonly string[]): string[] {
	const out: string[] = [];
	for (let i = 0; i < argv.length - 1; i++) if (argv[i] === "--skill") out.push(argv[i + 1]!);
	return out;
}

/**
 * The skill paths this process was given: GAH_SKILLS_DIR (a checkout), each
 * --skill (the packages and the shared host), and the folder an in-session
 * skills fetch added (GAH_SESSION_SKILLS_DIR, set by the policy pack).
 */
function skillPaths(env: NodeJS.ProcessEnv, argv: readonly string[]): string[] {
	const paths = [
		...(env.GAH_SKILLS_DIR ? [env.GAH_SKILLS_DIR] : []),
		...skillArgs(argv),
		...(env.GAH_SESSION_SKILLS_DIR ? [join(env.GAH_SESSION_SKILLS_DIR, "skills")] : []),
	];
	return [...new Set(paths)];
}

/** A skill on its own: a folder holding SKILL.md, or a Markdown file. */
function isOneSkill(path: string): boolean {
	try {
		return statSync(path).isFile() ? path.endsWith(".md") : existsSync(join(path, "SKILL.md"));
	} catch {
		return false;
	}
}

/** How many skills pi loads from a path, by pi's own rules; undefined when the path does not exist. */
function skillCount(path: string): number | undefined {
	try {
		if (!existsSync(path)) return undefined;
		if (statSync(path).isFile()) return path.endsWith(".md") ? 1 : 0;
		return loadSkillsFromDir({ dir: path, source: "path" }).skills.length;
	} catch {
		return undefined;
	}
}

/**
 * The skill paths as one line. The shared host passes every skill folder with
 * its own --skill, so skills from one folder are counted under it rather than
 * listed: "<folder> (12 skills)". A skill passed alone keeps its own path.
 */
function describeSkills(paths: readonly string[]): string {
	const groups = new Map<string, { count: number; missing: boolean; alone: string[] }>();
	const group = (folder: string) => {
		let g = groups.get(folder);
		if (!g) {
			g = { count: 0, missing: false, alone: [] };
			groups.set(folder, g);
		}
		return g;
	};
	for (const path of paths) {
		const n = skillCount(path);
		if (isOneSkill(path)) {
			const g = group(dirname(path));
			g.alone.push(path);
			g.count += n ?? 0;
		} else if (n === undefined) {
			group(path).missing = true;
		} else {
			group(path).count += n;
		}
	}
	return [...groups]
		.map(([folder, g]) => {
			const name = g.alone.length === 1 ? g.alone[0]! : folder;
			if (g.alone.length === 1 && g.count === 1) return name;
			if (g.count > 0) return `${folder} (${g.count} skill${g.count === 1 ? "" : "s"})`;
			return `${name} (${g.missing ? "missing" : "no skills"})`;
		})
		.join(", ");
}

/**
 * What this process may use, as the "This session" rows: here, and in the
 * policy pack's /help through the package index. Reads the skill folders to
 * count them; otherwise pure, everything comes from `options`.
 */
export function gahSessionRows(options: GahHelpOptions = {}): GahSessionRow[] {
	const env = options.env ?? process.env;
	const home = options.home ?? homedir();
	const host = env.GAH_LAUNCHER_KIND === "host";
	const gahDir = join(home, `.${APP_NAME}`);
	const providersFile = env.GAH_PROVIDERS_FILE || join(gahDir, "providers.json");
	const providersPresent = existsSync(providersFile);

	const tools = env.GAH_EFFECTIVE_TOOLS
		? describeList(env.GAH_EFFECTIVE_TOOLS, "none")
		: "(policy pack not loaded -- run through bin/gah)";
	const hosts =
		env.GAH_ALLOWED_HOSTS === undefined || env.GAH_ALLOWED_HOSTS.trim() === ""
			? "none (deny all)"
			: env.GAH_ALLOWED_HOSTS.trim() === "*"
				? "any (no restriction)"
				: describeList(env.GAH_ALLOWED_HOSTS, "none");
	const paths = skillPaths(env, options.argv ?? []);

	return [
		{
			key: "tools",
			label: "Tools",
			value: tools,
			note: "GAH_ALLOW_TOOLS adds more; every call is written to the audit log",
		},
		{
			key: "models",
			label: "Models",
			value: describeList(env.GAH_BUILTIN_MODELS, "none from the built-in catalogue"),
			note: host
				? "GAH_BUILTIN_MODELS; /model in a session to choose"
				: "GAH_BUILTIN_MODELS; /model to choose, --list-models to see",
		},
		{
			key: "endpoints",
			label: "Endpoints file",
			value: providersPresent ? providersFile : `${providersFile} (absent)`,
			note: "GAH_PROVIDERS_FILE; approved endpoints your deployment registered",
			absent: !providersPresent,
		},
		{
			key: "network",
			label: "Network",
			value: hosts,
			note: "GAH_ALLOWED_HOSTS; nothing else is reachable, including the tools",
		},
		{
			key: "skills",
			label: "Skills",
			value: paths.length > 0 ? describeSkills(paths) : "none (your team's skills are not loaded)",
			note: host
				? "set up by the administrator for this account"
				: "your team's skills repository; GAH_SKILLS_DIR, or --skill <path> for one run",
		},
		{ key: "audit", label: "Audit log", value: env.GAH_AUDIT_LOG || join(gahDir, "audit.log") },
	];
}

/** Render the page. Pure apart from counting skills: everything it reports comes from `options`. */
export function renderGahHelp(options: GahHelpOptions = {}): string {
	const env = options.env ?? process.env;
	const home = options.home ?? homedir();
	const app = APP_NAME;
	const ENV = app.toUpperCase();
	const agentDir = env[ENV_AGENT_DIR] || join(home, CONFIG_DIR_NAME, "agent");
	const gahDir = join(home, `.${app}`);
	const bedrock = (env.GAH_BUILTIN_MODELS ?? "").includes("amazon-bedrock");

	const title = `${chalk.bold(app)} ${VERSION} - Good agent harness: your organisation's skills, run by an AI agent under policy.`;
	const session = `${chalk.bold("This session")} (from the environment the launcher set):
${gahSessionRows(options)
	.flatMap((r) => [row(r.label, r.value), ...(r.note ? [row("", r.note)] : [])])
	.join("\n")}`;
	const docs = "Documentation: https://github.com/charliesolomon/gah#readme";

	// The shared host's login shell drops arguments and gah-launch forwards
	// none, so usage, options and examples would describe what nobody here
	// can type. People get the same rows in a session, from /help.
	if (env.GAH_LAUNCHER_KIND === "host") {
		return `${title}

${session}

${chalk.bold("On this host:")}
  People connect over SSH and gah starts for them, so it takes no options.
  In a session, /help shows the rows above, and / lists every command.
  Administrators: sudo -u <user> -H gah-launch --help shows this page for that account.

${docs}
`;
	}

	const scaffoldLines = scaffoldUsage(app, env.GAH_SCAFFOLD_COMMANDS);
	const scaffold = scaffoldLines ? `${scaffoldLines}\n` : "";

	const extensionFlags = options.extensionFlags ?? [];
	const extensionSection =
		extensionFlags.length > 0
			? `\n${chalk.bold("Extension flags:")}\n${extensionFlags
					.map((flag) =>
						row(
							`--${flag.name}${flag.type === "string" ? " <value>" : ""}`,
							flag.description ?? `registered by ${flag.extensionPath ?? "an extension"}`,
						),
					)
					.join("\n")}\n`
			: "";

	return `${title}

${chalk.bold("Usage:")}
  ${app} [options] [--] [@files...] [message...]
${scaffold}${row(`${app} auth check`, "Report whether the configured provider is ready")}

${session}

${chalk.bold("Options:")}
${row("--continue, -c", "Continue the previous session")}
${row("--resume, -r", "Pick a session to resume")}
${row("--session <path|id>", "Use a specific session file or partial id")}
${row("--name, -n <name>", "Set the session display name")}
${row("--no-session", "Do not save this session")}
${row("--model <pattern>", 'Choose among the allowed models ("provider/id", optional ":<thinking>")')}
${row("--models <patterns>", "Comma-separated patterns for Ctrl+P model cycling")}
${row("--thinking <level>", "off, minimal, low, medium, high, xhigh, max")}
${row("--list-models [search]", "List the models this session may use")}
${row("--print, -p", "Non-interactive: answer the prompt and exit")}
${row("--mode <mode>", "Output mode for -p: text (default), json, or rpc")}
${row("--export <file> [out.html]", "Export a session file to HTML and exit")}
${row("--skill <path>", "Load a skill file or directory for this run (repeatable)")}
${row("--use-theme <name>", "Interactive theme for this run")}
${row("--tui-mode <mode>", "regular (default) or fullscreen")}
${row("--verbose", "Verbose startup; with --help, the full upstream reference")}
${row("--", "End option parsing; the rest is the message")}
${row("--help, -h", "This page")}
${row("--version, -v", "Show the version")}
${extensionSection}
${chalk.bold("Environment:")}
${row("GAH_SKILLS_DIR", "The skills/ folder of your team's skills repository")}
${row("GAH_ALLOW_NO_SKILLS", "Set to 1 to hide the line about missing team skills (checks, CI)")}
${row("GAH_BUILTIN_MODELS", "provider/model globs allowed from the built-in catalogue; unset = none")}
${row("GAH_ALLOWED_HOSTS", "Hostname globs the process may connect to; unset = none, * = any")}
${row("GAH_PROVIDERS_FILE", `Approved-endpoints file (default ${join(gahDir, "providers.json")})`)}
${row("GAH_ALLOW_MODELS_JSON", `Set to 1 to read ${join(agentDir, "models.json")}`)}
${row("GAH_ALLOW_TOOLS", "Comma-separated extra tools the policy allows, e.g. bash (powershell on Windows)")}
${row("GAH_AUDIT_LOG", `Audit log path (default ${join(gahDir, "audit.log")})`)}
${row(ENV_AGENT_DIR, `Config directory (default ${join(home, CONFIG_DIR_NAME, "agent")})`)}
${row(ENV_SESSION_DIR, "Session storage directory (overridden by --session-dir)")}
${row(`${ENV}_TELEMETRY`, "Ignored: no telemetry leaves a GAH process")}${
	bedrock
		? `\n${row("AWS_PROFILE", "AWS profile for Amazon Bedrock (set by your deployment)")}\n${row("AWS_REGION", "AWS region for Amazon Bedrock")}`
		: ""
}

${chalk.bold("Examples:")}
  ${app}                                             Start a session
  ${app} "Summarise @meeting-notes.md in five bullets"
  ${app} -c "Draft the follow-up email we discussed"
  ${app} -p "Which of these is overdue? @invoices.csv" > answer.txt
  ${app} --list-models                               See what this session may use

Full upstream option reference: ${app} --help --verbose
${docs}
`;
}

/**
 * Print the GAH page unless the caller asked for upstream's reference with
 * --verbose. Returns true when it printed, so printHelp() can return.
 */
export function printGahHelp(extensionFlags?: readonly HelpExtensionFlag[]): boolean {
	if (process.argv.includes("--verbose")) return false;
	console.log(renderGahHelp({ extensionFlags, argv: process.argv }));
	return true;
}
