// Unit tests for scripts/scrub-session.mjs against a synthetic session. Run: make test-policy
import assert from "node:assert/strict";
import { test } from "node:test";
import {
	createScrubber,
	emptyIdentifiers,
	leakCheck,
	learnFromConfig,
	learnFromEnv,
	learnFromText,
	learnSecretsFromEnvFile,
	learnWords,
	parseArgs,
	scrubEntry,
	scrubSession,
	sessionCwd,
} from "../../../scripts/scrub-session.mjs";

const ENV = {
	HOME: "/home/csolomon",
	USER: "csolomon",
	HTTPS_PROXY: "http://proxyuser:pw@proxy.corp.example:3128",
	NO_PROXY: "localhost,.grace.internal,10.0.0.0/8",
	AWS_PROFILE: "grace-bedrock",
};
const RESOLV = "nameserver 10.1.1.1\nsearch ad.gracesimi.com gracesimi.com\n";
const PROVIDERS = {
	providers: [
		{
			name: "acme-gateway",
			baseUrl: "https://llm-gateway.acme-corp.com/v1",
			api: "openai-completions",
			apiKey: "$ACME_KEY",
			models: [{ id: "acme-large", name: "Acme Large" }],
		},
	],
};
const DEPLOY = { org: "Grace Schools", gitlab: { url: "https://gitlab.gracesimi.com", proxy: null, token: "glpat-abcdefghijklmnopqrstuv" } };

function ids() {
	const i = emptyIdentifiers();
	learnFromEnv(i, ENV, { hostname: "charlie-laptop", resolvConf: RESOLV });
	learnFromConfig(i, PROVIDERS);
	learnFromConfig(i, DEPLOY);
	return i;
}

test("learning: env, resolv.conf, providers and deploy configs", () => {
	const i = ids();
	assert.ok(i.home.has("/home/csolomon"));
	assert.ok(i.user.has("csolomon"));
	assert.ok(i.host.has("charlie-laptop"));
	assert.ok(i.host.has("proxy.corp.example"), "proxy host learned without its credentials");
	assert.ok(!i.url.has(ENV.HTTPS_PROXY), "proxy credentials are not stored as a url");
	assert.ok(i.domain.has("grace.internal") && i.domain.has("ad.gracesimi.com") && i.domain.has("gracesimi.com"));
	assert.ok(i.word.has("grace-bedrock"));
	assert.ok(i.provider.has("acme-gateway"));
	assert.ok(i.url.has("https://llm-gateway.acme-corp.com/v1") && i.host.has("llm-gateway.acme-corp.com"));
	assert.ok(i.model.has("acme-large") && i.model.has("Acme Large"));
	assert.ok(i.org.has("Grace Schools"));
	assert.ok(i.host.has("gitlab.gracesimi.com"));
	assert.ok(i.secret.has("glpat-abcdefghijklmnopqrstuv"));
	assert.ok(!i.secret.has("$ACME_KEY"), "an env-var reference is not a secret value");
});

test("learning: models.json keyed providers, secret env files, words", () => {
	const i = emptyIdentifiers();
	learnFromConfig(i, { providers: { corp: { baseUrl: "https://inference.corp.example/openai/v1", api: "openai-completions", models: [{ id: "gpt-5" }, { id: "gemini-3.7-flash", name: "Gemini 3.7" }] } } });
	assert.ok(i.provider.has("corp"));
	assert.ok(i.host.has("inference.corp.example"));
	assert.ok(i.model.has("gemini-3.7-flash") && !i.host.has("gemini-3.7-flash"), "a dotted model id is a model, not a host (#96)");
	assert.equal(createScrubber(i).scrubText("switched to gemini-3.7-flash"), "switched to <model-1>");
	learnSecretsFromEnvFile(i, 'OSTICKET_USER=charlie\nOSTICKET_PASSWORD="s3cr3t-value"\nexport API_TOKEN=tok_1234567890 # comment\nSHORT_TOKEN=abc\n');
	assert.ok(i.secret.has("s3cr3t-value") && i.secret.has("tok_1234567890"));
	assert.ok(!i.secret.has("charlie") && !i.secret.has("abc"));
	learnWords(i, "# names\nSimi Valley\nZach   # a person\n\n");
	assert.deepEqual([...i.word], ["Simi Valley", "Zach"]);
});

test("scrubText: learned identifiers become stable, numbered placeholders", () => {
	const s = createScrubber(ids(), { cwd: "/home/csolomon/gah" });
	const t = s.scrubText(
		"cd /home/csolomon/gah && curl https://llm-gateway.acme-corp.com/v1/models via acme-gateway (acme-large) on charlie-laptop; " +
		"again: /home/csolomon/gah/vendor and LLM-Gateway.ACME-corp.com and CSOLOMON@charlie-laptop; org Grace Schools; profile grace-bedrock",
	);
	assert.equal(t.includes("csolomon"), false);
	assert.equal(t.includes("acme"), false);
	assert.equal(t.includes("laptop"), false);
	// Learned hosts are numbered longest-first (so a host containing another is replaced whole).
	assert.equal(
		t,
		"cd <cwd> && curl <url-1>/models via <provider-1> (<model-1>) on <host-2>; " +
			"again: <cwd>/vendor and <host-1> and <user>@<host-2>; org <org-1>; profile <word-1>",
	);
	const m = s.mapping();
	assert.equal(m["<url-1>"], "https://llm-gateway.acme-corp.com/v1");
	assert.equal(m["<host-1>"], "llm-gateway.acme-corp.com");
	assert.equal(m["<host-2>"], "charlie-laptop");
	assert.equal(m["<cwd>"], "/home/csolomon/gah");
	assert.equal(m["<user>"], "csolomon");
	assert.ok(s.counts().host >= 3);
	// Stable: the same input maps to the same placeholders on a second call.
	assert.equal(s.scrubText("on charlie-laptop via acme-gateway"), "on <host-2> via <provider-1>");
});

test("scrubText: generic patterns need no config", () => {
	const s = createScrubber(emptyIdentifiers());
	const t = s.scrubText(
		"see https://wiki.acme-corp.com/page?x=1 and http://localhost:3000/ok and http://127.0.0.1:8080/ok; " +
		"mail bob.smith@example.com; hosts 10.20.30.40:443 and 192.168.1.5 and 127.0.0.1 and fe80::1ff:fe23:4567:890a; " +
		"paths C:\\Users\\bob\\proj\\x.txt and \\\\fileserver\\share\\doc.docx and /srv/data/reports/q3.csv and /usr/bin/node and /etc/hosts; " +
		"box01.corp and printer.grace.internal; key AKIAIOSFODNN7EXAMPLE token glpat-zzzzzzzzzzzzzzzzzzzzzz Bearer abcdefghijklmnopqrstuvwxyz012345 password=hunter22",
	);
	assert.match(t, /see <url-1> and http:\/\/localhost:3000\/ok and http:\/\/127\.0\.0\.1:8080\/ok; /);
	assert.match(t, /mail <email-1>; hosts <ip-1>:443 and <ip-2> and 127\.0\.0\.1 and <ip-3>; /);
	assert.match(t, /paths <path-1> and <path-2> and <path-3> and \/usr\/bin\/node and \/etc\/hosts; /);
	assert.match(t, /<host-\d> and <host-\d>; key <secret-1> token <secret-2> Bearer <secret-3> password=<secret-4>$/);
	const m = s.mapping();
	const originals = new Set(Object.values(m));
	for (const o of [
		"https://wiki.acme-corp.com/page?x=1",
		"bob.smith@example.com",
		"10.20.30.40",
		"192.168.1.5",
		"fe80::1ff:fe23:4567:890a",
		"C:\\Users\\bob\\proj\\x.txt",
		"\\\\fileserver\\share\\doc.docx",
		"/srv/data/reports/q3.csv",
		"box01.corp",
		"printer.grace.internal",
		"AKIAIOSFODNN7EXAMPLE",
		"hunter22",
	]) assert.ok(originals.has(o), `mapping should hold ${o}`);
	assert.equal(m["<path-1>"], "C:\\Users\\bob\\proj\\x.txt", "text order for the path family");
	assert.equal(s.scrubText("at 12:30:45 and 2026-09-14T10:00:00"), "at 12:30:45 and 2026-09-14T10:00:00", "clock times are not IPv6");
});

test("scrubText: a domain suffix must end the hostname; learned domains win over generic ones", () => {
	const i = emptyIdentifiers();
	i.domain.add("corp.example");
	const s = createScrubber(i);
	const t = s.scrubText("box42.ad.corp.example and files.corp and corp.example itself and a.corp.example.org");
	assert.equal(t, "<host-1> and <host-2> and corp.example itself and a.corp.example.org");
	assert.equal(s.mapping()["<host-1>"], "box42.ad.corp.example");
	assert.equal(s.mapping()["<host-2>"], "files.corp");
	assert.deepEqual(leakCheck(t, i), []);
});

test("scrubText: a private key block and a JWT are one placeholder each", () => {
	const s = createScrubber(emptyIdentifiers());
	const key = "-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA\nabc\n-----END RSA PRIVATE KEY-----";
	const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c";
	const t = s.scrubText(`k:\n${key}\nj: ${jwt}\n`);
	assert.equal(t, "k:\n<secret-1>\nj: <secret-2>\n");
});

test("scrubText leaves non-identifying text, numbers, and placeholders alone", () => {
	const s = createScrubber(ids());
	const text = "Turn 3 used 1774 input tokens; version 0.85.1; see package.json and e.g. README.md; ~/.gah/skills-repo is synced.";
	assert.equal(s.scrubText(text), text);
	assert.equal(s.scrubText("<host-1> stays"), "<host-1> stays");
});

const SESSION = [
	{ type: "session", version: 3, id: "s1", timestamp: "2026-09-14T10:00:00.000Z", cwd: "/home/csolomon/gah", parentSession: "/home/csolomon/.gah/agent/sessions/x/y.jsonl" },
	{ type: "model_change", id: "e1", parentId: null, timestamp: "2026-09-14T10:00:00.100Z", provider: "acme-gateway", modelId: "acme-large" },
	{ type: "thinking_level_change", id: "e2", parentId: "e1", timestamp: "2026-09-14T10:00:00.200Z", thinkingLevel: "medium" },
	{ type: "message", id: "e3", parentId: "e2", timestamp: "2026-09-14T10:00:01.000Z", message: { role: "user", content: [{ type: "text", text: "read /home/csolomon/gah/README.md from charlie-laptop" }, { type: "image", mimeType: "image/png", data: "iVBORw0KGgo=" }] } },
	{
		type: "message", id: "e4", parentId: "e3", timestamp: "2026-09-14T10:00:02.000Z",
		message: {
			role: "assistant",
			content: [
				{ type: "thinking", thinking: "the user csolomon wants /home/csolomon/gah/README.md", thinkingSignature: "sig" },
				{ type: "text", text: "Reading it." },
				{ type: "toolCall", id: "c1", name: "read", arguments: { path: "/home/csolomon/gah/README.md" } },
			],
			api: "openai-completions", provider: "acme-gateway", model: "acme-large",
			usage: { input: 1774, output: 89, cost: { total: 0.001 } }, stopReason: "toolUse",
		},
	},
	{ type: "message", id: "e5", parentId: "e4", timestamp: "2026-09-14T10:00:03.000Z", message: { role: "toolResult", toolCallId: "c1", toolName: "read", content: [{ type: "text", text: "# gah\nsee https://gitlab.gracesimi.com/it/it-skills and proxy.corp.example\n" }], isError: false } },
	{ type: "message", id: "e6", parentId: "e5", timestamp: "2026-09-14T10:00:04.000Z", message: { role: "assistant", content: [{ type: "text", text: "Error: ECONNREFUSED 10.1.1.1:443 (proxy.corp.example)" }], errorMessage: "proxy.corp.example refused", provider: "acme-gateway", model: "acme-large", usage: {}, stopReason: "error" } },
	{ type: "compaction", id: "e7", parentId: "e6", timestamp: "2026-09-14T10:00:05.000Z", summary: "csolomon read /home/csolomon/gah/README.md", firstKeptEntryId: "e5", tokensBefore: 50000 },
	{ type: "custom", id: "e8", parentId: "e7", timestamp: "2026-09-14T10:00:06.000Z", customType: "gah-policy", data: { note: "skills at /home/csolomon/.gah/skills-repo on charlie-laptop" } },
	{ type: "session_info", id: "e9", parentId: "e8", timestamp: "2026-09-14T10:00:07.000Z", name: "work on gitlab.gracesimi.com" },
];
const SESSION_TEXT = SESSION.map((e) => JSON.stringify(e)).join("\n") + "\nnot json at all\n";

test("scrubSession: every entry type, structure preserved, identifiers gone, leak-check clean", () => {
	const i = ids();
	const cwd = sessionCwd(SESSION_TEXT);
	assert.equal(cwd, "/home/csolomon/gah");
	const s = createScrubber(i, { cwd });
	const { text, unparseable } = scrubSession(SESSION_TEXT, s);
	assert.equal(unparseable, 1);
	const out = text.trim().split("\n").map((l) => JSON.parse(l));
	assert.equal(out.length, SESSION.length + 1);
	assert.deepEqual(out.at(-1), { type: "unparseable_line_dropped", length: "not json at all".length });

	const [hdr, mc, tl, user, asst, tool, err, comp, custom, info] = out;
	assert.equal(hdr.cwd, "<cwd>");
	assert.match(hdr.parentSession, /^<home>\/\.gah\/agent\/sessions\/x\/y\.jsonl$/);
	assert.deepEqual([mc.provider, mc.modelId], ["<provider-1>", "<model-1>"]);
	assert.deepEqual(tl, SESSION[2], "non-textual entries are untouched");
	assert.equal(user.message.content[0].text, "read <cwd>/README.md from <host-1>");
	assert.match(user.message.content[1].data, /^\[image dropped: 12 chars\]$/);
	assert.equal(user.message.content[1].mimeType, "image/png");
	assert.equal(asst.message.content[0].thinking, "the user <user> wants <cwd>/README.md");
	assert.equal(asst.message.content[0].thinkingSignature, "[dropped]");
	assert.deepEqual(asst.message.content[2].arguments, { path: "<cwd>/README.md" });
	assert.deepEqual(asst.message.usage, SESSION[4].message.usage, "usage numbers untouched");
	assert.equal(asst.message.provider, "<provider-1>");
	assert.equal(tool.message.content[0].text, "# gah\nsee <url-1>/it/it-skills and <host-2>\n");
	assert.equal(err.message.content[0].text, "Error: ECONNREFUSED <ip-1>:443 (<host-2>)");
	assert.equal(err.message.errorMessage, "<host-2> refused");
	assert.equal(comp.summary, "<user> read <cwd>/README.md");
	assert.equal(comp.tokensBefore, 50000);
	assert.equal(custom.data.note, "skills at <home>/.gah/skills-repo on <host-1>");
	assert.equal(info.name, "work on <host-3>");
	for (const e of out) assert.equal(e.id, SESSION.find((x) => x.id === e.id)?.id ?? e.id, "ids preserved");

	assert.deepEqual(leakCheck(text, i), []);
	const m = s.mapping();
	assert.equal(m["<url-1>"], "https://gitlab.gracesimi.com");
	assert.equal(m["<host-3>"], "gitlab.gracesimi.com");
});

test("scrubSession options: drop tool results, drop thinking, keep images", () => {
	const s = createScrubber(ids(), { cwd: "/home/csolomon/gah" });
	const { text } = scrubSession(SESSION_TEXT, s, { dropToolResults: true, dropThinking: true, keepImages: true });
	const out = text.trim().split("\n").map((l) => JSON.parse(l));
	const tool = out[5];
	const originalLength = (SESSION[5] as any).message.content[0].text.length;
	assert.match(tool.message.content[0].text, new RegExp(`^\\[tool result dropped: ${originalLength} chars, sha256:[0-9a-f]{12}\\]$`));
	assert.equal(tool.message.toolName, "read");
	assert.equal(out[4].message.content.some((p: any) => p.type === "thinking"), false);
	assert.equal(out[3].message.content[1].data, "iVBORw0KGgo=");
});

test("leakCheck finds what a scrub missed", () => {
	const i = ids();
	const findings = leakCheck('{"text":"ssh csolomon@charlie-laptop then https://llm-gateway.acme-corp.com/v1 and 10.0.0.7 and glpat-abcdefghijklmnopqrstuv and C:\\\\Users\\\\x"}', i);
	const cats = findings.map((f) => f.category);
	for (const c of ["user", "host", "url", "ip", "secret", "path"]) assert.ok(cats.includes(c), `expected a ${c} finding in ${cats}`);
	const secret = findings.find((f) => f.category === "secret")!;
	assert.equal(secret.sample, "glp…", "secret samples are never printed whole");
});

test("scrubText: bare hostnames go unless public; --keep-hosts and --all-hosts", () => {
	const text =
		"host=gitlab.acme-corp.com then git config credential.gitlab.acme-corp.com.provider gitlab; docs at https://docs.gitlab.com/ee/ and github.com and learn.microsoft.com; " +
		"files package.json README.md e.g. mr.iid credential.helper; CI_SERVER_HOST=ci.acme-corp.net";
	const i = learnFromText(emptyIdentifiers(), text);
	assert.deepEqual([...i.host], ["gitlab.acme-corp.com", "ci.acme-corp.net"], "hosts learned from the text, public ones skipped");
	const s = createScrubber(i);
	const t = s.scrubText(text);
	assert.equal(
		t,
		"host=<host-1> then git config credential.<host-1>.provider gitlab; docs at https://docs.gitlab.com/ee/ and github.com and learn.microsoft.com; " +
			"files package.json README.md e.g. mr.iid credential.helper; CI_SERVER_HOST=<host-2>",
	);
	assert.equal(s.mapping()["<host-1>"], "gitlab.acme-corp.com");
	assert.deepEqual(leakCheck(t, i), []);

	const keep = createScrubber(emptyIdentifiers(), { keepHosts: ["acme-corp.com"] });
	assert.equal(keep.scrubText("gitlab.acme-corp.com and ci.acme-corp.net"), "gitlab.acme-corp.com and <host-1>");
	const all = createScrubber(emptyIdentifiers(), { allHosts: true });
	assert.equal(all.scrubText("see https://docs.gitlab.com/ee/ on github.com"), "see <url-1> on <host-1>");
	assert.equal(leakCheck("gitlab.acme-corp.com", emptyIdentifiers(), { keepHosts: ["acme-corp.com"] }).length, 0);
	assert.equal(leakCheck("github.com", emptyIdentifiers(), { allHosts: true }).length, 1);
});

test("SSH remotes and repository paths learned from remotes", () => {
	const i = emptyIdentifiers();
	const text =
		"origin\tgit@gitlab.acme-corp.com:it/it-skills.git (fetch)\norigin\thttps://gitlab.acme-corp.com/it/it-skills.git (push)\n" +
		"upstream\tgit@github.com:earendil-works/pi.git (fetch)\nthe repo it/it-skills has a bug; not it/it-skillsx";
	learnFromText(i, text);
	assert.deepEqual([...i.project], ["it/it-skills"]);
	assert.deepEqual([...i.host], ["gitlab.acme-corp.com"]);
	const s = createScrubber(i);
	const t = s.scrubText(text);
	assert.equal(
		t,
		"origin\t<url-1> (fetch)\norigin\t<url-2> (push)\nupstream\tgit@github.com:earendil-works/pi.git (fetch)\nthe repo <project-1> has a bug; not it/it-skillsx",
	);
	assert.equal(s.mapping()["<url-1>"], "git@gitlab.acme-corp.com:it/it-skills.git");
	assert.equal(s.mapping()["<project-1>"], "it/it-skills");
	assert.deepEqual(leakCheck(t, i), []);
});

test("certificates: PEM blocks, thumbprints, X.509 names, serials", () => {
	const s = createScrubber(emptyIdentifiers());
	const pem = "-----BEGIN CERTIFICATE-----\nMIIC+zCCAeOgAwIBAgIJ\nabc\n-----END CERTIFICATE-----";
	const t = s.scrubText(
		`cert:\n${pem}\n$thumb = 'c2087b169e487c814de24a9cc83711f6fa529686'\nsha256: AB:CD:EF:01:23:45:67:89:AB:CD:EF:01:23:45:67:89:AB:CD:EF:01\n` +
			"Subject: CN=charlie.solomon, OU=IT, O=Acme Corp, L=Simi Valley, ST=CA, C=US\nIssuer: CN=Acme Root CA, DC=acme, DC=corp\nSerial Number: 00a1b2c3d4e5f6\n" +
			"git_sslcert: CurrentUser\\MY\\c2087b169e487c814de24a9cc83711f6fa529686",
	);
	assert.equal(
		t,
		"cert:\n<certificate-1>\n$thumb = '<hex-1>'\nsha256: <hex-2>\n" +
			"Subject: CN=<dn-1>, OU=<dn-2>, O=<dn-3>, L=<dn-4>, ST=<dn-5>, C=US\nIssuer: CN=<dn-6>, DC=<dn-7>, DC=<dn-8>\nSerial Number: <hex-3>\n" +
			"git_sslcert: CurrentUser\\MY\\<hex-1>",
	);
	assert.equal(s.mapping()["<dn-3>"], "Acme Corp");
	assert.equal(s.mapping()["<certificate-1>"], pem);
	assert.deepEqual(leakCheck(t, emptyIdentifiers()), []);
	assert.equal(s.scrubText("O=Object notation, no CN here"), "O=Object notation, no CN here", "DN values only where a CN= exists");
});

test("account names after identity keys", () => {
	const s = createScrubber(emptyIdentifiers());
	assert.equal(
		s.scrubText("user=cs1234 username: charlie.solomon login='csolomon' account: acme\\cs1234 user: the person; user=<user>"),
		"user=<account-1> username: <account-2> login='<account-3>' account: <account-4>\\cs1234 user: the person; user=<user>",
	);
	assert.equal(s.scrubText('{ "user": "cs1234", "login": "c.solomon" }'), '{ "user": "<account-1>", "login": "<account-5>" }', "JSON-quoted keys too");
});

test("dotted config keys are not hostnames", () => {
	const s = createScrubber(emptyIdentifiers());
	const text = "git config user.email; matches.host and matches.thumbprint; core.autocrlf; config.site.name; a.zone; but intranet.acme-corp.co";
	assert.equal(s.scrubText(text), "git config user.email; matches.host and matches.thumbprint; core.autocrlf; config.site.name; a.zone; but <host-1>");
});

test("leakCheck inspects the strings a reader sees, not the JSON escaping", () => {
	const i = emptyIdentifiers();
	const clean = JSON.stringify({ message: { content: "present: <path-4>\\Users\\<user>\\AppData\\glab.exe`\nnext" } }) + "\n";
	assert.deepEqual(leakCheck(clean, i), [], "escaped backslashes and \\n are not a UNC path");
	const dirty = JSON.stringify({ message: { content: "cert: -----BEGIN CERTIFICATE-----\nMIIC\n-----END CERTIFICATE-----" } }) + "\n";
	assert.equal(leakCheck(dirty, i).map((f) => f.category).join(","), "certificate", "a PEM block split over escaped newlines is still found");
	assert.equal(leakCheck("plain text with 10.0.0.9", i)[0].category, "ip", "plain text still works");
});

test("markdown fragments are not URLs and never teach a host (the backtick incident)", () => {
	const text = "see `https://` and (https://( and `http://gitlab.acme-corp.com/x` and `https://$host/api` and https://[::1]/ok";
	const i = learnFromText(emptyIdentifiers(), text);
	assert.deepEqual([...i.host], ["gitlab.acme-corp.com"], "only the real host is learned");
	const s = createScrubber(i);
	const t = s.scrubText(text);
	assert.equal(t, "see `https://` and (https://( and `<url-1>` and `https://$host/api` and https://[::1]/ok");
	assert.equal((t.match(/`/g) ?? []).length, 6, "backticks survive");
	assert.deepEqual(leakCheck(t, i), []);
});

test("learned names: - and _ are boundaries, and the checker agrees with the scrubber", () => {
	const i = emptyIdentifiers();
	learnFromEnv(i, { HOME: "/home/csolomon", USER: "csolomon" }, { hostname: "spork", resolvConf: "" });
	const s = createScrubber(i);
	const text = "the spork-git-setup skill on SPORK wrote SPORK_GITLAB_WORK_ITEMS.md for csolomon_corp; sporkish and forkspork stay";
	const t = s.scrubText(text);
	assert.equal(t, "the <host-1>-git-setup skill on <host-1> wrote <host-1>_GITLAB_WORK_ITEMS.md for <user>_corp; sporkish and forkspork stay");
	assert.deepEqual(leakCheck(t, i), []);
	assert.equal(leakCheck(text, i).filter((f) => f.category === "host")[0].count, 3);
});

test("a machine name of punctuation or two characters is never learned", () => {
	const i = emptyIdentifiers();
	learnFromEnv(i, { HOSTNAME: "`", COMPUTERNAME: "pc" }, { hostname: "(", resolvConf: "" });
	assert.deepEqual([...i.host], []);
	learnFromConfig(i, { proxy: "http://(/", gitlab: { url: "https://`" } });
	assert.deepEqual([...i.host], []);
});

test("API user objects and numeric ids", () => {
	const s = createScrubber(emptyIdentifiers());
	const api =
		'{"id":165727,"iid":1,"project_id":17925,"title":"Add issue interaction","author":{"id":110272,"username":"charlie_solomon","public_email":"c.solomon@acme-corp.com","name":"Charlie Solomon (Chuck)","state":"active","avatar_url":"<url-19>"},"note_id": 1763330}';
	const t = s.scrubText(api);
	assert.equal(
		t,
		'{"id":<id-1>,"iid":1,"project_id":<id-2>,"title":"Add issue interaction","author":{"id":<id-3>,"username":"<account-1>","public_email":"<email-1>","name":"<account-2>","state":"active","avatar_url":"<url-19>"},"note_id": <id-4>}',
	);
	assert.equal(s.mapping()["<account-2>"], "Charlie Solomon (Chuck)");
	assert.equal(s.mapping()["<id-3>"], "110272");
	assert.equal(s.scrubText("username: first_last and user=a_b_c"), "username: <account-3> and user=<account-4>", "underscores are part of an account name");
	assert.equal(s.scrubText('{"name":"Acme Widget","id":42}'), '{"name":"Acme Widget","id":<id-5>}', "a name without a username in the object is not a person");
	assert.deepEqual(leakCheck(t, emptyIdentifiers()), []);

	// The same reply nested inside a JSON string (PowerShell ConvertTo-Json): quotes are escaped.
	const nested = '{"response_json": "{\\"id\\":165727,\\"project_id\\":17925,\\"author\\":{\\"id\\":110272,\\"username\\":\\"charlie_solomon\\",\\"name\\":\\"Charlie Solomon\\"}}"}';
	const s2 = createScrubber(emptyIdentifiers());
	assert.equal(
		s2.scrubText(nested),
		'{"response_json": "{\\"id\\":<id-1>,\\"project_id\\":<id-2>,\\"author\\":{\\"id\\":<id-3>,\\"username\\":\\"<account-1>\\",\\"name\\":\\"<account-2>\\"}}"}',
	);
});

test("parseArgs", () => {
	const o = parseArgs(["s.jsonl", "--drop-tool-results", "--domains", "a.corp, b.lan", "--secrets", "x.env", "--secrets", "y.env", "--no-map", "--keep-hosts", "a.com,b.io", "--all-hosts"]);
	assert.deepEqual(o.keepHosts, ["a.com", "b.io"]);
	assert.equal(o.allHosts, true);
	assert.equal(o.input, "s.jsonl");
	assert.equal(o.dropToolResults, true);
	assert.deepEqual(o.domains, ["a.corp", "b.lan"]);
	assert.deepEqual(o.secrets, ["x.env", "y.env"]);
	assert.equal(o.noMap, true);
	assert.throws(() => parseArgs(["--bogus"]), /unknown option/);
	assert.throws(() => parseArgs(["a.jsonl", "b.jsonl"]), /one session file/);
	assert.throws(() => parseArgs(["--out"]), /needs a value/);
});
