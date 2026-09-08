/**
 * GAH: branded environment variable names.
 *
 * 0001-branding sets piConfig.name, and APP_NAME rebrands the banner, the
 * process title, the config directory and the *_CODING_AGENT_DIR variable.
 * A handful of settings are still read from hardcoded PI_* names scattered
 * across coding-agent, tui and ai, so `GAH_OFFLINE=1` did nothing while
 * `--help` printed `PI_OFFLINE`. (#2)
 *
 * Rather than patch every read site -- a hunk per file, in files upstream
 * touches often -- this module mirrors each GAH_<NAME> onto PI_<NAME> once,
 * before anything reads them. Upstream keeps reading PI_*; users write GAH_*.
 * PI_* still works, and wins if both are set, so nothing already configured
 * changes behaviour.
 *
 * It must be the first import of every entry point (cli.ts, rpc-entry.ts):
 * PI_PACKAGE_DIR is consulted while config.ts locates package.json, before
 * the branded name is known, and PI_TIMING is read at module load. That is
 * also why the prefix is a literal here rather than derived from APP_NAME.
 *
 * Only inbound settings are mirrored. Names the agent *exports* to child
 * processes (PI_CODING_AGENT, and PI_SESSION_ID / PI_MODEL / ... in the bash
 * tool's environment) keep upstream's spelling on purpose: skill scripts
 * written against upstream's documentation must keep working.
 */

export const GAH_ENV_PREFIX = "GAH";

/** Inbound PI_<NAME> settings upstream reads from the environment. */
export const GAH_MIRRORED_ENV_NAMES = [
	"OFFLINE",
	"SKIP_VERSION_CHECK",
	"TELEMETRY",
	"PACKAGE_DIR",
	"SHARE_VIEWER_URL",
	"CACHE_RETENTION",
	"EXPERIMENTAL",
	"TIMING",
	"STARTUP_BENCHMARK",
	"OAUTH_CALLBACK_HOST",
	"MANAGED_INSTALL_ROOT",
	"BASE",
	"CLEAR_ON_SHRINK",
	"HARDWARE_CURSOR",
	"HYPERLINKS",
	"IMAGE_PROTOCOL",
	"TRUE_COLOR",
	"DEBUG_REDRAW",
	"TUI_DEBUG",
	"TUI_ESC_TIMEOUT",
	"TUI_WRITE_LOG",
] as const;

/**
 * Copy `${prefix}_<NAME>` to `PI_<NAME>` for every mirrored name that is set
 * under the prefix and unset under PI_. Returns the names that were mirrored.
 */
export function applyGahEnvAliases(env: NodeJS.ProcessEnv = process.env, prefix: string = GAH_ENV_PREFIX): string[] {
	if (prefix === "PI") return [];
	const mirrored: string[] = [];
	for (const name of GAH_MIRRORED_ENV_NAMES) {
		const branded = env[`${prefix}_${name}`];
		if (branded === undefined || env[`PI_${name}`] !== undefined) continue;
		env[`PI_${name}`] = branded;
		mirrored.push(name);
	}
	return mirrored;
}

applyGahEnvAliases();
