#!/usr/bin/env node
/**
 * package-windows.mjs — assemble a GAH deployment package for Windows from a
 * built tree and an organisation's gah-deploy.json (docs/DEPLOY-WINDOWS.md).
 *
 *   node scripts/package-windows.mjs --config path/to/gah-deploy.json [--out dist-deploy] [--skip-check]
 *
 * Output: <out>/gah-<org>-<version>.zip (+ .sha256), containing
 *   gah-<org>-<version>/
 *     bundle/              upstream's self-contained build (runs on bare Node)
 *     package.json         version metadata the bundle reads
 *     gah-policy/          extensions, SYSTEM.md, providers.json — force-loaded by patch 0020
 *     tools/               pinned fd + ripgrep archives and SHA256SUMS; the installer verifies and unpacks
 *     gah.ps1              the consumer launcher (templates/deploy/windows/)
 *     Install-Gah.ps1      the installer
 *     deploy.json          what the launcher and installer read at runtime
 *     VERSION              package, gah and upstream versions, build time
 *
 * Before zipping, the assembled tree is run against the mock endpoint
 * (scripts/check-tool-surface.sh with GAH_BIN) so the package is known to
 * offer the model exactly the policy's tools. Needs only Node; the zip is
 * written by scripts/lib/zip.mjs.
 */

import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PINS } from "./install-tools.mjs";
import { zipDirectory } from "./lib/zip.mjs";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const opt = { config: undefined, out: join(REPO, "dist-deploy"), skipCheck: false };
for (let i = 0; i < args.length; i++) {
	const a = args[i];
	if (a === "--config") opt.config = resolve(args[++i] ?? fail("--config needs a path"));
	else if (a === "--out") opt.out = resolve(args[++i] ?? fail("--out needs a path"));
	else if (a === "--skip-check") opt.skipCheck = true;
	else if (a === "-h" || a === "--help") {
		console.log(readFileSync(fileURLToPath(import.meta.url), "utf8").split("\n").filter((l) => l.startsWith(" *")).map((l) => l.slice(3)).join("\n"));
		process.exit(0);
	} else fail(`unknown argument ${a}`);
}
if (!opt.config) fail("--config <gah-deploy.json> is required");

function fail(msg) {
	console.error(`package-windows: ${msg}`);
	process.exit(1);
}

// --- Config --------------------------------------------------------------
const cfg = JSON.parse(readFileSync(opt.config, "utf8"));
const need = (v, what) => (v === undefined || v === null || v === "" ? fail(`config: ${what} is required`) : v);
need(cfg.org, "org");
need(cfg.version, "version");
need(cfg.gitlab?.url, "gitlab.url");
need(cfg.gitlab?.project, "gitlab.project");
need(cfg.skills?.project, "skills.project");
if (!Array.isArray(cfg.providers?.providers) || cfg.providers.providers.length === 0) fail("config: providers.providers must be a non-empty array");
for (const p of cfg.providers.providers) {
	for (const k of ["name", "baseUrl", "api"]) need(p[k], `providers.providers[].${k}`);
	if (!Array.isArray(p.models) || p.models.length === 0) fail(`config: provider ${p.name} needs a non-empty models array`);
	if (p.apiKey !== undefined && typeof p.apiKey !== "string") fail(`config: provider ${p.name}: apiKey must be a string when present`);
}
const env = cfg.env ?? {};
for (const [k, v] of Object.entries(env)) {
	if (!/^GAH_[A-Z0-9_]+$/.test(k)) fail(`config: env key ${k} must be GAH_*`);
	if (typeof v !== "string") fail(`config: env.${k} must be a string`);
}
const slug = String(cfg.org).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
const name = `gah-${slug}-${cfg.version}`;

// --- Inputs from the build ----------------------------------------------
const CA = join(REPO, "vendor", "pi", "packages", "coding-agent");
const bundle = join(CA, "dist", "bundle");
if (!existsSync(join(bundle, "cli.js"))) fail(`no build at ${bundle} — run make build-all first`);
const gahVersion = JSON.parse(readFileSync(join(CA, "package.json"), "utf8")).version;
const syncState = Object.fromEntries(readFileSync(join(REPO, ".sync-state"), "utf8").trim().split("\n").map((l) => l.split("=")));
const gahRev = spawnSync("git", ["-C", REPO, "rev-parse", "--short", "HEAD"], { encoding: "utf8" }).stdout?.trim() || "unknown";
const policyPack = join(REPO, "packages", "policy-pack");
const launcherSrc = join(REPO, "templates", "deploy", "windows");
for (const f of ["gah.ps1", "Install-Gah.ps1"]) {
	if (!existsSync(join(launcherSrc, f))) fail(`missing ${join(launcherSrc, f)}`);
}

// --- Assemble -----------------------------------------------------------
const tree = join(opt.out, name);
rmSync(tree, { recursive: true, force: true });
mkdirSync(tree, { recursive: true });
cpSync(bundle, join(tree, "bundle"), { recursive: true });
cpSync(join(CA, "package.json"), join(tree, "package.json"));
// The bundle resolves a few assets relative to the package directory, the same
// layout the published npm package has: themes, TUI images, the HTML-export
// template, and the docs the agent can look up. Everything else in dist/ is the
// unbundled build and is not needed.
for (const rel of ["dist/modes/interactive/theme", "dist/modes/interactive/assets", "dist/core/export-html", "docs"]) {
	if (!existsSync(join(CA, rel))) fail(`missing ${join(CA, rel)} — is the build complete?`);
	cpSync(join(CA, rel), join(tree, rel), { recursive: true });
}
for (const f of ["CHANGELOG.md", "README.md"]) if (existsSync(join(CA, f))) cpSync(join(CA, f), join(tree, f));
// The bundle leaves two packages external (scripts/build-coding-agent-bundle.mjs):
// jiti, which loads the policy pack's .ts extensions, and photon-node for image
// resizing. Both are dependency-free. The published npm package gets them from
// npm install; a zip that never runs npm install has to carry them.
for (const dep of ["jiti", "@silvia-odwyer/photon-node"]) {
	const src = join(REPO, "vendor", "pi", "node_modules", dep);
	if (!existsSync(join(src, "package.json"))) fail(`missing ${src} — run npm ci in vendor/pi`);
	cpSync(src, join(tree, "node_modules", dep), { recursive: true });
}
mkdirSync(join(tree, "gah-policy", "extensions"), { recursive: true });
cpSync(join(policyPack, "extensions"), join(tree, "gah-policy", "extensions"), { recursive: true });
const systemMd = cfg.systemMd ? resolve(dirname(opt.config), cfg.systemMd) : join(policyPack, "SYSTEM.md");
if (!existsSync(systemMd)) fail(`SYSTEM.md not found: ${systemMd}`);
cpSync(systemMd, join(tree, "gah-policy", "SYSTEM.md"));
writeFileSync(join(tree, "gah-policy", "providers.json"), `${JSON.stringify(cfg.providers, null, 2)}\n`);
for (const f of ["gah.ps1", "Install-Gah.ps1"]) cpSync(join(launcherSrc, f), join(tree, f));

// tools: pinned archives + checksums; the installer verifies and unpacks them
const archs = cfg.windowsArch ?? ["x64"];
const toolsDir = join(tree, "tools");
mkdirSync(toolsDir, { recursive: true });
const cache = join(opt.out, "tools-cache");
const sums = [];
for (const arch of archs) {
	const platform = `win32-${arch}`;
	for (const tool of Object.keys(PINS)) {
		const entry = PINS[tool].assets[platform] ?? fail(`no pinned ${tool} for ${platform}`);
		const [asset, sha] = entry;
		if (!existsSync(join(cache, asset))) {
			const r = spawnSync(process.execPath, [join(REPO, "scripts", "install-tools.mjs"), "--download-only", cache, "--platform", platform], { stdio: "inherit" });
			if (r.status !== 0) fail(`downloading tool archives for ${platform} failed`);
		}
		cpSync(join(cache, asset), join(toolsDir, asset));
		sums.push(`${sha}  ${asset}`);
	}
}
writeFileSync(join(toolsDir, "SHA256SUMS"), `${sums.join("\n")}\n`);

const deploy = {
	org: cfg.org,
	shortcutName: cfg.shortcutName ?? `${cfg.org} Assistant`,
	version: cfg.version,
	packageName: name,
	gahVersion,
	gitlab: { url: cfg.gitlab.url, project: cfg.gitlab.project, package: cfg.gitlab.package ?? "gah-windows" },
	skills: { project: cfg.skills.project, branch: cfg.skills.branch ?? "main" },
	env,
	providersLogin: cfg.providers.providers.filter((p) => p.apiKey === undefined).map((p) => p.name),
	providersEnv: cfg.providers.providers.filter((p) => typeof p.apiKey === "string" && p.apiKey.startsWith("$")).map((p) => ({ provider: p.name, variable: p.apiKey.slice(1) })),
	windowsArch: archs,
};
writeFileSync(join(tree, "deploy.json"), `${JSON.stringify(deploy, null, 2)}\n`);
const version = { package: name, version: cfg.version, gah: gahVersion, upstream: syncState.ref, upstreamSha: syncState.sha, gahRev, builtAt: new Date().toISOString() };
writeFileSync(join(tree, "VERSION"), `${JSON.stringify(version, null, 2)}\n`);

// --- Check the assembled tree, not the repo ------------------------------
// The check is a bash script. On Windows, Git for Windows puts git on PATH but
// not always bash, so look where upstream's shell resolver looks before giving up.
function findBash() {
	const probe = spawnSync(process.platform === "win32" ? "where" : "which", ["bash"], { encoding: "utf8" });
	if (probe.status === 0 && probe.stdout.trim()) return "bash";
	if (process.platform === "win32") {
		for (const root of [process.env.ProgramFiles, process.env["ProgramFiles(x86)"], process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, "Programs")]) {
			if (!root) continue;
			const candidate = join(root, "Git", "bin", "bash.exe");
			if (existsSync(candidate)) return candidate;
		}
	}
	return undefined;
}
const bash = opt.skipCheck ? undefined : findBash();
if (!opt.skipCheck && !bash) {
	console.warn("package-windows: no bash found (Git for Windows?) — skipping the tool-surface check of the assembled tree. Run it on a machine with bash, or trust CI, before publishing.");
}
if (!opt.skipCheck && bash) {
	console.log(`checking tool surface of ${tree} …`);
	const r = spawnSync(bash, [join(REPO, "scripts", "check-tool-surface.sh")], {
		cwd: REPO,
		stdio: "inherit",
		env: { ...process.env, GAH_BIN: `${process.execPath} ${join(tree, "bundle", "cli.js")} --no-extensions`, GAH_PROVIDERS_FILE: join(tree, "gah-policy", "providers.json") },
	});
	if (r.status !== 0) fail("assembled package failed the tool-surface check; not zipping");
}

// --- Zip ------------------------------------------------------------------
const zip = join(opt.out, `${name}.zip`);
const sha = zipDirectory(tree, zip, name);
writeFileSync(`${zip}.sha256`, `${sha}  ${basename(zip)}\n`);
console.log(`\n✓ ${zip}\n  sha256 ${sha}\n  gah ${gahVersion} (upstream ${syncState.ref}, gah ${gahRev}), ${archs.join("/")}`);
