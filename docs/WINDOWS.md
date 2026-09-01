# Running gah on Windows (PowerShell)

Windows is a supported *runtime* for gah, not a maintenance environment. The
upstream PI build is cross-platform (`shx`/`tsgo`), and the patched vendor
state is committed to git. The Makefile, `scripts/*.sh`, and the sync/patch
ritual are bash-only and stay on Linux/macOS (see [WORKFLOW.md](WORKFLOW.md)).

Node and npm are not quite the whole story, though, and the two gaps bite hardest
on a managed corporate network. Read [Network requirements](#network-requirements)
before the first build if you are behind a proxy — both known failure modes are
network-caused and neither error message says so.

## Prerequisites

- Git for Windows — needed beyond cloning: PI expects a bash on Windows at
  runtime and probes Git Bash first, then `bash.exe` on PATH (see
  `vendor/pi/packages/coding-agent/docs/windows.md`). GAH's policy blocks the
  bash *tool*, but the probe still runs.
- Node.js ≥ 22.19 (with npm) — upstream PI's `engines` requirement; builds
  fail on older 22.x with `ERR_UNKNOWN_FILE_EXTENSION` on `.ts` scripts

## Network requirements

The build is not self-contained, and neither failure below reports itself as a
network problem.

### Node does not trust the Windows certificate store

Node ships its own CA bundle and ignores the Windows store, so a TLS-inspecting
proxy — whose CA Windows, Chrome and Edge already trust — is invisible to it.
Every HTTPS call made by npm, by install scripts, and by the build then fails
certificate validation.

Set this before anything else:

```powershell
$env:NODE_OPTIONS = "--use-system-ca"        # Node reads the Windows trust store
$env:HTTPS_PROXY  = "http://your-proxy:8080"
$env:HTTP_PROXY   = "http://your-proxy:8080"
```

`--use-system-ca` needs Node ≥22.15 and, importantly, applies to **child
processes** — which is what `prebuild-install`, `node-gyp` and the model-catalog
hydration are. Persist it with `setx NODE_OPTIONS "--use-system-ca"`.

`npm config set cafile` is *not* sufficient: it governs npm's own registry
traffic and does not reach install scripts. Do not reach for
`npm config set strict-ssl false` — it works by disabling certificate
verification for everything on the machine.

### The build hydrates model catalogs from the internet

`packages/ai`'s build runs `generate-models --strict`, which fetches provider
catalogs from roughly twenty vendor APIs (`api.anthropic.com`, `api.cerebras.ai`,
`api.deepseek.com`, `api.fireworks.ai`, `api.groq.com`,
`api.individual.githubcopilot.com`, `ai-gateway.vercel.sh`, and others).
`--strict` makes any single failure fatal. If your proxy allowlists by host,
those need to be reachable.

> **`npm run build:offline` is not a way around this on a fresh clone.** It runs
> `check:model-data`, which requires catalogs a clone does not contain —
> `packages/ai/src/providers/data/` is gitignored, so git carries 39 provider
> shards and none of the JSON they import. "Offline" means *reuse an existing
> hydration*, not *build without network*.

If the vendor APIs are unreachable, copy `packages/ai/src/providers/data/`
(656K, 39 files) from a machine that has built successfully, then
`npm run build:offline` genuinely works offline. Tracked in
[#15](https://github.com/charliesolomon/gah/issues/15).

### Native modules

`npm install` may fail building `canvas`:

```
prebuild-install -r napi || node-gyp rebuild
```

This is almost always the certificate problem above, not a missing toolchain —
`prebuild-install` cannot reach GitHub releases, so it falls back to compiling
from source, which needs Visual Studio Build Tools and Python. **Confirmed on a
managed Win11 machine:** with `--use-system-ca` and the proxy variables set,
`npm install` completes normally and `canvas` installs from its prebuilt binary,
with no build tools present. Fix the proxy settings first.

If it still fails after that, skip it:

```powershell
npm install --ignore-scripts
```

`canvas` is a devDependency of `packages/ai` used by exactly one file —
`scripts/generate-test-image.ts`, a test-fixture generator. It is not needed to
build or run gah. `--ignore-scripts` also skips the root `prepare: husky` hook
install, which is bash-only and irrelevant here.

**Do not use `--omit=dev`** — the compilers (`typescript`, `@typescript/native-preview`,
`esbuild`, `shx`, `tsx`) are devDependencies, so omitting them breaks the build.

## Build

```powershell
git clone git@github.com:charliesolomon/gah.git
cd gah\vendor\pi
npm install
npm run build
```

`npm run build` is upstream's own build chain — nine packages in dependency
order (tui, telemetry, ai, agent, session-backends/sqlite-node, protocol,
client, server, coding-agent). It is what `make build-all` invokes, so there is
nothing make does here that npm does not.

> **Do not hand-list the packages.** An earlier version of this page named four
> of them explicitly. Upstream grew to nine, the list was never updated, and the
> build appeared to succeed while producing a partial result. `npm run build`
> cannot drift, because it comes from the vendored tree itself. The Makefile
> was corrected for exactly this reason — see the note on `build-all`.

This is the PowerShell equivalent of `make sync-init` minus the vendoring,
which is already in git. There is nothing to apply from `patches/` — the
vendored tree is committed with patches applied.

### Rebuilding after a change

```powershell
cd vendor\pi
npm --workspace packages/coding-agent run build   # incremental — make build
npm run build:offline                             # full, skips model-catalog fetch
```

`packages/ai` hydrates model catalogs over the network during a normal build;
`build:offline` reuses what is already there.

## Run

GAH will not start without your organization's skills. If someone has already
set up a skills repository, clone it and point at it; if you are the first,
create one:

```powershell
cd ..\..
.\bin\gah.ps1 init ..\my-org-skills          # only if one does not exist yet
$env:GAH_SKILLS_DIR = '..\my-org-skills\skills'
.\bin\gah.ps1
```

Set `GAH_SKILLS_DIR` permanently so it survives new shells:

```powershell
[Environment]::SetEnvironmentVariable('GAH_SKILLS_DIR', (Resolve-Path ..\my-org-skills\skills).Path, 'User')
```

The first launch runs the repository's `setup\NN-*.ps1` steps in the terminal
before the agent starts, so expect prompts for your inference endpoint and its
API key. They are idempotent — later launches skip them once the config exists.
The step writes `~\.gah\agent\models.json` with your key in it, restricted to
your user, and `bin\gah.ps1` reads it by default — so models work on the first
launch with nothing further to set (see [PROVIDERS.md](PROVIDERS.md)).

See [SKILLS.md](SKILLS.md) for what belongs in that repository.

`bin\gah.ps1` is the PowerShell twin of `bin/gah`: it launches PI with
`--no-extensions` plus the policy-pack extensions explicitly, so the policy
enforced is exactly what this repo ships. Always launch through the wrapper —
running `node vendor\pi\...\cli.js` directly bypasses the GAH policy.

If script execution is blocked (`running scripts is disabled on this
system`), either run it once via:

```powershell
powershell -ExecutionPolicy Bypass -File .\bin\gah.ps1
```

or allow local scripts permanently for your user:

```powershell
Set-ExecutionPolicy -Scope CurrentUser RemoteSigned
```

## Smoke test

The equivalent of `make smoke`:

```powershell
$env:GAH_ALLOW_NO_SKILLS = '1'   # this checks the harness, not your skills repo
.\bin\gah.ps1 --version
.\bin\gah.ps1 --list-models | Out-Null; if ($?) { "list-models OK" }
```

## Where things live on Windows

- Audit log: `C:\Users\<you>\.gah\audit.log` (override with `$env:GAH_AUDIT_LOG`)
- Agent config: `C:\Users\<you>\.gah\agent\`

## Not supported on Windows

- `make` targets (bash recipes; use the PowerShell commands above)
- `scripts/sync-upstream.sh`, `apply-patches.sh`, `clean-vendor.sh`
- `make patch-new` / `patch-export` and the pre-push smoke hook

Do upstream syncs and patch work on a Linux/macOS clone, push, and `git pull`
on the Windows side.
