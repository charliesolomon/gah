#!/usr/bin/env node
/**
 * install-tools.mjs — install the pinned fd and ripgrep binaries GAH's find and
 * grep tools need, verified by SHA-256, with no runtime download ever needed.
 *
 * Upstream PI downloads "the latest GitHub release" of both, unpinned and
 * unverified, the first time a session finds them missing. GAH removes that
 * (patches/0013-offline-runtime.patch) and installs them here instead, at
 * deployment time, from a table of pinned versions and checksums that is
 * reviewed like any other change. See docs/SUPPLY-CHAIN.md.
 *
 *   node scripts/install-tools.mjs                      download for this machine, verify, install
 *   node scripts/install-tools.mjs --download-only DIR  fetch + verify archives into DIR, install nothing
 *   node scripts/install-tools.mjs --from DIR           install from archives in DIR; makes no network calls
 *
 * Options:
 *   --dest DIR        install directory (default: $GAH_CODING_AGENT_DIR/bin, else ~/.gah/agent/bin)
 *   --platform P      target for --download-only, e.g. win32-x64 (default: this machine)
 *   --all-platforms   with --download-only: every supported platform, for a portable bundle
 *
 * Needs only Node and the system `tar` (Windows 10+ ships one that also reads zip).
 */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync, appendFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

// --- The pins ---------------------------------------------------------------
// Hashes are SHA-256 of the release archives. ripgrep publishes a .sha256 per
// asset and every entry below matched it on 2026-09-02. fd publishes none; its
// entries are the hashes of what github.com served over TLS on that date.
// When bumping a version, refresh every entry for that tool and say in the
// commit how the fd hashes were obtained.
const PINS = {
	fd: {
		repo: "sharkdp/fd",
		version: "10.5.0",
		tag: "v10.5.0",
		binary: "fd",
		assets: {
			"linux-x64": ["fd-v10.5.0-x86_64-unknown-linux-gnu.tar.gz", "a1259cd129636efbc3fef123525c1b49e88fe5088c012630983c310e52fdfa95"],
			"linux-arm64": ["fd-v10.5.0-aarch64-unknown-linux-gnu.tar.gz", "c0ee43802e3313a317c5af2f4eabd6ba13eeedd595af9775f05e18a13ac4f52c"],
			"darwin-x64": ["fd-v10.5.0-x86_64-apple-darwin.tar.gz", "7e31028c62c6955877735d0406807aa484c2a5e6f86235a59e26c29c301da590"],
			"darwin-arm64": ["fd-v10.5.0-aarch64-apple-darwin.tar.gz", "b67e1836c468e42e411984b56e52fa7abec08c2bd22c867398e7cc134aac5e12"],
			"win32-x64": ["fd-v10.5.0-x86_64-pc-windows-msvc.zip", "a227701b8551c35a9931d9f6da75503cf86d88e182d71fb849a70864c5d57cd7"],
			"win32-arm64": ["fd-v10.5.0-aarch64-pc-windows-msvc.zip", "a2bcddcfd259b05357a77bbc6cd671fdb30f63fd266a0e748305890a8c5ceaa6"],
		},
	},
	rg: {
		repo: "BurntSushi/ripgrep",
		version: "15.2.0",
		tag: "15.2.0",
		binary: "rg",
		assets: {
			// No x86_64 glibc build is published for 15.2.0; musl is fully static.
			"linux-x64": ["ripgrep-15.2.0-x86_64-unknown-linux-musl.tar.gz", "33e15bcf1624b25cdd2a55813a47a2f95dbe126268203e76aa6a585d1e7b149c"],
			"linux-arm64": ["ripgrep-15.2.0-aarch64-unknown-linux-gnu.tar.gz", "a740b91c82eaf9914cfedd353572f2791cbe0162c84101ee0951058f4dcbc90d"],
			"darwin-x64": ["ripgrep-15.2.0-x86_64-apple-darwin.tar.gz", "af7825fcc69a2afc7a7aea55fc9af90e26421d8f20fe59df32e233c0b8a231c1"],
			"darwin-arm64": ["ripgrep-15.2.0-aarch64-apple-darwin.tar.gz", "3750b2e93f37e0c692657da574d7019a101c0084da05a790c83fd335bad973e4"],
			"win32-x64": ["ripgrep-15.2.0-x86_64-pc-windows-msvc.zip", "71b2fef860abe467217a538ff31de02f5258807c0129f771846f87bd029aafc5"],
			"win32-arm64": ["ripgrep-15.2.0-aarch64-pc-windows-msvc.zip", "e4abca10c3a64ebea742667dd7009449d49403db5460dd6873e389fa2945360f"],
		},
	},
};
const PLATFORMS = Object.keys(PINS.fd.assets);

// --- Arguments --------------------------------------------------------------
const args = process.argv.slice(2);
const opts = { dest: undefined, from: undefined, downloadOnly: undefined, platform: undefined, allPlatforms: false };
for (let i = 0; i < args.length; i++) {
	const a = args[i];
	const next = () => {
		const v = args[++i];
		if (!v) fail(`${a} needs a value`);
		return v;
	};
	if (a === "--dest") opts.dest = resolve(next());
	else if (a === "--from") opts.from = resolve(next());
	else if (a === "--download-only") opts.downloadOnly = resolve(next());
	else if (a === "--platform") opts.platform = next();
	else if (a === "--all-platforms") opts.allPlatforms = true;
	else if (a === "-h" || a === "--help") {
		console.log(readFileSync(new URL(import.meta.url), "utf8").split("\n").filter((l) => l.startsWith(" *")).map((l) => l.slice(3)).join("\n"));
		process.exit(0);
	} else fail(`unknown argument ${a}`);
}
if (opts.from && opts.downloadOnly) fail("--from and --download-only are exclusive");
if (opts.allPlatforms && !opts.downloadOnly) fail("--all-platforms only makes sense with --download-only");

const here = `${process.platform}-${process.arch}`;
const agentDir = process.env.GAH_CODING_AGENT_DIR || join(homedir(), ".gah", "agent");
const dest = opts.dest ?? join(agentDir, "bin");

function fail(msg) {
	console.error(`install-tools: ${msg}`);
	process.exit(1);
}

function sha256(path) {
	return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function verify(path, expected, label) {
	const got = sha256(path);
	if (got !== expected) {
		fail(`${label}: SHA-256 mismatch\n  expected ${expected}\n  got      ${got}\nRefusing to install. The archive is not the pinned release.`);
	}
}

function pinFor(tool, platform) {
	const entry = PINS[tool].assets[platform];
	if (!entry) fail(`no pinned ${tool} for ${platform} (supported: ${PLATFORMS.join(", ")})`);
	return { asset: entry[0], sha: entry[1], url: `https://github.com/${PINS[tool].repo}/releases/download/${PINS[tool].tag}/${entry[0]}` };
}

async function download(url, path) {
	const res = await fetch(url, { redirect: "follow" });
	if (!res.ok) fail(`${url}: HTTP ${res.status}`);
	writeFileSync(path, Buffer.from(await res.arrayBuffer()));
}

function tarCommand() {
	if (process.platform === "win32") {
		const root = process.env.SystemRoot ?? process.env.WINDIR;
		const sys = root ? join(root, "System32", "tar.exe") : undefined;
		if (sys && existsSync(sys)) return sys; // bsdtar: reads zip too
	}
	return "tar";
}

function extract(archive, into) {
	const flags = archive.endsWith(".tar.gz") ? "xzf" : "xf";
	const r = spawnSync(tarCommand(), [flags, archive, "-C", into], { stdio: "pipe" });
	if (r.error || r.status !== 0) fail(`extracting ${basename(archive)}: ${r.error?.message ?? r.stderr?.toString().trim()}`);
}

function audit(entry) {
	const path = process.env.GAH_AUDIT_LOG || join(homedir(), ".gah", "audit.log");
	try {
		mkdirSync(dirname(path), { recursive: true });
		appendFileSync(path, `${JSON.stringify({ ts: new Date().toISOString(), ...entry })}\n`);
	} catch {
		/* best effort */
	}
}

function install(tool, archive, source) {
	const pin = PINS[tool];
	const exe = process.platform === "win32" ? ".exe" : "";
	const work = mkdtempSync(join(tmpdir(), `gah-${tool}-`));
	try {
		extract(archive, work);
		const inner = join(work, basename(archive).replace(/\.(tar\.gz|zip)$/, ""), pin.binary + exe);
		if (!existsSync(inner)) fail(`${basename(archive)} did not contain ${pin.binary}${exe} where expected`);
		mkdirSync(dest, { recursive: true });
		const target = join(dest, pin.binary + exe);
		rmSync(target, { force: true });
		renameSync(inner, target);
		if (process.platform !== "win32") chmodSync(target, 0o755);
		const v = spawnSync(target, ["--version"], { stdio: "pipe" });
		const banner = v.status === 0 ? v.stdout.toString().split("\n")[0].trim() : `(--version failed: ${v.error?.message ?? v.status})`;
		console.log(`✓ ${pin.binary} ${pin.version} → ${target}   ${banner}`);
		audit({ kind: "tool_installed", tool: pin.binary, version: pin.version, sha256: sha256(archive), source, path: target });
	} finally {
		rmSync(work, { recursive: true, force: true });
	}
}

// --- Modes ------------------------------------------------------------------
if (opts.downloadOnly) {
	const targets = opts.allPlatforms ? PLATFORMS : [opts.platform ?? here];
	mkdirSync(opts.downloadOnly, { recursive: true });
	for (const platform of targets) {
		for (const tool of Object.keys(PINS)) {
			const { asset, sha, url } = pinFor(tool, platform);
			const path = join(opts.downloadOnly, asset);
			process.stdout.write(`fetching ${asset} ... `);
			await download(url, path);
			verify(path, sha, asset);
			console.log("ok");
		}
	}
	console.log(`\nArchives verified in ${opts.downloadOnly}. On the target machine:\n  node scripts/install-tools.mjs --from <that directory>`);
} else if (opts.from) {
	if (opts.platform) fail("--platform applies to --download-only; --from installs for this machine");
	// Verify everything before installing anything: a bundle with one bad
	// archive installs nothing, rather than half a toolset.
	const staged = [];
	for (const tool of Object.keys(PINS)) {
		const { asset, sha } = pinFor(tool, here);
		const path = join(opts.from, asset);
		if (!existsSync(path)) fail(`${asset} not found in ${opts.from}`);
		verify(path, sha, asset);
		staged.push([tool, path]);
	}
	for (const [tool, path] of staged) install(tool, path, opts.from);
} else {
	if (opts.platform) fail("--platform applies to --download-only");
	const work = mkdtempSync(join(tmpdir(), "gah-tools-"));
	try {
		const staged = [];
		for (const tool of Object.keys(PINS)) {
			const { asset, sha, url } = pinFor(tool, here);
			const path = join(work, asset);
			process.stdout.write(`fetching ${asset} ... `);
			await download(url, path);
			verify(path, sha, asset);
			console.log("ok");
			staged.push([tool, path, url]);
		}
		for (const [tool, path, url] of staged) install(tool, path, url);
	} finally {
		rmSync(work, { recursive: true, force: true });
	}
}
