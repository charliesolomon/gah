# Gov Open Source AI Harness (GAH)

A branded, policy-hardened distribution of the [PI coding agent](https://github.com/earendil-works/pi).

GAH is structured as **two layers** so that customization survives upstream churn:

1. **`packages/policy-pack/`** — a [pi-package](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/packages.md) we own outright. All policy, branding, default skills/prompts/tools live here as extensions. Zero merge conflicts when upstream changes.
2. **`vendor/pi/`** — upstream PI sources as a git subtree. Modified only via `patches/` — small, named, atomic patches re-applied after every upstream sync.

Anything we *can* express as an extension goes in (1). Edits to upstream code only happen when (1) is genuinely insufficient.

## Layout

```
gah/
├── packages/policy-pack/      ← our IP — extensions, skills, prompts, branding
│   ├── extensions/
│   ├── skills/
│   ├── prompts/
│   ├── SYSTEM.md              ← system-prompt override
│   └── package.json
├── patches/                   ← discrete patches against vendor/pi
├── vendor/pi/                 ← upstream PI (managed by scripts/sync-upstream.sh)
├── scripts/                   ← sync, patch, build helpers
├── ci/scans/                  ← SBOM, CVE, semgrep/CodeQL configs
├── docs/WORKFLOW.md           ← upstream sync + patch hygiene
└── .github/workflows/         ← scheduled upstream sync + scans
```

## Quick start

```bash
# 1. First-time setup: vendor PI as a subtree at a chosen ref
./scripts/sync-upstream.sh init main          # or a tag like v0.74.0

# 2. Re-apply our patch series
./scripts/apply-patches.sh

# 3. Subsequent syncs
./scripts/sync-upstream.sh pull v0.75.0
./scripts/apply-patches.sh
```

See [docs/WORKFLOW.md](docs/WORKFLOW.md) for the full sync ritual and patch hygiene rules.

## Why this shape

Three concerns drove the design:

- **Blast radius** — disabled features should not be reachable. Policy-pack extensions enforce a tool allowlist (no `bash` by default), gate writes to protected paths, and audit-log every tool call. Code-level removals of unwanted providers/tools are done as patches.
- **Vulnerability assessment** — `ci/scans/` runs SBOM generation, dependency CVE checks, and source scans on every PR and nightly. CI fails loudly so audits aren't a project.
- **Upstream sync** — additive customization in `packages/policy-pack/` has zero conflict surface. Patches in `patches/` are small and rebaseable individually. Sync ritual is `pull → apply → test → ship`.

## License

MIT (inherits from upstream PI). See `vendor/pi/LICENSE` once vendored.
