#!/usr/bin/env node
/**
 * publish-gitlab.mjs — upload a deployment package to a GitLab generic package
 * registry, where the packaged launcher looks for updates.
 *
 *   GAH_GITLAB_TOKEN=... node scripts/publish-gitlab.mjs --config gah-deploy.json --zip dist-deploy/gah-<org>-<version>.zip [--curl] [--cert <spec>]
 *
 * --cert (or GAH_GITLAB_CLIENT_CERT): a client certificate for a GitLab behind
 * mutual TLS, in curl's syntax -- on Windows a store reference such as
 * "CurrentUser\MY\<thumbprint>" (what git's http.sslCert uses), elsewhere a PEM
 * path. Uploads then go through curl, since fetch cannot use a store cert.
 *
 * Uploads <zip> and <zip>.sha256 to
 *   <gitlab.url>/api/v4/projects/<gitlab.project>/packages/generic/<gitlab.package>/<version>/
 * The token needs `api` scope on that project (write_package_registry). The
 * launcher on consumer machines downloads with read_api, or none if the
 * project is visible to them.
 */

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { basename, resolve } from "node:path";

const args = process.argv.slice(2);
const opt = { config: undefined, zip: undefined, cert: undefined };
for (let i = 0; i < args.length; i++) {
	const a = args[i];
	if (a === "--config") opt.config = resolve(args[++i] ?? fail("--config needs a path"));
	else if (a === "--zip") opt.zip = resolve(args[++i] ?? fail("--zip needs a path"));
	else if (a === "--curl") { /* handled below */ }
	else if (a === "--cert") opt.cert = args[++i] ?? fail("--cert needs a certificate spec");
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

// curl handles corporate proxies and multi-megabyte PUTs more predictably
// than Node's fetch; Windows 10+ and every Linux ship it. Used when asked
// (--curl) or automatically when fetch's connection is cut mid-upload.
function haveCurl() {
	const r = spawnSync("curl", ["--version"], { stdio: "pipe" });
	return !r.error && r.status === 0;
}
function putWithCurl(url, file) {
	const r = spawnSync(
		"curl",
		[
			"--silent", "--show-error", "--fail-with-body",
			// Trust the same CA file Node was given; curl on Windows would otherwise consult only the OS store.
			...(process.env.NODE_EXTRA_CA_CERTS ? ["--cacert", process.env.NODE_EXTRA_CA_CERTS] : []),
			...(clientCert ? ["--cert", clientCert] : []),
			"--upload-file", file, "--header", `PRIVATE-TOKEN: ${token}`, "--write-out", "\n%{http_code}", url,
		],
		{ stdio: ["ignore", "pipe", "pipe"], encoding: "utf8" },
	);
	if (r.error) throw r.error;
	if (r.status !== 0) throw new Error(`curl exit ${r.status}: ${(r.stderr || r.stdout || "").trim().slice(0, 300)}`);
	return r.stdout.trim().split("\n").pop();
}
async function putWithFetch(url, file) {
	const res = await fetch(url, { method: "PUT", headers: { "PRIVATE-TOKEN": token }, body: readFileSync(file) });
	if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}: ${(await res.text()).slice(0, 300)}`);
	return String(res.status);
}

const clientCert = opt.cert ?? process.env.GAH_GITLAB_CLIENT_CERT;
const useCurl = process.argv.includes("--curl") || Boolean(clientCert);
const host = new URL(base).host;
// The small checksum first: if a 100-byte PUT fails, the problem is auth or
// routing, not size, and the message below can say so before 9 MB is wasted.
for (const file of [`${opt.zip}.sha256`, opt.zip]) {
	const url = `${base}/${basename(file)}?select=package_file`;
	process.stdout.write(`uploading ${basename(file)} ... `);
	try {
		if (useCurl) {
			if (!haveCurl()) fail("--curl given but curl is not on PATH");
			console.log(`ok (curl, ${putWithCurl(url, file)})`);
			continue;
		}
		console.log(`ok (${await putWithFetch(url, file)})`);
	} catch (error) {
		const cause = error?.cause ?? error;
		const code = cause?.code ?? "";
		console.log("failed");
		if (code === "UND_ERR_SOCKET" && haveCurl()) {
			// Connection cut mid-upload: try the same PUT with curl before giving up.
			process.stdout.write(`retrying ${basename(file)} with curl ... `);
			try {
				console.log(`ok (curl, ${putWithCurl(url, file)})`);
				continue;
			} catch (curlError) {
				console.log("failed");
				fail(`${cause?.message ?? error} — and curl: ${curlError.message}\n${hints(code, cause?.message)}`);
			}
		}
		fail(`${cause?.message ?? error.message ?? error}\n${hints(code, cause?.message)}`);
	}
}

function hints(code, message = "") {
	const lines = [
		`Target: ${host}. Uploads go through HTTPS_PROXY when it is set (${process.env.HTTPS_PROXY ? "it is: " + process.env.HTTPS_PROXY : "it is not"}).`,
	];
	if (/CERT_|SELF_SIGNED|UNABLE_TO_VERIFY|certificate|SSL|TLS/i.test(`${code} ${message}`)) {
		lines.push(
			"Mutual TLS: if git reaches this GitLab with http.<url>.sslCert (a client certificate), pass the same spec with --cert or GAH_GITLAB_CLIENT_CERT; uploads then go through curl.",
			"TLS trust: if the GitLab certificate comes from an internal CA, point Node at the same PEM git uses:",
			"  git config --get http.sslCAInfo   ->   setx NODE_EXTRA_CA_CERTS <that path>   (new window afterwards)",
			"The curl fallback receives the same file via --cacert.",
		);
	}
	if (code === "UND_ERR_SOCKET") {
		lines.push(
			"The connection was closed after the body was sent, with no response: a proxy that caps or scans uploads, or GitLab that is reachable only directly.",
			`If ${host} is inside your network, exclude it from the proxy: $env:NO_PROXY='${host}' (PowerShell) / export NO_PROXY=${host}.`,
			"Otherwise re-run with --curl, or upload the zip through the GitLab UI (Deploy > Package Registry) as a fallback.",
		);
	} else if (/^4/.test(String(code)) || /HTTP 40[13]/.test(String(code))) {
		lines.push("401/403: the token needs `api` scope and Developer role or higher on the deployment project; the package registry must be enabled in the project's settings.");
	}
	return lines.map((l) => `  ${l}`).join("\n");
}
console.log(`\n✓ published ${basename(opt.zip)} as ${cfg.gitlab.package ?? "gah-windows"} ${cfg.version} in ${cfg.gitlab.project}`);
console.log("Consumers pick it up on their next launch; new installs download it from the same registry.");
