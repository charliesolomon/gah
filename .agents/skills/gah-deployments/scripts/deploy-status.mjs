#!/usr/bin/env node
/**
 * deploy-status.mjs — the facts the gah-deployments skill needs before it
 * builds anything, computed rather than guessed. Read-only; touches no network
 * unless --fetch is given (then only `git fetch` of this gah checkout).
 *
 *   node .agents/skills/gah-deployments/scripts/deploy-status.mjs [--config <gah-deploy.json>] [--published <version>] [--fetch] [--json]
 *
 * --published: the newest version on the deployment project's package registry
 * page, as the admin reads it. Without it the config's version is taken as
 * published, which is wrong when the config was already raised for a build
 * that has not been published yet.
 *
 * Reports:
 *   checkout  this gah checkout: upstream pi version, gah commit, dirty or not,
 *             behind origin/main or not, and whether the build is current
 *             (dist older than the last change to vendor/ or the policy pack,
 *             or older than the last model-data change, which needs the FULL build)
 *   config    the deployment config checked against docs/DEPLOY-WINDOWS.md:
 *             required fields, unknown keys, allowed hosts covering every
 *             provider endpoint, referenced files present, version format
 *   version   a proposed next package version the packaged launcher accepts.
 *             The launcher compares with PowerShell's [version]: digits and
 *             dots only, two to four parts. "1.0.4-1" would break every
 *             consumer's update check; "1.0.4.1" is fine.
 *   readme    the deployment project's README.md: present, and no template
 *             placeholders left in it
 *
 * Exit status: 0 when nothing blocks a build, 1 when something does.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
const args = process.argv.slice(2);
const opt = { config: undefined, published: undefined, fetch: false, json: false };
for (let i = 0; i < args.length; i++) {
	if (args[i] === "--config") opt.config = resolve(args[++i] ?? "");
	else if (args[i] === "--published") opt.published = args[++i];
	else if (args[i] === "--fetch") opt.fetch = true;
	else if (args[i] === "--json") opt.json = true;
	else if (args[i] === "-h" || args[i] === "--help") {
		console.log("usage: deploy-status.mjs [--config <gah-deploy.json>] [--published <version>] [--fetch] [--json]");
		process.exit(0);
	} else {
		console.error(`deploy-status: unknown argument ${args[i]}`);
		process.exit(2);
	}
}

const blockers = [], warnings = [];
const git = (...a) => {
	try {
		return execFileSync("git", ["-C", REPO, ...a], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
	} catch {
		return "";
	}
};

// --- the gah checkout ------------------------------------------------------------
const syncState = Object.fromEntries(
	(existsSync(join(REPO, ".sync-state")) ? readFileSync(join(REPO, ".sync-state"), "utf8") : "")
		.split(/\r?\n/).filter(Boolean).map((l) => l.split("=").map((v) => v.trim())),
);
const caPkg = join(REPO, "vendor", "pi", "packages", "coding-agent", "package.json");
const gahVersion = existsSync(caPkg) ? JSON.parse(readFileSync(caPkg, "utf8")).version : undefined;
if (opt.fetch) git("fetch", "-q", "origin", "main");
const head = git("rev-parse", "--short", "HEAD");
const branch = git("branch", "--show-current");
const dirty = git("status", "--porcelain").split("\n").filter(Boolean).length;
const behind = Number(git("rev-list", "--count", "HEAD..origin/main") || 0);
const ahead = Number(git("rev-list", "--count", "origin/main..HEAD") || 0);
const bundle = join(REPO, "vendor", "pi", "packages", "coding-agent", "dist", "bundle", "cli.js");
const builtAt = existsSync(bundle) ? statSync(bundle).mtimeMs / 1000 : 0;
const lastSource = Number(git("log", "-1", "--format=%ct", "--", "vendor", "packages/policy-pack") || 0);
const lastSeed = Number(git("log", "-1", "--format=%ct", "--", "packages/policy-pack/model-data") || 0);
let build = "current";
if (!builtAt) build = "missing";
else if (builtAt < lastSeed) build = "stale-seed";
else if (builtAt < lastSource) build = "stale";
const checkout = { upstream: syncState.ref, gahVersion, head, branch, dirty, behind, ahead, build };
if (branch !== "main") warnings.push(`the gah checkout is on '${branch}', not main: packages should be built from main`);
if (dirty) warnings.push(`the gah checkout has ${dirty} uncommitted change(s): the package would carry them`);
if (behind) blockers.push(`the gah checkout is ${behind} commit(s) behind origin/main: pull first`);
if (build === "missing") blockers.push("no build: run the full build (cd vendor/pi; npm ci --ignore-scripts; npm run build)");
if (build === "stale-seed") blockers.push("the model data changed after the last build: run the FULL build (npm run build), not build:offline");
if (build === "stale") blockers.push("the source or its dependencies changed after the last build: npm ci --ignore-scripts, then npm run build");

// --- the deployment config -------------------------------------------------------
const KNOWN = new Set(["$comment", "org", "name", "shortcutName", "icon", "version", "gitlab", "skills", "env", "providers", "systemMd", "windowsArch", "linuxArch", "setupSkills", "skillsNudge", "inferenceProxy"]);
const KNOWN_GITLAB = new Set(["url", "project", "package", "clientCert", "clientCertIssuer", "proxy"]);
const KNOWN_ENV = new Set(["GAH_BUILTIN_MODELS", "GAH_ALLOWED_HOSTS", "GAH_ALLOW_TOOLS", "GAH_SECRET_FILES", "GAH_ALLOW_SHARE"]);
const VERSION_RE = /^\d+(\.\d+){1,3}$/;
let config, cfg;
if (opt.config) {
	config = { path: opt.config, problems: [] };
	const p = (m) => config.problems.push(m);
	try {
		cfg = JSON.parse(readFileSync(opt.config, "utf8").replace(/^﻿/, ""));
	} catch (e) {
		blockers.push(`config: cannot read ${opt.config}: ${e.message}`);
	}
	if (cfg) {
		const dir = dirname(opt.config);
		for (const k of Object.keys(cfg)) if (!KNOWN.has(k)) p(`unknown top-level key '${k}' (ignored by the packager)`);
		for (const k of ["org", "version"]) if (!cfg[k]) blockers.push(`config: '${k}' is required`);
		if (cfg.version && !VERSION_RE.test(cfg.version)) blockers.push(`config: version '${cfg.version}' is not digits and dots (2-4 parts); the launcher's update check would fail`);
		const gl = cfg.gitlab ?? {};
		for (const k of ["url", "project"]) if (!gl[k]) blockers.push(`config: 'gitlab.${k}' is required`);
		for (const k of Object.keys(gl)) if (!KNOWN_GITLAB.has(k) && k !== "linuxPackage") p(`unknown key 'gitlab.${k}'`);
		if (gl.clientCert !== undefined && gl.clientCert !== null && gl.clientCert !== "user") p(`gitlab.clientCert is '${gl.clientCert}'; expected "user" or null`);
		if (!cfg.skills?.project) blockers.push("config: 'skills.project' is required (consumers fetch skills from it)");
		const env = cfg.env ?? {};
		for (const k of Object.keys(env)) if (!KNOWN_ENV.has(k)) p(`env '${k}' is not one the launcher documents`);
		const hosts = String(env.GAH_ALLOWED_HOSTS ?? "").split(",").map((h) => h.trim().toLowerCase()).filter(Boolean);
		if (!hosts.length) blockers.push("config: env.GAH_ALLOWED_HOSTS is empty: the agent could reach no model");
		const glob = (g) => new RegExp(`^${g.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")}$`);
		const providers = cfg.providers?.providers ?? [];
		if (!providers.length) blockers.push("config: providers.providers is empty");
		for (const pr of providers) {
			if (!pr.name) p("a provider has no name");
			if (!pr.models?.length) blockers.push(`config: provider '${pr.name}' lists no models`);
			let host;
			try {
				host = new URL(pr.baseUrl).hostname.toLowerCase();
			} catch {
				blockers.push(`config: provider '${pr.name}' has no valid baseUrl`);
				continue;
			}
			if (hosts.length && !hosts.some((h) => h === "*" || glob(h).test(host))) blockers.push(`config: provider '${pr.name}' host ${host} is not in GAH_ALLOWED_HOSTS`);
			if (typeof pr.apiKey === "string" && pr.apiKey && !pr.apiKey.startsWith("$")) p(`provider '${pr.name}' has a literal apiKey: it would ship inside every package. Use "$VAR" or /login`);
		}
		for (const k of ["systemMd", "icon", "setupSkills"]) if (cfg[k] && !existsSync(resolve(dir, cfg[k]))) blockers.push(`config: ${k} '${cfg[k]}' does not exist next to the config`);
		if (cfg.inferenceProxy && !/^https?:\/\/\S+$/.test(String(cfg.inferenceProxy))) blockers.push("config: inferenceProxy must be an http(s):// URL");
		if (cfg.skillsNudge !== undefined && typeof cfg.skillsNudge !== "boolean") blockers.push("config: skillsNudge must be true or false");
		const readme = join(dir, "README.md");
		config.readme = existsSync(readme) ? "present" : "missing";
		if (existsSync(readme)) {
			const left = [...new Set(readFileSync(readme, "utf8").match(/<(Org|org|name|admin contact|provider)>/g) ?? [])];
			if (left.length) p(`README.md still has template placeholders: ${left.join(", ")}`);
		} else p("no README.md next to the config: copy templates/deploy/DEPLOY-PROJECT-README.md and fill it in");
		config.org = cfg.org;
		config.version = cfg.version;
		// The same defaults as scripts/package.mjs: one registry package holds
		// <name>-win11-<version>.zip and <name>-linux-<version>.zip.
		config.name = cfg.name ?? `gah-${String(cfg.org ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")}`;
		config.package = gl.package ?? config.name;
		for (const [k, v] of [["name", config.name], ["gitlab.package", config.package]]) if (!/^[a-z0-9][a-z0-9._-]*$/.test(v)) blockers.push(`config: ${k} '${v}' must be lower-case letters, digits, '.', '_' and '-'`);
		if (gl.linuxPackage !== undefined) blockers.push("config: gitlab.linuxPackage is gone; both platforms publish into gitlab.package (default: name). Remove it");
		config.gitlab = gl.url && gl.project ? `${gl.url.replace(/\/$/, "")}/${gl.project}` : undefined;
		config.mutualTls = gl.clientCert === "user";
		config.skillsProject = cfg.skills?.project;
		config.providers = providers.map((pr) => `${pr.name} (${(pr.models ?? []).length} model${(pr.models ?? []).length === 1 ? "" : "s"}${pr.tools === "prompted" ? ", prompted tools" : ""})`);
		for (const m of config.problems) warnings.push(`config: ${m}`);
	}
}

// --- the next package version -----------------------------------------------------
const parts = (v) => v.split(".").map(Number);
const cmp = (a, b) => {
	const x = parts(a), y = parts(b);
	for (let i = 0; i < Math.max(x.length, y.length); i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) - (y[i] ?? 0);
	return 0;
};
let version;
if (cfg?.version && VERSION_RE.test(cfg.version) && gahVersion && VERSION_RE.test(gahVersion)) {
	if (opt.published && !VERSION_RE.test(opt.published)) blockers.push(`--published '${opt.published}' is not digits and dots`);
	// What is already out: the registry's newest when the admin read it, else
	// the config's own number.
	const published = opt.published && VERSION_RE.test(opt.published) ? opt.published : undefined;
	if (published && cmp(cfg.version, published) > 0) {
		version = { current: cfg.version, published, gah: gahVersion, proposed: cfg.version, unpublished: true, scheme: "as configured", why: `the config already names ${cfg.version}, above the published ${published}: build it as it is` };
	}
}
if (!version && cfg?.version && VERSION_RE.test(cfg.version) && gahVersion && VERSION_RE.test(gahVersion)) {
	const cur = opt.published && VERSION_RE.test(opt.published) && cmp(opt.published, cfg.version) > 0 ? opt.published : cfg.version;
	const triple = cur.split(".").slice(0, 3).join(".");
	// A deployment "mirrors" gah when its version reads as a gah version no newer
	// than this checkout's (0.87.0, 1.0.4, 1.0.4.1). Otherwise it numbers its own
	// releases (2.3.0) and gets an ordinary minor bump.
	const mirrors = cmp(triple, gahVersion) <= 0;
	let next, why;
	if (mirrors && cmp(gahVersion, triple) > 0) {
		next = gahVersion;
		why = `a newer gah build (${gahVersion}) than the one ${cur} names; matching gah's version keeps "which gah is this?" answerable at a glance`;
	} else if (mirrors) {
		const p = parts(cur);
		while (p.length < 4) p.push(0);
		p[3] += 1;
		next = p.join(".");
		why = `the same gah build again (a config, icon or SYSTEM.md change); a fourth part keeps it above ${cur} without naming a gah release that does not exist`;
	} else {
		const p = parts(cur);
		next = `${p[0]}.${(p[1] ?? 0) + 1}.0`;
		why = `this deployment numbers its own releases; a minor bump. Use a patch bump instead if only the config changed`;
	}
	version = { current: cur, published: opt.published, gah: gahVersion, proposed: next, why, scheme: mirrors ? "mirrors gah's version" : "independent" };
}

const out = { repo: REPO, checkout, config, version, blockers, warnings, ok: blockers.length === 0 };
if (opt.json) {
	console.log(JSON.stringify(out, null, 2));
} else {
	const L = (s = "") => console.log(s);
	L(`gah checkout   ${REPO}`);
	L(`  upstream pi  ${checkout.upstream ?? "?"}   gah ${checkout.gahVersion ?? "?"}   ${checkout.branch}@${checkout.head}`);
	L(`  state        ${dirty ? `${dirty} uncommitted` : "clean"}, ${behind ? `${behind} behind origin/main` : "up to date with origin/main"}${opt.fetch ? "" : " (as of the last fetch)"}, build ${build}`);
	if (config) {
		L();
		L(`deployment     ${config.path}`);
		if (cfg) {
			L(`  org          ${config.org}   registry package '${config.package}' (${config.name}-win11-*.zip, ${config.name}-linux-*.zip)   version ${config.version}`);
			L(`  gitlab       ${config.gitlab ?? "?"}${config.mutualTls ? "   (mutual TLS)" : ""}`);
			L(`  skills       ${config.skillsProject ?? "?"}`);
			L(`  providers    ${config.providers.join("; ") || "none"}`);
			L(`  README.md    ${config.readme}`);
		}
	}
	if (version) {
		L();
		L(version.unpublished ? `next version   ${version.proposed} (already in the config; published is ${version.published})` : `next version   ${version.current} -> ${version.proposed}   (${version.scheme})${version.published ? "" : "   [pass --published <registry's newest> to be sure]"}`);
		L(`  why          ${version.why}`);
	}
	if (warnings.length) {
		L();
		for (const w of warnings) L(`  ! ${w}`);
	}
	L();
	if (blockers.length) for (const b of blockers) L(`  ✗ ${b}`);
	else L("  ✓ nothing blocks a build");
}
process.exit(blockers.length ? 1 : 0);
