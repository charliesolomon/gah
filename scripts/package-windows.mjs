#!/usr/bin/env node
// package-windows.mjs — the Windows package, by its long-standing name:
// scripts/package.mjs --platform windows. Kept so existing commands, the
// gah-deployments skill and CI keep working; see package.mjs for everything.
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
if (args.includes("--platform")) {
	console.error("package-windows: --platform is fixed to windows here; use scripts/package.mjs for Linux");
	process.exit(2);
}
const r = spawnSync(process.execPath, [fileURLToPath(new URL("./package.mjs", import.meta.url)), "--platform", "windows", ...args], { stdio: "inherit" });
process.exit(r.status ?? 1);
