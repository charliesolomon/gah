#!/usr/bin/env node
/**
 * publish-gitlab.mjs — upload a deployment package to a GitLab generic package
 * registry, where the packaged launcher looks for updates.
 *
 *   GAH_GITLAB_TOKEN=... node scripts/publish-gitlab.mjs --config gah-deploy.json --zip dist-deploy/gah-<org>-<version>.zip
 *
 * Uploads <zip> and <zip>.sha256 to
 *   <gitlab.url>/api/v4/projects/<gitlab.project>/packages/generic/<gitlab.package>/<version>/
 * The token needs `api` scope on that project (write_package_registry). The
 * launcher on consumer machines downloads with read_api, or none if the
 * project is visible to them.
 */

import { existsSync, readFileSync } from "node:fs";
import { basename, resolve } from "node:path";

const args = process.argv.slice(2);
const opt = { config: undefined, zip: undefined };
for (let i = 0; i < args.length; i++) {
	const a = args[i];
	if (a === "--config") opt.config = resolve(args[++i] ?? fail("--config needs a path"));
	else if (a === "--zip") opt.zip = resolve(args[++i] ?? fail("--zip needs a path"));
	else if (a === "-h" || a === "--help") {
		console.log(readFileSync(new URL(import.meta.url), "utf8").split("\n").filter((l) => l.startsWith(" *")).map((l) => l.slice(3)).join("\n"));
		process.exit(0);
	} else fail(`unknown argument ${a}`);
}
function fail(msg) {
	console.error(`publish-gitlab: ${msg}`);
	process.exit(1);
}
if (!opt.config || !opt.zip) fail("--config and --zip are required");
const token = process.env.GAH_GITLAB_TOKEN;
if (!token) fail("GAH_GITLAB_TOKEN is not set (needs api scope on the deployment project)");
if (!existsSync(opt.zip) || !existsSync(`${opt.zip}.sha256`)) fail(`zip or its .sha256 not found: ${opt.zip}`);

const cfg = JSON.parse(readFileSync(opt.config, "utf8"));
const base = `${String(cfg.gitlab.url).replace(/\/$/, "")}/api/v4/projects/${encodeURIComponent(cfg.gitlab.project)}/packages/generic/${cfg.gitlab.package ?? "gah-windows"}/${cfg.version}`;

for (const file of [opt.zip, `${opt.zip}.sha256`]) {
	const url = `${base}/${basename(file)}?select=package_file`;
	process.stdout.write(`uploading ${basename(file)} ... `);
	const res = await fetch(url, { method: "PUT", headers: { "PRIVATE-TOKEN": token }, body: readFileSync(file) });
	if (!res.ok) fail(`HTTP ${res.status} ${res.statusText}: ${(await res.text()).slice(0, 300)}`);
	console.log("ok");
}
console.log(`\n✓ published ${basename(opt.zip)} as ${cfg.gitlab.package ?? "gah-windows"} ${cfg.version} in ${cfg.gitlab.project}`);
console.log("Consumers pick it up on their next launch; new installs download it from the same registry.");
