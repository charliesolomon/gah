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

## Why everything is here

Every line in this package has **zero merge conflict cost** when we sync upstream PI. The patch series in `../../patches/` only contains things that genuinely cannot be expressed as extensions (branding strings baked into binaries, hard removal of provider source files).

Rule of thumb: if you're tempted to write a patch, first check whether the [PI extension API](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/extensions.md) has a hook for it. It almost always does.
