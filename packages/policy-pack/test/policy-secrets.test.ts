// Wiring test: the policy extension refuses and redacts as configured.
// Run: make test-policy
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const dir = mkdtempSync(join(tmpdir(), "gah-policy-"));
const secretFile = join(dir, "helpdesk.env");
writeFileSync(secretFile, "export HELPDESK_USER=jsmith\nexport HELPDESK_PASSWD=Tr0ub4dor&3\n");
process.env.GAH_SECRET_FILES = `${dir}/*.env`;
process.env.GAH_ALLOW_TOOLS = "bash";
process.env.GAH_AUDIT_LOG = join(dir, "audit.log");

type Handler = (event: any, ctx?: any) => Promise<any>;
const handlers: Record<string, Handler> = {};
const fakePi = {
	on: (name: string, fn: Handler) => {
		handlers[name] = fn;
	},
	getAllTools: () => ["read", "grep", "find", "ls", "edit", "write", "bash"].map((name) => ({ name })),
	setActiveTools: (_names: string[]) => {},
};

test("policy extension: secret file layers are wired", async (t) => {
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const mod = await import("../extensions/policy.ts");
	mod.default(fakePi as any);
	await handlers.session_start({});

	// Layer 1: a file tool on the secret path is refused.
	const read = await handlers.tool_call({ toolName: "read", input: { path: secretFile } }, {});
	assert.equal(read?.block, true);
	assert.match(read.reason, /secret store/);

	// Ordinary reads still pass.
	const ok = await handlers.tool_call({ toolName: "read", input: { path: join(dir, "notes.txt") } }, {});
	assert.equal(ok, undefined);

	// Layer 2: a shell command naming the file is refused; one that does not, passes.
	const cat = await handlers.tool_call({ toolName: "bash", input: { command: `cat ${dir}/*.env` } }, {});
	assert.equal(cat?.block, true);
	const script = await handlers.tool_call({ toolName: "bash", input: { command: "~/.gah/skills-repo/bin/my-tickets.sh" } }, {});
	assert.equal(script, undefined);

	// Layer 3: the value is redacted from any tool result, the username is not.
	const result = await handlers.tool_result({
		toolName: "bash",
		toolCallId: "x",
		input: {},
		isError: false,
		content: [{ type: "text", text: "HELPDESK_USER=jsmith\nHELPDESK_PASSWD=Tr0ub4dor&3\n" }],
	});
	assert.equal(result.content[0].text, "HELPDESK_USER=jsmith\nHELPDESK_PASSWD=[redacted:helpdesk.env:HELPDESK_PASSWD]\n");
	const clean = await handlers.tool_result({ toolName: "bash", toolCallId: "y", input: {}, isError: false, content: [{ type: "text", text: "nothing" }] });
	assert.equal(clean, undefined);

	// Audit trail names the layer, never the value.
	const audit = readFileSync(process.env.GAH_AUDIT_LOG!, "utf8");
	assert.match(audit, /"reason":"secret_files"/);
	assert.match(audit, /"reason":"secret_file","tool":"read"/);
	assert.match(audit, /"reason":"secret_file","tool":"bash"/);
	assert.match(audit, /"kind":"redacted"/);
	assert.ok(!audit.includes("Tr0ub4dor"), "audit log must not carry the secret");
});
