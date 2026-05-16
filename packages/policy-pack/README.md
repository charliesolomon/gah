# @gah/policy-pack

The GAH policy layer, packaged as a [pi-package](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/packages.md). All custom behavior — tool allowlists, audit logging, system prompt overrides, branding, default skills — lives here.

## Contents

| Path | Purpose |
|------|---------|
| `extensions/policy.ts` | Tool allowlist, audit logging, protected-path guard |
| `extensions/branding.ts` | System-prompt header, footer/banner customization |
| `skills/` | Default skills shipped with GAH |
| `prompts/` | Default prompt templates |
| `SYSTEM.md` | System-prompt override (loaded by `branding.ts`) |

## Why everything is here

Every line in this package has **zero merge conflict cost** when we sync upstream PI. The patch series in `../../patches/` only contains things that genuinely cannot be expressed as extensions (branding strings baked into binaries, hard removal of provider source files).

Rule of thumb: if you're tempted to write a patch, first check whether the [PI extension API](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/extensions.md) has a hook for it. It almost always does.
