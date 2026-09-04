#!/usr/bin/env node
// GAH: must run before config.ts reads the environment (see gah-env.ts).
import "./core/gah-env.ts";
import { APP_NAME } from "./config.ts";
import { configureHttpDispatcher } from "./core/http-dispatcher.ts";
import { consumeInternalProcessRole } from "./experimental/process.ts";
import { runServerProcess } from "./experimental/server.ts";
import { runSessionWorkerProcess } from "./experimental/session-worker.ts";
import { main } from "./main.ts";

// GAH: the egress guard lives in configureHttpDispatcher() (0011). Upstream
// only installs it for the main process; the experimental server and
// session-worker roles below would otherwise talk to providers through an
// unguarded default dispatcher. Install it before any role runs.
configureHttpDispatcher();

const internalProcessRole = consumeInternalProcessRole();
if (internalProcessRole === "server") {
	void runServerProcess(process.argv.slice(2)).catch(() => process.exit(1));
} else if (internalProcessRole === "session-worker") {
	void runSessionWorkerProcess(process.argv.slice(2)).catch(() => process.exit(1));
} else {
	if (internalProcessRole !== undefined) {
		throw new Error(`Internal ${internalProcessRole} process must use its lightweight entrypoint`);
	}
	process.title = APP_NAME;
	process.env.PI_CODING_AGENT = "true";
	process.env.AI_AGENT = "pi";
	process.emitWarning = (() => {}) as typeof process.emitWarning;

	// Configure undici's global dispatcher before provider SDKs issue requests.
	// Runtime settings are applied once SettingsManager has loaded global/project settings.
	// (GAH: already configured above, for every process role.)

	main(process.argv.slice(2));
}
