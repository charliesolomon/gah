# Good Agent Harness (gah)

[![ci](https://github.com/charliesolomon/gah/actions/workflows/ci.yml/badge.svg)](https://github.com/charliesolomon/gah/actions/workflows/ci.yml)
[![pi pinned](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/charliesolomon/gah/main/.github/badges/pi-pinned.json)](.sync-state)
[![pi latest](https://img.shields.io/github/v/release/earendil-works/pi?label=pi%20latest&color=lightgrey)](https://github.com/earendil-works/pi/releases)

gah runs your team's skills with an AI agent, under a policy you control. It
is a branded, locked-down distribution of the
[pi coding agent](https://github.com/earendil-works/pi):

- **Your team's skills.** Procedures your team writes and reviews like code,
  kept in one shared repository ([SKILLS.md](docs/SKILLS.md)).
- **Policy.** No shell by default, approved models and network hosts only, and
  every tool call audit-logged ([PROVIDERS.md](docs/PROVIDERS.md),
  [policy pack](packages/policy-pack/README.md)).
- **Easy to roll out.** A self-updating package for each person's machine, or
  one shared Linux host ([DEPLOY.md](docs/DEPLOY.md)).

## Where to start

| You want to… | Read |
|---|---|
| Use gah your team gave you | your team's own install page; gah itself points you to `/setup-skills` if anything is missing |
| Deploy gah to a team | [docs/DEPLOY.md](docs/DEPLOY.md): prerequisites, four steps, and which shape to choose |
| Try gah or write skills on your own machine | [Quick start](#quick-start) below |
| Maintain gah (upstream syncs, patches) | [docs/WORKFLOW.md](docs/WORKFLOW.md) |

gah supports one team forge today, GitLab, for its per-person packages. The
shared host and checkouts work with any git host. See
[The team forge](docs/DEPLOY.md#the-team-forge).

## Quick start

Build and run gah from a clone. **You need:** Node 22+ and npm, on Linux,
macOS or Windows. Four steps:

```bash
cd vendor/pi && npm ci --ignore-scripts && npm run build && cd ../..   # 1. build
node scripts/install-tools.mjs                     # 2. fd + ripgrep, pinned and verified
./bin/gah init ../my-team-skills                   # 3. a starter skills repository
GAH_SKILLS_DIR=../my-team-skills/skills ./bin/gah  # 4. start (bin\gah.ps1 on Windows)
```

- The build needs no network after `npm ci`: the patches are already applied
  and the model catalogue ships in the repository.
- gah starts without team skills too, and says how to add them.
- `./bin/gah --help` shows what this session may use: tools, models, network
  hosts and skills. In a session, `/help` shows the same.
- On Windows, see [docs/WINDOWS.md](docs/WINDOWS.md), including corporate
  proxies.

## How gah is built

Two layers, so changes to gah survive upstream releases:

1. **`packages/policy-pack/`**: gah's own extensions (policy, branding,
   onboarding), system prompt and setup skills. Most of gah lives here.
2. **`vendor/pi/`**: upstream pi, changed only through small patches in
   [`patches/`](patches/README.md) that are re-applied on every upstream sync.

If something can be an extension, it is one. A patch is the last resort.
Syncing, patching and CI are in [docs/WORKFLOW.md](docs/WORKFLOW.md); what
reaches the network is in [docs/SUPPLY-CHAIN.md](docs/SUPPLY-CHAIN.md).

### Repository layout

```
packages/policy-pack/   extensions, SYSTEM.md, setup skills, model data
patches/                the patch series against vendor/pi
vendor/pi/              upstream pi (git subtree), patches applied
bin/                    gah and gah.ps1: the launchers for a checkout
templates/skills-repo/  what `gah init` writes
templates/kb-repo/      what `gah init-kb` writes
templates/deploy/       gah-deploy.json example, package launchers and installers
deploy/host/            the shared Linux host
deploy/windows/         an example laptop shortcut for the shared host
.agents/skills/         skills for gah admins, loaded in a session started here
scripts/                build, package, check and sync helpers
ci/scans/               SBOM, CVE and source-scan configuration
docs/                   the guides linked above
```

## License

MIT, as upstream pi. See `vendor/pi/LICENSE`.
