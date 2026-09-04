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
 *     Uninstall-Gah.ps1    the uninstaller (also copied to the install root)
 *     deploy.json          what the launcher and installer read at runtime
 *     VERSION              package, gah and upstream versions, build time
 *
 * Before zipping, the assembled tree is run against the mock endpoint
 * (scripts/check-tool-surface.sh with GAH_BIN) so the package is known to
 * offer the model exactly the policy's tools. Needs only Node; the zip is
 * written by scripts/lib/zip.mjs.
 */

import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
const VENDOR = join(REPO, "vendor", "pi");
const CA = join(VENDOR, "packages", "coding-agent");
const bundle = join(CA, "dist", "bundle");
if (!existsSync(join(bundle, "cli.js"))) fail(`no build at ${bundle} — run make build-all first`);
const gahVersion = JSON.parse(readFileSync(join(CA, "package.json"), "utf8")).version;
// .sync-state may have CRLF endings on a Windows checkout; keep values clean.
const syncState = Object.fromEntries(
	readFileSync(join(REPO, ".sync-state"), "utf8").split(/\r?\n/).filter(Boolean).map((l) => l.split("=").map((v) => v.trim())),
);
const gahRev = spawnSync("git", ["-C", REPO, "rev-parse", "--short", "HEAD"], { encoding: "utf8" }).stdout?.trim() || "unknown";
const policyPack = join(REPO, "packages", "policy-pack");
const launcherSrc = join(REPO, "templates", "deploy", "windows");
for (const f of ["gah.ps1", "Install-Gah.ps1", "Uninstall-Gah.ps1"]) {
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
// The bundle leaves a few packages external (scripts/build-coding-agent-bundle.mjs):
// jiti, which loads the policy pack's .ts extensions; photon-node for image
// resizing; and, since upstream v0.85.0, chord -- the agent's context runtime,
// a workspace package the bundle imports by name. The published npm package
// gets them from npm install; a zip that never runs npm install has to carry
// them. chord's only dependency, esbuild, is handled separately below.
const externals = [
	{ name: "jiti", from: join(VENDOR, "node_modules", "jiti") },
	{ name: "@silvia-odwyer/photon-node", from: join(VENDOR, "node_modules", "@silvia-odwyer", "photon-node") },
	{ name: "@earendil-works/chord", from: join(VENDOR, "packages", "chord"), only: ["package.json", "dist", "README.md"] },
];
for (const { name, from, only } of externals) {
	if (!existsSync(join(from, "package.json"))) fail(`missing ${from} — run npm ci and the build in vendor/pi`);
	const dest = join(tree, "node_modules", name);
	mkdirSync(dest, { recursive: true });
	for (const entry of only ?? readdirSync(from)) {
		if (!existsSync(join(from, entry))) continue;
		cpSync(join(from, entry), join(dest, entry), { recursive: true, dereference: true });
	}
}
// Drift guard: upstream's bundle script declares every package the bundle may
// leave external (allowedExternalPackages). Each one that is not an optional
// accelerator must be carried above. This fails with a package name when
// upstream adds another external -- instead of the tool-surface check
// reporting "no request reached the mock".
{
	const buildScript = readFileSync(join(VENDOR, "scripts", "build-coding-agent-bundle.mjs"), "utf8");
	const m = buildScript.match(/allowedExternalPackages\s*=\s*new Set\(\[([\s\S]*?)\]\)/);
	if (!m) fail("cannot find allowedExternalPackages in vendor/pi/scripts/build-coding-agent-bundle.mjs — update the drift guard in scripts/package-windows.mjs");
	// Their callers fall back to JavaScript when the module is absent (upstream's comment).
	const optional = new Set(["bufferutil", "utf-8-validate", "supports-color"]);
	const carried = new Set(externals.map((e) => e.name));
	const missing = new Set();
	for (const [, spec] of m[1].matchAll(/"([^"]+)"/g)) {
		const pkg = spec.startsWith("@") ? spec.split("/").slice(0, 2).join("/") : spec.split("/")[0];
		if (!optional.has(pkg) && !carried.has(pkg)) missing.add(pkg);
	}
	if (missing.size > 0) {
		fail(`the bundle may import packages this package does not carry: ${[...missing].sort().join(", ")} — add them to \`externals\` in scripts/package-windows.mjs`);
	}
}
// chord's dist/node/bundle.js imports esbuild at module load, and the bundle
// reaches it eagerly through the experimental plugin bundler -- a code path
// GAH never runs (experimental features are off, extensions are not loaded).
// npm would satisfy that import with esbuild plus an 11 MB platform binary.
// The zip carries a stub instead: the same named exports, each throwing a
// clear error, so startup resolves and the unused path fails loudly rather
// than shipping a native binary for nothing. The export list is derived from
// chord's actual import so a new upstream use fails here, not on a laptop.
{
	const chordBundle = readFileSync(join(VENDOR, "packages", "chord", "dist", "node", "bundle.js"), "utf8");
	const names = new Set();
	for (const m of chordBundle.matchAll(/import\s*\{([^}]*)\}\s*from\s*"esbuild"/g)) {
		for (const n of m[1].split(",")) {
			const name = n.trim().split(/\s+as\s+/)[0].trim();
			if (name) names.add(name);
		}
	}
	if (/import\s+(?:\*\s+as\s+\w+|\w+)\s+from\s*"esbuild"/.test(chordBundle)) {
		fail("chord now imports esbuild as a namespace or default; the stub in scripts/package-windows.mjs only covers named imports");
	}
	if (names.size === 0) fail("chord no longer imports esbuild by name — drop or rework the stub in scripts/package-windows.mjs");
	const stubDir = join(tree, "node_modules", "esbuild");
	mkdirSync(stubDir, { recursive: true });
	const message = "esbuild is not shipped in this GAH package: experimental plugin bundling is unavailable (see docs/DEPLOY-WINDOWS.md)";
	const body = [...names].map((n) => `export function ${n}() {\n\tthrow new Error(${JSON.stringify(message)});\n}`).join("\n");
	writeFileSync(join(stubDir, "index.js"), `// Generated by scripts/package-windows.mjs. Stands in for esbuild ${JSON.parse(readFileSync(join(VENDOR, "node_modules", "esbuild", "package.json"), "utf8")).version}.\n${body}\n`);
	writeFileSync(
		join(stubDir, "package.json"),
		`${JSON.stringify({ name: "esbuild", version: "0.0.0-gah-stub", type: "module", main: "./index.js", exports: "./index.js" }, null, 2)}\n`,
	);
}
mkdirSync(join(tree, "gah-policy", "extensions"), { recursive: true });
cpSync(join(policyPack, "extensions"), join(tree, "gah-policy", "extensions"), { recursive: true });
const systemMd = cfg.systemMd ? resolve(dirname(opt.config), cfg.systemMd) : join(policyPack, "SYSTEM.md");
if (!existsSync(systemMd)) fail(`SYSTEM.md not found: ${systemMd}`);
cpSync(systemMd, join(tree, "gah-policy", "SYSTEM.md"));
writeFileSync(join(tree, "gah-policy", "providers.json"), `${JSON.stringify(cfg.providers, null, 2)}\n`);
for (const f of ["gah.ps1", "Install-Gah.ps1", "Uninstall-Gah.ps1"]) cpSync(join(launcherSrc, f), join(tree, f));

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
	gitlab: {
		url: cfg.gitlab.url,
		project: cfg.gitlab.project,
		package: cfg.gitlab.package ?? "gah-windows",
		// "user": the installer asks which of the user's certificates to present (mutual TLS front-ends).
		clientCert: cfg.gitlab.clientCert ?? null,
		// Optional issuer substring: the installer lists certificates from that CA first.
		clientCertIssuer: cfg.gitlab.clientCertIssuer ?? null,
		// null: the consumer machine's HTTPS_PROXY/HTTP_PROXY (honouring NO_PROXY), else Windows settings;
		// a URL forces that proxy; "none" forces a direct connection.
		proxy: cfg.gitlab.proxy ?? null,
	},
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
	if (process.platform !== "win32") {
		const probe = spawnSync("which", ["bash"], { encoding: "utf8" });
		return probe.status === 0 && probe.stdout.trim() ? "bash" : undefined;
	}
	// Windows: Git Bash first, by location. The `bash` on PATH is usually
	// System32\bash.exe, the WSL shim, which runs a Linux userland, mangles
	// C:\ paths and would not find Windows node -- never use it.
	for (const root of [process.env.ProgramFiles, process.env["ProgramFiles(x86)"], process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, "Programs")]) {
		if (!root) continue;
		const candidate = join(root, "Git", "bin", "bash.exe");
		if (existsSync(candidate)) return candidate;
	}
	const probe = spawnSync("where", ["bash"], { encoding: "utf8" });
	const found = probe.status === 0 ? probe.stdout.split(/\r?\n/).map((l) => l.trim()).find((l) => l && !/\\System32\\bash\.exe$/i.test(l)) : undefined;
	return found;
}
const bash = opt.skipCheck ? undefined : findBash();
if (!opt.skipCheck && !bash) {
	console.warn("package-windows: no bash found (Git for Windows?) — skipping the tool-surface check of the assembled tree. Run it on a machine with bash, or trust CI, before publishing.");
}
if (!opt.skipCheck && bash) {
	console.log(`checking tool surface of ${tree} …`);
	// Forward slashes: Git Bash accepts C:/... as a file argument; backslashes are escapes to bash.
	const r = spawnSync(bash, [join(REPO, "scripts", "check-tool-surface.sh").split("\\").join("/")], {
		cwd: REPO,
		stdio: "inherit",
		// GAH_CLI rather than a command string: process.execPath is
		// "C:\Program Files\nodejs\node.exe" on Windows, and a space splits a
		// command string in bash. The script quotes the path and runs node from PATH.
		env: { ...process.env, GAH_CLI: join(tree, "bundle", "cli.js"), GAH_PROVIDERS_FILE: join(tree, "gah-policy", "providers.json") },
	});
	if (r.status !== 0) fail("assembled package failed the tool-surface check; not zipping");
}

// --- Zip ------------------------------------------------------------------
const zip = join(opt.out, `${name}.zip`);
const sha = zipDirectory(tree, zip, name);
writeFileSync(`${zip}.sha256`, `${sha}  ${basename(zip)}\n`);
console.log(`\n✓ ${zip}\n  sha256 ${sha}\n  gah ${gahVersion} (upstream ${syncState.ref}, gah ${gahRev}), ${archs.join("/")}`);
