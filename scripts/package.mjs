#!/usr/bin/env node
/**
 * package.mjs — assemble a GAH deployment package for Windows or Linux from a
 * built tree and an organisation's gah-deploy.json (docs/DEPLOY-WINDOWS.md,
 * docs/DEPLOY-LINUX.md).
 *
 *   node scripts/package.mjs --config path/to/gah-deploy.json [--platform windows|linux] [--out dist-deploy] [--skip-check]
 *
 * --platform defaults to windows; scripts/package-windows.mjs runs this with it fixed.
 *
 * Output: <out>/<name>-win11-<version>.zip or <name>-linux-<version>.zip, where
 * <name> is the config's "name" (default gah-<org slug>). Both go into one
 * registry package, gitlab.package (default <name>), one version each.
 * (Linux), each with a .sha256, containing one folder of the same name:
 *     bundle/              upstream's self-contained build (runs on bare Node)
 *     package.json         version metadata the bundle reads
 *     gah-policy/          extensions, SYSTEM.md, providers.json — force-loaded by patch 0020
 *     tools/               pinned fd + ripgrep archives and SHA256SUMS; the installer verifies and unpacks
 *     gah.ps1, Install-Gah.ps1, Uninstall-Gah.ps1    (Windows; templates/deploy/windows/)
 *     gah.sh, install.sh, uninstall.sh               (Linux; templates/deploy/linux/)
 *                          launcher, installer, uninstaller (also copied to the install root)
 *     preflight.mjs        checks before each session: route to the model (proxy), a working key
 *     gah-policy/setup-skills/          the built-in setup skills (/setup-skills, #135)
 *     gah-policy/deploy-setup-skills/   the deployment's own, from gah-deploy.json setupSkills
 *     deploy.json          what the launcher and installer read at runtime
 *     VERSION              package, gah and upstream versions, build time
 *
 * Before zipping, the assembled tree is run against the mock endpoint
 * (scripts/check-tool-surface.sh with GAH_BIN) so the package is known to
 * offer the model exactly the policy's tools. Needs only Node; the zip is
 * written by scripts/lib/zip.mjs.
 */

import { spawnSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PINS } from "./install-tools.mjs";
import { zipDirectory } from "./lib/zip.mjs";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const opt = { config: undefined, out: join(REPO, "dist-deploy"), skipCheck: false, platform: "windows" };
for (let i = 0; i < args.length; i++) {
	const a = args[i];
	if (a === "--config") opt.config = resolve(args[++i] ?? fail("--config needs a path"));
	else if (a === "--out") opt.out = resolve(args[++i] ?? fail("--out needs a path"));
	else if (a === "--skip-check") opt.skipCheck = true;
	else if (a === "--platform") opt.platform = args[++i] ?? fail("--platform needs windows or linux");
	else if (a === "-h" || a === "--help") {
		console.log(readFileSync(fileURLToPath(import.meta.url), "utf8").split("\n").filter((l) => l.startsWith(" *")).map((l) => l.slice(3)).join("\n"));
		process.exit(0);
	} else fail(`unknown argument ${a}`);
}
if (!opt.config) fail("--config <gah-deploy.json> is required");
// What differs between the two platforms; everything else is shared.
const PLATFORMS = {
	windows: {
		launcher: ["gah.ps1", "Install-Gah.ps1", "Uninstall-Gah.ps1"],
		archKey: "windowsArch",
		toolPlatform: "win32",
		tag: "win11",
	},
	linux: {
		launcher: ["gah.sh", "install.sh", "uninstall.sh"],
		archKey: "linuxArch",
		toolPlatform: "linux",
		tag: "linux",
	},
};
const P = PLATFORMS[opt.platform] ?? fail(`--platform must be windows or linux, not ${opt.platform}`);

/**
 * A deployment's setup skills ship in a zip anyone in the organisation can
 * download, before any access control applies. Each must be a valid skill, and
 * nothing in them may look like a credential: that is refused, not warned.
 */
function checkSetupSkills(dir) {
	const SECRETISH = [
		[/glpat-[A-Za-z0-9_-]{20,}/, "a GitLab token"],
		[/\bgh[pousr]_[A-Za-z0-9]{30,}/, "a GitHub token"],
		[/\bsk-[A-Za-z0-9_-]{20,}/, "an API key"],
		[/\bAKIA[0-9A-Z]{16}\b/, "an AWS access key"],
		[/-----BEGIN [A-Z ]*PRIVATE KEY-----/, "a private key"],
	];
	const walk = (d) => readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(d, e.name)) : [join(d, e.name)]));
	let skills = 0;
	for (const e of readdirSync(dir, { withFileTypes: true })) {
		if (!e.isDirectory()) continue;
		const md = join(dir, e.name, "SKILL.md");
		if (!existsSync(md)) fail(`setupSkills: ${e.name}/ has no SKILL.md`);
		const front = readFileSync(md, "utf8").match(/^---\r?\n([\s\S]*?)\r?\n---/);
		const name = front?.[1].match(/^name:\s*(.+)$/m)?.[1].trim();
		if (!front || !name || !/^description:\s*\S/m.test(front[1])) fail(`setupSkills: ${e.name}/SKILL.md needs frontmatter with name and description`);
		if (name !== e.name) fail(`setupSkills: ${e.name}/SKILL.md is named '${name}'; the folder and the name must match`);
		skills++;
	}
	if (skills === 0) fail(`setupSkills: ${dir} has no skill folders`);
	for (const f of walk(dir)) {
		const text = readFileSync(f, "utf8");
		for (const [re, what] of SECRETISH) if (re.test(text)) fail(`setupSkills: ${f} contains what looks like ${what}; it would ship in every package`);
	}
}

function fail(msg) {
	console.error(`package: ${msg}`);
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
const env = { ...(cfg.env ?? {}) };
for (const [k, v] of Object.entries(env)) {
	if (!/^GAH_[A-Z0-9_]+$/.test(k)) fail(`config: env key ${k} must be GAH_*`);
	if (typeof v !== "string") fail(`config: env.${k} must be a string`);
}
// skillsNudge: false -- a deployment that never uses shared skills turns the
// "/setup-skills" line off (#135). Carried as an environment variable.
if (cfg.skillsNudge !== undefined && typeof cfg.skillsNudge !== "boolean") fail("config: skillsNudge must be true or false");
if (cfg.skillsNudge === false) env.GAH_SKILLS_NUDGE = "0";
// setupSkills: false -- a deployment set up by its administrator never offers
// in-session setup: no setup skills, no /setup-skills, no gah_setup (#138).
if (cfg.setupSkills != null && cfg.setupSkills !== false && typeof cfg.setupSkills !== "string") fail("config: setupSkills must be a folder name, false, or null");
if (cfg.setupSkills === false) env.GAH_SETUP_SKILLS = "0";
// inferenceProxy: offered by preflight.mjs when a direct connection fails.
if (cfg.inferenceProxy !== undefined && cfg.inferenceProxy !== null && !/^https?:\/\/[^\s]+$/.test(String(cfg.inferenceProxy))) {
	fail("config: inferenceProxy must be an http(s):// URL, or null");
}
// One name for the registry package and both zips: <name>-win11-<version>.zip
// and <name>-linux-<version>.zip side by side under one registry version. Each
// launcher derives its update's file name from its own packageName.
const NAME_RE = /^[a-z0-9][a-z0-9._-]*$/;
const baseName = cfg.name ?? `gah-${String(cfg.org).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")}`;
if (!NAME_RE.test(baseName)) fail(`config: name '${baseName}' must be lower-case letters, digits, '.', '_' and '-'`);
if (cfg.gitlab.linuxPackage !== undefined) fail("config: gitlab.linuxPackage is gone; both platforms now publish into gitlab.package (default: name). Remove it");
const registryPackage = cfg.gitlab.package ?? baseName;
if (!NAME_RE.test(registryPackage)) fail(`config: gitlab.package '${registryPackage}' must be lower-case letters, digits, '.', '_' and '-'`);
const name = `${baseName}-${P.tag}-${cfg.version}`;

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
const launcherSrc = join(REPO, "templates", "deploy", opt.platform);
for (const f of P.launcher) {
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
	if (!m) fail("cannot find allowedExternalPackages in vendor/pi/scripts/build-coding-agent-bundle.mjs — update the drift guard in scripts/package.mjs");
	// Their callers fall back to JavaScript when the module is absent (upstream's comment).
	// kerberos (pi >= 0.86): optional native proxy authentication; upstream says its
	// caller reports an install hint when absent. A native module cannot be carried
	// from an --ignore-scripts install anyway. A deployment behind a Negotiate proxy
	// would need it installed on the machine; none does today.
	const optional = new Set(["bufferutil", "utf-8-validate", "supports-color", "kerberos"]);
	const carried = new Set(externals.map((e) => e.name));
	const missing = new Set();
	for (const [, spec] of m[1].matchAll(/"([^"]+)"/g)) {
		const pkg = spec.startsWith("@") ? spec.split("/").slice(0, 2).join("/") : spec.split("/")[0];
		if (!optional.has(pkg) && !carried.has(pkg)) missing.add(pkg);
	}
	if (missing.size > 0) {
		fail(`the bundle may import packages this package does not carry: ${[...missing].sort().join(", ")} — add them to \`externals\` in scripts/package.mjs`);
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
		fail("chord now imports esbuild as a namespace or default; the stub in scripts/package.mjs only covers named imports");
	}
	if (names.size === 0) fail("chord no longer imports esbuild by name — drop or rework the stub in scripts/package.mjs");
	const stubDir = join(tree, "node_modules", "esbuild");
	mkdirSync(stubDir, { recursive: true });
	const message = "esbuild is not shipped in this GAH package: experimental plugin bundling is unavailable (see docs/DEPLOY-WINDOWS.md)";
	const body = [...names].map((n) => `export function ${n}() {\n\tthrow new Error(${JSON.stringify(message)});\n}`).join("\n");
	writeFileSync(join(stubDir, "index.js"), `// Generated by scripts/package.mjs. Stands in for esbuild ${JSON.parse(readFileSync(join(VENDOR, "node_modules", "esbuild", "package.json"), "utf8")).version}.\n${body}\n`);
	writeFileSync(
		join(stubDir, "package.json"),
		`${JSON.stringify({ name: "esbuild", version: "0.0.0-gah-stub", type: "module", main: "./index.js", exports: "./index.js" }, null, 2)}\n`,
	);
}
mkdirSync(join(tree, "gah-policy", "extensions"), { recursive: true });
cpSync(join(policyPack, "extensions"), join(tree, "gah-policy", "extensions"), { recursive: true });
// Optional shortcut icon: a .ico beside the config, carried at the zip root.
// The installer copies it to %LOCALAPPDATA%\gah\shortcut.ico (stable across
// updates) and points the desktop shortcut at it; absent = the stock icon.
// Windows only: the Linux menu entry uses the desktop's stock terminal icon.
const icon = cfg.icon && opt.platform === "windows" ? resolve(dirname(opt.config), cfg.icon) : null;
if (icon && !existsSync(icon)) fail(`icon not found: ${icon}`);
if (icon) cpSync(icon, join(tree, "shortcut.ico"));
const systemMd = cfg.systemMd ? resolve(dirname(opt.config), cfg.systemMd) : join(policyPack, "SYSTEM.md");
if (!existsSync(systemMd)) fail(`SYSTEM.md not found: ${systemMd}`);
cpSync(systemMd, join(tree, "gah-policy", "SYSTEM.md"));
writeFileSync(join(tree, "gah-policy", "providers.json"), `${JSON.stringify(cfg.providers, null, 2)}\n`);
cpSync(join(REPO, "templates", "deploy", "preflight.mjs"), join(tree, "preflight.mjs"));
// Setup skills (#135): the built-in, generic ones, and optionally the
// deployment's own. The onboarding extension loads the deployment's first, so
// one with the same name (setup-gitlab, say) replaces the built-in step.
if (cfg.setupSkills !== false) cpSync(join(policyPack, "setup-skills"), join(tree, "gah-policy", "setup-skills"), { recursive: true });
if (cfg.setupSkills) {
	const dir = resolve(dirname(opt.config), cfg.setupSkills);
	if (!existsSync(dir)) fail(`setupSkills folder not found: ${dir}`);
	checkSetupSkills(dir);
	const out = join(tree, "gah-policy", "deploy-setup-skills");
	cpSync(dir, out, { recursive: true });
	// Setup skills are started by the person, never picked by the model (#138).
	for (const e of readdirSync(out, { withFileTypes: true })) {
		if (!e.isDirectory()) continue;
		const md = join(out, e.name, "SKILL.md");
		const text = readFileSync(md, "utf8");
		if (/^disable-model-invocation:/m.test(text.match(/^---\r?\n([\s\S]*?)\r?\n---/)?.[1] ?? "")) continue;
		writeFileSync(md, text.replace(/^(---\r?\n[\s\S]*?)(\r?\n---)/, "$1\ndisable-model-invocation: true$2"));
	}
}
for (const f of P.launcher) {
	if (f.endsWith(".sh")) {
		// LF whatever the checkout has: a Windows checkout with core.autocrlf
		// gives CRLF, and bash then fails on its first line ("set: pipefail:
		// invalid option name"). Executable in the zip, which records Unix modes.
		writeFileSync(join(tree, f), readFileSync(join(launcherSrc, f), "utf8").replace(/\r\n/g, "\n"));
		chmodSync(join(tree, f), 0o755);
	} else cpSync(join(launcherSrc, f), join(tree, f));
}

// tools: pinned archives + checksums; the installer verifies and unpacks them
const archs = cfg[P.archKey] ?? ["x64"];
const toolsDir = join(tree, "tools");
mkdirSync(toolsDir, { recursive: true });
const cache = join(opt.out, "tools-cache");
const sums = [];
for (const arch of archs) {
	const platform = `${P.toolPlatform}-${arch}`;
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
	icon: icon ? "shortcut.ico" : null,
	version: cfg.version,
	packageName: name,
	gahVersion,
	gitlab: {
		url: cfg.gitlab.url,
		project: cfg.gitlab.project,
		package: registryPackage,
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
	platform: opt.platform,
	inferenceProxy: cfg.inferenceProxy ?? null,
	[P.archKey]: archs,
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
	console.warn("package: no bash found (Git for Windows?) — skipping the tool-surface check of the assembled tree. Run it on a machine with bash, or trust CI, before publishing.");
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
console.log(`\n✓ ${zip}\n  sha256 ${sha}\n  gah ${gahVersion} (upstream ${syncState.ref}, gah ${gahRev}), ${opt.platform} ${archs.join("/")}, registry package ${deploy.gitlab.package}`);
