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
 * printHelp() in args.ts delegates here with a one-line hunk.
 */

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import chalk from "chalk";
import { APP_NAME, CONFIG_DIR_NAME, ENV_AGENT_DIR, ENV_SESSION_DIR, VERSION } from "../config.ts";

interface HelpExtensionFlag {
	name: string;
	type?: string;
	description?: string;
	extensionPath?: string;
}

export interface GahHelpOptions {
	env?: NodeJS.ProcessEnv;
	extensionFlags?: readonly HelpExtensionFlag[];
	/** Home directory used to describe default paths. */
	home?: string;
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

/** Render the page. Pure: everything it reports comes from `options`. */
export function renderGahHelp(options: GahHelpOptions = {}): string {
	const env = options.env ?? process.env;
	const home = options.home ?? homedir();
	const app = APP_NAME;
	const ENV = app.toUpperCase();
	const agentDir = env[ENV_AGENT_DIR] || join(home, CONFIG_DIR_NAME, "agent");
	const gahDir = join(home, `.${app}`);
	const providersFile = env.GAH_PROVIDERS_FILE || join(gahDir, "providers.json");
	const auditLog = env.GAH_AUDIT_LOG || join(gahDir, "audit.log");
	const bedrock = (env.GAH_BUILTIN_MODELS ?? "").includes("amazon-bedrock");

	const tools = env.GAH_EFFECTIVE_TOOLS
		? describeList(env.GAH_EFFECTIVE_TOOLS, "none")
		: "(policy pack not loaded -- run through bin/gah)";
	const models = describeList(env.GAH_BUILTIN_MODELS, "none from the built-in catalogue");
	const hosts =
		env.GAH_ALLOWED_HOSTS === undefined || env.GAH_ALLOWED_HOSTS.trim() === ""
			? "none (deny all)"
			: env.GAH_ALLOWED_HOSTS.trim() === "*"
				? "any (no restriction)"
				: describeList(env.GAH_ALLOWED_HOSTS, "none");
	const skills = env.GAH_SKILLS_DIR ? env.GAH_SKILLS_DIR : "none configured";
	const providers = existsSync(providersFile) ? providersFile : `${providersFile} (absent)`;

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

	return `${chalk.bold(app)} ${VERSION} - Good agent harness: your organisation's skills, run by an AI agent under policy.

${chalk.bold("Usage:")}
  ${app} [options] [--] [@files...] [message...]
  ${app} init <directory>        Create your organisation's skills repository (once)
  ${app} auth check              Report whether the configured provider is ready

${chalk.bold("This session")} (from the environment the launcher set):
${row("Tools", tools)}
${row("", `GAH_ALLOW_TOOLS adds more; every call is written to the audit log`)}
${row("Models", models)}
${row("", `GAH_BUILTIN_MODELS; /model to choose, --list-models to see`)}
${row("Endpoints file", providers)}
${row("", `GAH_PROVIDERS_FILE; approved endpoints your deployment registered`)}
${row("Network", hosts)}
${row("", `GAH_ALLOWED_HOSTS; nothing else is reachable, including the tools`)}
${row("Skills", skills)}
${row("", `GAH_SKILLS_DIR; --skill <path> for a single run`)}
${row("Audit log", auditLog)}

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
${row("GAH_SKILLS_DIR", "Skills directory to load (a session needs one)")}
${row("GAH_ALLOW_NO_SKILLS", "Set to 1 to start deliberately without skills")}
${row("GAH_BUILTIN_MODELS", "provider/model globs allowed from the built-in catalogue; unset = none")}
${row("GAH_ALLOWED_HOSTS", "Hostname globs the process may connect to; unset = none, * = any")}
${row("GAH_PROVIDERS_FILE", `Approved-endpoints file (default ${join(gahDir, "providers.json")})`)}
${row("GAH_ALLOW_MODELS_JSON", `Set to 1 to read ${join(agentDir, "models.json")}`)}
${row("GAH_ALLOW_TOOLS", "Comma-separated extra tools the policy allows, e.g. bash")}
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
`;
}

/**
 * Print the GAH page unless the caller asked for upstream's reference with
 * --verbose. Returns true when it printed, so printHelp() can return.
 */
export function printGahHelp(extensionFlags?: readonly HelpExtensionFlag[]): boolean {
	if (process.argv.includes("--verbose")) return false;
	console.log(renderGahHelp({ extensionFlags }));
	return true;
}
