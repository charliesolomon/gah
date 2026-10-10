/**
 * /help (#142): what this session may use, inside the session.
 *
 * gah's --help page reports a session's tools, models, network hosts, skills
 * and audit log, but on the shared host nobody can reach it: people have no
 * shell, their login shell drops arguments, and pi has no /help of its own.
 * The session is the one interface everyone has, so the same rows are shown
 * here, from gahSessionRows (cli/gah-help.ts, patch 0002) through the package
 * index. They are read when the command runs rather than when the extension
 * loads, so skills fetched during the session (GAH_SESSION_SKILLS_DIR) count.
 */

import { type ExtensionAPI, gahSessionRows, VERSION } from "@earendil-works/pi-coding-agent";
import { formatSessionHelp } from "./lib/help.ts";
import { launcherKind } from "./lib/onboarding.ts";

export default function (pi: ExtensionAPI) {
	pi.registerCommand("help", {
		description: "What this session can use, and where to find more",
		handler: async (_args, ctx) => {
			const rows = gahSessionRows({ env: process.env, argv: process.argv });
			ctx.ui.notify(formatSessionHelp(rows, { version: VERSION, kind: launcherKind() }), "info");
		},
	});
}
