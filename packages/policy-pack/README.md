# @gah/policy-pack

The GAH policy layer, packaged as a [pi-package](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/packages.md). All harness-level behavior — tool allowlists, audit logging, system prompt overrides, branding, approved providers — lives here. Skills and prompt templates do not: they are organisation content and live in the skills repository (`docs/SKILLS.md`).

## Contents

| Path | Purpose |
|------|---------|
| `extensions/policy.ts` | Tool allowlist, audit logging, protected-path guard |
| `extensions/branding.ts` | System-prompt header, footer/banner customization |
| `extensions/providers.ts` | Approved inference endpoints from `providers.json` |
| `model-data/` | The only built-in model data a build ships (`model-data/README.md`) |
| `SYSTEM.md` | System-prompt override (loaded by `branding.ts`) |

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
