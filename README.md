# Good Agent Harness (gah)

[![ci](https://github.com/charliesolomon/gah/actions/workflows/ci.yml/badge.svg)](https://github.com/charliesolomon/gah/actions/workflows/ci.yml)

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
├── deploy/host/               ← shared SSH agent host (tmux launcher, per-user manifests)
├── templates/skills-repo/     ← scaffold written by `gah init` (your org's skills repo)
├── scripts/                   ← sync, patch, build helpers
├── ci/scans/                  ← SBOM, CVE, semgrep/CodeQL configs
├── docs/WORKFLOW.md           ← upstream sync + patch hygiene
├── docs/WINDOWS.md            ← running on Windows (PowerShell)
├── docs/GITLAB.md             ← distribution via enterprise GitLab (npm registry)
├── docs/PROVIDERS.md          ← inference-provider restriction + approved endpoints
├── docs/SKILLS.md             ← the skills repository: gah init, layout, rollout
├── docs/CONCEPT.html         ← the concept, for a non-technical audience (standalone, offline)
└── .github/workflows/         ← scheduled upstream sync + scans
```

## Quick start

**Building and running needs only Node and npm — on any platform.** The vendored
tree is committed with patches applied, so a fresh clone builds directly:

```bash
cd vendor/pi && npm install && npm run build     # upstream's own 9-package chain
cd ../..
./bin/gah init ../my-org-skills                  # once per organization
GAH_SKILLS_DIR=../my-org-skills/skills ./bin/gah # bin\gah.ps1 on Windows
```

**GAH works with your organization's shared agents and skills**, so it will not
start without them — a session with no skills is a misconfiguration, not a
lighter mode. `gah init` scaffolds the repository those live in; put it under
source control and share it with the team. See [docs/SKILLS.md](docs/SKILLS.md).

`npm run build` is what `make build-all` invokes. Prefer it: it comes from the
vendored tree, so it cannot fall out of step with upstream the way a hand-kept
package list does.

**Maintaining the fork uses make, and is bash-only** (Linux/macOS). This is the
part make actually earns — REF validation, the patch series, git hooks, policy
bundling:

```bash
make sync-init REF=v0.84.4   # first-time vendor + install + build
make sync REF=v0.85.0        # pull upstream, re-apply patches, rebuild
make patches                 # re-apply patches/
make install-hooks           # one-time per clone
make                         # see all targets
```

See [docs/WORKFLOW.md](docs/WORKFLOW.md) for the full sync ritual and patch hygiene rules.

Running on Windows? See [docs/WINDOWS.md](docs/WINDOWS.md). Building and running
work normally; only the sync and patch targets stay on Linux/macOS.

Installing without a clone? [docs/GITLAB.md](docs/GITLAB.md) covers publishing `@<group>/gah` to an enterprise GitLab npm registry — the policy pack is baked into published artifacts via `patches/0020-bake-policy.patch`, so no wrapper script is needed.

## Why this shape

Three concerns drove the design:

- **Blast radius** — disabled features should not be reachable. Policy-pack extensions enforce a tool allowlist (no `bash` by default), gate writes to protected paths, and audit-log every tool call. Code-level removals of unwanted providers/tools are done as patches.
- **Vulnerability assessment** — `ci/scans/` runs SBOM generation, dependency CVE checks, and source scans on every PR and nightly. CI fails loudly so audits aren't a project.
- **Upstream sync** — additive customization in `packages/policy-pack/` has zero conflict surface. Patches in `patches/` are small and rebaseable individually. Sync ritual is `pull → apply → test → ship`.

## License

MIT (inherits from upstream PI). See `vendor/pi/LICENSE` once vendored.
