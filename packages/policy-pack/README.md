# @gah/policy-pack

The GAH policy layer, packaged as a [pi-package](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/packages.md). All harness-level behavior — tool allowlists, audit logging, system prompt overrides, branding, approved providers — lives here. Skills and prompt templates do not: they are organisation content and live in the skills repository (`docs/SKILLS.md`).

## Contents

| Path | Purpose |
|------|---------|
| `extensions/policy.ts` | Tool allowlist, audit logging, protected-path guard, secret files, usage lines |
| `extensions/branding.ts` | System-prompt header, footer/banner customization |
| `extensions/providers.ts` | Approved inference endpoints from `providers.json` |
| `extensions/skills-freshness.ts` | Skills behind in-session, what changed at startup, `/skills-changelog`, `/skills-seen reset` (#91) |
| `extensions/lib/last-model.ts` | The last model picked becomes the next session's default (#77) |
| `extensions/lib/prompted-tools.ts` | Tool calling as a text protocol, for a provider marked `"tools": "prompted"` (a gateway that refuses native tool calls, #42) |
| `model-data/` | The only built-in model data a build ships (`model-data/README.md`) |
| `SYSTEM.md` | System-prompt override (loaded by `branding.ts`) |

## The audit log

Every session appends JSONL to `~/.gah/audit.log` (`$GAH_AUDIT_LOG`). Each line
has a `ts` and, from session start onward, a `session` id so a report can group
by session without parsing the transcript tree. Line `kind`s:

| `kind` | When | Key fields |
|---|---|---|
| `policy` | session start / a widen | `reason` (`active_tools`, `allowlist_widened`, `secret_files`), `tools` |
| `default_model` | the person picks a model | `provider`, `model`, `source`, `saved` |
| `allowed` / `blocked` | each tool call | `tool`, `reason` (`not_allowlisted`, `protected_path`, `secret_file`, `shell_escape`), `input`/`path`/`command` |
| `redacted` | a secret value removed from a tool result | `tool`, `hits` (`file`, `key`, `count`) |
| `turn` | each assistant turn | `model`, `provider`, `input`, `output`, `cacheRead`, `cacheWrite`, `totalTokens`, `cost` |
| `prompt` | a `/template` invocation | `name`, `source` |
| `skills` | session start / an update noticed | `reason` (`loaded`: `repos[]` of `path`, `sha`, `branch`; `behind`: `path`, `commits`) |

**Rotation.** The log is date-rotated by the extension itself (it is user-owned,
so no root logrotate is needed and the same mechanism covers the host, the
Windows package, and dev). Once per session start, if `audit.log` holds lines
from a previous day it is renamed to `audit-<that-date>.log`, and dated files
older than the retention window are deleted. Retention is `GAH_AUDIT_RETENTION_DAYS`
(default 30; `0` or negative keeps everything). A reader — the usage report,
`gah-rmuser`'s archive — must take `audit.log` **and** `audit-*.log`. Rotation is
best-effort and never blocks a write.

`turn` and `prompt` are for a deployment's **usage report** — cost attribution
by session and feature, and which prompts people actually press (issue #48).
gah aggregates nothing; the report is the deployment's business. For Bedrock the
authoritative cost is the CloudWatch invocation log; the `turn` line attributes
it, and covers providers without server-side logging. `cost` is what the
provider reported, in the provider's units.

## Skills freshness

`skills-freshness.ts` watches every `--skill` path that sits inside a git
checkout (deduplicated to the checkout root; a plain directory is ignored) and
does two things (#91):

- **In-session.** Every `GAH_SKILLS_POLL_MINUTES` (default 10; `0` = never) it
  fetches the tracking ref and compares. When the checkout is behind it shows
  *"Skill updates are available — /quit and relaunch to load them."* once,
  above the editor, and stops polling. Fetch only: the launcher owns the reset,
  so a session can never end up with a half-updated skill set. Offline is not
  an error, just no news.
- **At startup.** If the checkout's HEAD differs from the sha this person last
  used, a short summary is shown once: new entries of a `CHANGELOG.md` at the
  checkout root when it keeps one (sections keyed by `## ` heading, version or
  date), otherwise the commit subjects touching `skills/`, `bin/`, `prompts/`
  or `setup/`, capped at 8. `/skills-changelog` shows all of it.

"Last used" is `skillsSeen` (root → sha) in the agent's `settings.json`. It is
recorded when the person sends their **first prompt**, not when the summary is
drawn, so an administrator who launches under someone's account to test a
skill and quits at the prompt leaves the notice for its owner. A test session
that does send prompts sets `GAH_SKILLS_NO_MARK_SEEN=1` (`gah-launch
--no-mark-seen`) and never advances the marker; `/skills-seen reset` forgets
it after the fact. A fresh account shows nothing and records its first prompt.

## Secret files

`GAH_SECRET_FILES` names the credentials files a deployment hands its scripts
(path globs, `:`-separated; `;` on Windows), e.g. `$HOME/*.env:$HOME/.aws/*`.
`extensions/lib/secrets.ts` enforces three layers, from exact to heuristic to
last line of defence:

1. **File tools.** `read`, `write`, `edit`, and any tool with a `path` input,
   refuse a matching path.
2. **Shells.** A `bash` or `powershell` command whose words name a matching
   path — literally, via `~` or `$HOME`, through a wildcard that would match an
   existing secret file, or through an exported variable holding such a path —
   is refused with a message that points the model at the wrapper scripts.
3. **Redaction.** At first use the extension reads the secret files itself and
   collects values under secret-looking keys (`PASS*`, `SECRET`, `TOKEN`,
   `*_KEY`, `CREDENTIAL`, `AUTH`; six characters or longer). Every text tool
   result has those values replaced with `[redacted:<file>:<KEY>]` before the
   model or the transcript sees it. Usernames and paths are left alone.

Every refusal and redaction is an audit line (`blocked`/`secret_file`,
`redacted`). None of this touches subprocess file access: the skills' own
scripts source the files as before. Tests: `make test-policy`.

## Why everything is here

Every line in this package has **zero merge conflict cost** when we sync upstream PI. The patch series in `../../patches/` only contains things that genuinely cannot be expressed as extensions (branding strings baked into binaries, hard removal of provider source files).

Rule of thumb: if you're tempted to write a patch, first check whether the [PI extension API](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/extensions.md) has a hook for it. It almost always does.
