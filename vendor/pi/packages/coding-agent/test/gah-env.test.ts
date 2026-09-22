/**
 * GAH: branded environment names (0002-branded-env). Pure function tests on a
 * private env object; the module's own load-time call is exercised end to end
 * by `bin/gah --help`.
 */

import { describe, expect, it } from "vitest";
import { applyGahEnvAliases, GAH_MIRRORED_ENV_NAMES } from "../src/core/gah-env.ts";

describe("GAH env aliases", () => {
	it("mirrors GAH_<NAME> onto PI_<NAME> when PI_ is unset", () => {
		const env: NodeJS.ProcessEnv = { GAH_TELEMETRY: "0", GAH_OFFLINE: "1" };
		expect(applyGahEnvAliases(env).sort()).toEqual(["OFFLINE", "TELEMETRY"]);
		expect(env.PI_TELEMETRY).toBe("0");
		expect(env.PI_OFFLINE).toBe("1");
	});

	it("lets an explicit PI_ value win, and leaves everything else untouched", () => {
		const env: NodeJS.ProcessEnv = { GAH_TELEMETRY: "0", PI_TELEMETRY: "1", GAH_UNRELATED: "x" };
		expect(applyGahEnvAliases(env)).toEqual([]);
		expect(env.PI_TELEMETRY).toBe("1");
		expect(env.PI_UNRELATED).toBeUndefined();
	});

	it("is a no-op for the upstream prefix and for an empty environment", () => {
		const env: NodeJS.ProcessEnv = { PI_OFFLINE: "1" };
		expect(applyGahEnvAliases(env, "PI")).toEqual([]);
		expect(applyGahEnvAliases({})).toEqual([]);
	});

	it("covers every inbound name the help text and the issue list", () => {
		for (const name of ["OFFLINE", "SKIP_VERSION_CHECK", "TELEMETRY", "PACKAGE_DIR", "SHARE_VIEWER_URL", "CACHE_RETENTION"]) {
			expect(GAH_MIRRORED_ENV_NAMES).toContain(name);
		}
	});
});
