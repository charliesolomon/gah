// Unit tests for extensions/lib/secrets.ts. Run: make test-policy
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
	commandReferencesSecret,
	globToRegExp,
	isSecretPath,
	loadSecretValues,
	parseSecretGlobs,
	redactText,
	resolveSecretFiles,
	unquoteValue,
} from "../extensions/lib/secrets.ts";

const HOME = "/home/agent";
const CWD = "/home/agent/work";
const sep = process.platform === "win32" ? ";" : ":";
const patterns = parseSecretGlobs(`$HOME/*.env${sep}~/.aws/*${sep}/etc/gah/providers.json`, HOME);

test("parseSecretGlobs expands ~ and $HOME and splits on the PATH delimiter", () => {
	assert.deepEqual(patterns, ["/home/agent/*.env", "/home/agent/.aws/*", "/etc/gah/providers.json"]);
	assert.deepEqual(parseSecretGlobs(undefined), []);
	assert.deepEqual(parseSecretGlobs("  ", HOME), []);
});

test("globToRegExp: * stays in a segment, ** crosses, dots are literal", () => {
	assert.ok(globToRegExp("/h/*.env").test("/h/a.env"));
	assert.ok(!globToRegExp("/h/*.env").test("/h/x/a.env"));
	assert.ok(globToRegExp("/h/**/*.env").test("/h/x/y/a.env"));
	assert.ok(!globToRegExp("/h/a.env").test("/h/aXenv"));
});

test("isSecretPath: literal, ~, $HOME, relative to cwd, and non-matches", () => {
	assert.ok(isSecretPath("/home/agent/grace-tickets.env", patterns, CWD, HOME));
	assert.ok(isSecretPath("~/grace-tickets.env", patterns, CWD, HOME));
	assert.ok(isSecretPath("$HOME/.aws/credentials", patterns, CWD, HOME));
	assert.ok(isSecretPath("../grace-tickets.env", patterns, CWD, HOME));
	assert.ok(!isSecretPath("~/work/notes.txt", patterns, CWD, HOME));
	assert.ok(!isSecretPath("~/grace-tickets.env.example", patterns, CWD, HOME));
	assert.ok(!isSecretPath("/etc/gah/providers.json.bak", patterns, CWD, HOME));
});

test("commandReferencesSecret: the shapes a debugging model actually types", () => {
	const env = { GRACE_TICKETS_ENV: "/home/agent/grace-tickets.env", HOME };
	const files = ["/home/agent/grace-tickets.env", "/home/agent/.aws/credentials"];
	const ref = (cmd: string) => commandReferencesSecret(cmd, patterns, files, env, CWD, HOME);
	assert.equal(ref("cat /home/agent/grace-tickets.env"), "/home/agent/grace-tickets.env");
	assert.equal(ref("cat ~/grace-tickets.env"), "~/grace-tickets.env");
	assert.equal(ref('cat "$HOME/grace-tickets.env"'), '"$HOME/grace-tickets.env"');
	assert.equal(ref("cat $GRACE_TICKETS_ENV"), "$GRACE_TICKETS_ENV");
	assert.equal(ref("cat ${GRACE_TICKETS_ENV}"), "${GRACE_TICKETS_ENV}");
	assert.equal(ref("source ~/grace-tickets.env; env | grep OST"), "~/grace-tickets.env");
	assert.equal(ref("grep PASS ~/*.env"), "~/*.env");
	assert.equal(ref("cat ~/.aws/*"), "~/.aws/*");
	assert.equal(ref("cp ../grace-tickets.env /tmp/x"), "../grace-tickets.env");
	assert.equal(ref("python3 -c 'print(open(\"/home/agent/.aws/credentials\").read())'"), '"/home/agent/.aws/credentials"', "a quoted path inside a python one-liner is still a word");
	assert.equal(ref("python3 -c 'import os; print(open(os.environ[\"GRACE_TICKETS_ENV\"]).read())'"), null, "indirection through a language: layer 3 covers it");
	assert.equal(ref("Get-Content $env:GRACE_TICKETS_ENV"), "$env:GRACE_TICKETS_ENV");
	// Legitimate work is untouched
	assert.equal(ref("~/.gah/skills-repo/bin/my-tickets.sh"), null);
	assert.equal(ref("ls ~/work; cat ~/work/notes.env.md"), null);
	assert.equal(ref("cat ~/grace-tickets.env.example"), null);
	assert.equal(ref("echo $GRACE_TICKETS_DIR"), null);
	assert.equal(commandReferencesSecret("cat ~/a.env", [], [], env, CWD, HOME), null, "no patterns = no policy");
});

test("unquoteValue handles printf %q, double, single and ANSI-C quoting", () => {
	assert.equal(unquoteValue("pa\\ ss\\$w0rd"), "pa ss$w0rd");
	assert.equal(unquoteValue('"hunter22"'), "hunter22");
	assert.equal(unquoteValue("'hunter22'"), "hunter22");
	assert.equal(unquoteValue("$'hun\\'ter22'"), "hun'ter22");
	assert.equal(unquoteValue("hunter22   # comment"), "hunter22");
});

test("loadSecretValues + resolveSecretFiles + redactText on a real temp tree", () => {
	const dir = mkdtempSync(join(tmpdir(), "gah-secrets-"));
	try {
		mkdirSync(join(dir, ".aws"));
		writeFileSync(join(dir, "grace-tickets.env"), [
			"# comment",
			"export OSTICKET_USERID=csolomon",
			"export OSTICKET_PASSWD=Sw0rdf1sh\\!42",
			"GRACE_TICKETS_DIR=/opt/grace-tickets",
			"SHORT_TOKEN=ab",
		].join("\n"));
		writeFileSync(join(dir, ".aws", "credentials"), "[default]\naws_access_key_id = AKIAEXAMPLE12345\naws_secret_access_key = wJalrXUtnFEMI/K7MDENG\n");
		writeFileSync(join(dir, "notes.txt"), "not a secret");
		const pats = parseSecretGlobs(`${dir}/*.env${sep}${dir}/.aws/*`, HOME);
		const files = resolveSecretFiles(pats);
		assert.deepEqual(files.map((f) => f.slice(dir.length + 1)).sort(), [".aws/credentials", "grace-tickets.env"]);
		const values = loadSecretValues(files);
		const keys = values.map((v) => `${v.file}:${v.key}`).sort();
		assert.deepEqual(keys, ["credentials:aws_access_key_id", "credentials:aws_secret_access_key", "grace-tickets.env:OSTICKET_PASSWD"]);
		assert.ok(!keys.some((k) => k.includes("USERID")), "usernames are not redacted");
		assert.ok(!keys.some((k) => k.includes("SHORT_TOKEN")), "values under 6 chars are skipped");
		const out = redactText("pw is Sw0rdf1sh!42 and key wJalrXUtnFEMI/K7MDENG twice wJalrXUtnFEMI/K7MDENG; user csolomon", values);
		assert.equal(out.text, "pw is [redacted:grace-tickets.env:OSTICKET_PASSWD] and key [redacted:credentials:aws_secret_access_key] twice [redacted:credentials:aws_secret_access_key]; user csolomon");
		assert.deepEqual(out.hits.map((h) => `${h.key}x${h.count}`).sort(), ["OSTICKET_PASSWDx1", "aws_secret_access_keyx2"]);
		assert.deepEqual(redactText("nothing here", values).hits, []);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
