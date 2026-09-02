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

`npm install --ignore-scripts` is the only step that needs the network — the build itself makes
no calls since `0030-offline-model-data` (see below) — and the one install
failure that remains does not report itself as a network problem.

### Corporate proxy and CA trust: the environment to set

Two things go wrong behind a corporate proxy, and neither reports itself as a
network problem. Node ships its own CA bundle and ignores the Windows store, so
a TLS-inspecting proxy — whose CA Windows, Chrome and Edge already trust — is
invisible to it and every HTTPS call fails certificate validation. And Node's
built-in `fetch` ignores `HTTPS_PROXY` unless told to honour it, so anything an
install script fetches goes direct and hangs or is refused.

The expected set, to be confirmed on a machine behind the proxy
([#14](https://github.com/charliesolomon/gah/issues/14)):

| Variable | Value | What it does |
|---|---|---|
| `NODE_OPTIONS` | `--use-system-ca --use-env-proxy` | `--use-system-ca` makes Node trust the Windows certificate store, so the proxy's CA is accepted. `--use-env-proxy` makes Node's own `fetch` route through `HTTPS_PROXY`. |
| `HTTPS_PROXY` | `http://your-proxy:8080` | The proxy for HTTPS traffic — npm, install scripts, and anything Node fetches once `--use-env-proxy` is set. |

Set them before anything else:

```powershell
$env:NODE_OPTIONS = "--use-system-ca --use-env-proxy"
$env:HTTPS_PROXY  = "http://your-proxy:8080"
```

Both `NODE_OPTIONS` flags apply to **child processes** — which is what
`prebuild-install` and `node-gyp` are — which is why they go in `NODE_OPTIONS`
rather than on a single command line. Persist them with
`setx NODE_OPTIONS "--use-system-ca --use-env-proxy"` and
`setx HTTPS_PROXY "http://your-proxy:8080"`.

Version floors: `--use-system-ca` needs Node ≥22.15; `--use-env-proxy` needs
Node ≥22.21 or ≥24.5 (on older Node, `NODE_USE_ENV_PROXY=1` is the same
switch where it exists, and an unknown flag in `NODE_OPTIONS` makes every
`node` invocation exit immediately — check `node --version` first).

`HTTP_PROXY` should not be needed: nothing in the install or build fetches
over plain HTTP. Add it only if a proxy log shows a refused plain-HTTP request.

`npm config set cafile` is *not* sufficient: it governs npm's own registry
traffic and does not reach install scripts. Do not reach for
`npm config set strict-ssl false` — it works by disabling certificate
verification for everything on the machine.

### The build no longer fetches model catalogs

Upstream's `packages/ai` build runs `generate-models --strict`, which fetches
provider catalogs from roughly twenty vendor APIs and makes any single failure
fatal — behind a host-allowlisting proxy that was the wall every fresh clone
hit ([#14](https://github.com/charliesolomon/gah/issues/14),
[#15](https://github.com/charliesolomon/gah/issues/15)).

`patches/0030-offline-model-data.patch` replaces that step. `npm run build`
now materialises `packages/ai/src/providers/data/` from
[`packages/policy-pack/model-data/`](../packages/policy-pack/model-data/README.md)
— the two providers GAH actually exposes — and ships every other provider
with an empty catalogue. No vendor host needs to be reachable. If a build
still reports a fetch, it is an install script, not the catalog.

### Install scripts are skipped

Always install with `--ignore-scripts`. Five packages in upstream's tree run
code during `npm install`, and none of it is needed to build or run gah
(docs/SUPPLY-CHAIN.md, "Install time"). The one that mattered on Windows was
`canvas`, a devDependency of `packages/ai` used by a single test-fixture
script: its install script downloads a prebuilt binary from GitHub releases
and, when that fails behind a proxy, falls back to compiling from source with
Visual Studio Build Tools and Python. Skipping scripts removes that download
and that fallback. It also skips upstream's `prepare: husky` hook, which is
bash-only and irrelevant here, and silences newer npm's `allow-scripts`
warning about unapproved install scripts.

**Do not use `--omit=dev`** — the compilers (`typescript`, `@typescript/native-preview`,
`esbuild`, `shx`, `tsx`) are devDependencies, so omitting them breaks the build.

## Build

```powershell
git clone git@github.com:charliesolomon/gah.git
cd gah\vendor\pi
npm install --ignore-scripts
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
npm run build:offline                             # full, reuses src/providers/data as-is
```

Both are offline. `build:offline` only skips re-seeding `packages/ai`'s model
data from `packages/policy-pack/model-data/`, which a normal build does anyway.

## Install fd and ripgrep

The agent's find and grep tools need these two binaries, and GAH does not
download them at runtime (patch 0013; upstream did, unpinned). Install them once,
pinned and SHA-256-verified, into `~\.gah\agent\bin`:

```powershell
cd ..\..                              # repo root
node scripts\install-tools.mjs
```

Needs the same proxy environment as the install. Nothing else in a session
reaches the internet except the inference endpoint.

**No internet on the target machine?** On any connected machine, from a clone:

```powershell
node scripts\install-tools.mjs --download-only C:\path\to\gah-tools --platform win32-x64
```

copy that folder over, then on the target:

```powershell
node scripts\install-tools.mjs --from C:\path\to\gah-tools
```

The archives are verified against the pinned checksums either way. Details and
the pinned versions: [SUPPLY-CHAIN.md](SUPPLY-CHAIN.md). If the tools are
missing, the agent says so at startup and the find and grep tools fail; nothing
else is affected.

## Tools

The model is offered exactly the tools the policy allows: `read`, `grep`, `find`,
`ls`, `edit`, `write`. Listing a directory is the `ls` tool, which needs no shell.
Shells are off by default; on Windows the shell tool is `powershell`, and a
deployment opts in with:

```powershell
$env:GAH_ALLOW_TOOLS = 'powershell'
```

The editor's `!command` prefix, which runs a shell as you rather than as the
model, follows the same rule: it works only when a shell tool is allowed.

Two PowerShell habits to know when passing lists on the command line: an
unquoted comma list is an **array literal**, so `--tools read,ls` reaches the
binary as two separate words. Quote it: `--tools 'read,ls'`. Environment
variables are not affected, since `$env:X = 'a,b'` is already a string.

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
