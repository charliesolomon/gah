# Building and running gah on Windows

This page is for building a gah checkout on Windows and running it from
PowerShell, as a developer or admin. To give gah to people who will never clone
this repository, build a package instead: see [DEPLOY-WINDOWS.md](DEPLOY-WINDOWS.md).

Windows can build and run gah. Maintaining the fork (the Makefile, upstream
syncs, patch work) is bash-only and stays on Linux or macOS
([WORKFLOW.md](WORKFLOW.md)).

**What you'll do:** 4 steps, about 15 minutes on a fast network.

1. [Install the prerequisites](#prerequisites)
2. [Build](#build)
3. [Install fd and ripgrep](#install-fd-and-ripgrep)
4. [Run](#run), pointed at your team's skills

**Behind a corporate proxy?** Set the [proxy environment](#behind-a-corporate-proxy)
first. Both failures it prevents look like something else.

## Prerequisites

- **Git for Windows.** pi probes for a bash at startup (Git Bash first, then
  `bash.exe` on `PATH`) even though gah's policy blocks the bash tool.
- **Node.js 22.19 or newer**, with npm. Older 22.x fails the build with
  `ERR_UNKNOWN_FILE_EXTENSION` on `.ts` scripts.

## Build

```powershell
git clone git@github.com:charliesolomon/gah.git
cd gah\vendor\pi
npm ci --ignore-scripts
npm run build
```

- **`npm ci`, not `npm install`.** It installs exactly what the vendored
  lockfile says and never rewrites it; a rewritten lockfile makes the next
  `git pull --ff-only` refuse.
- **`--ignore-scripts`, always.** No install script is needed to build or run
  gah, and one (`canvas`) tries to download or compile a native binary, which
  fails behind a proxy. [SUPPLY-CHAIN.md](SUPPLY-CHAIN.md#install-time) lists them.
- **Not `--omit=dev`.** The compilers are devDependencies.
- **`npm run build` is upstream's own build chain**, the same one
  `make build-all` runs. Don't list the packages by hand; the vendored script
  can't fall out of step with upstream.

Only `npm ci` touches the network. The build reads the model catalogue from
[`packages/policy-pack/model-data/`](../packages/policy-pack/model-data/README.md)
instead of fetching it (patch 0030), and the vendored tree is committed with
gah's patches applied, so there is nothing to apply.

One warning is expected: `EBADENGINE` for `autoevals`, part of upstream's
evaluation tooling, which gah never builds.

### Rebuilding after a change

```powershell
cd vendor\pi
npm --workspace packages/coding-agent run build   # incremental (make build)
npm run build:offline                             # full, reusing the model data as seeded
```

**After a pull that changes `packages/policy-pack/model-data/`, run the full
`npm run build`.** It is the only build that re-seeds the model data; the two
above keep the old data without warning. `git log -1 -- packages/policy-pack/model-data`
shows when it last changed.

## Install fd and ripgrep

The agent's find and grep tools need these two binaries, and gah never
downloads them at runtime. Install them once, pinned and SHA-256-verified, into
`~\.gah\agent\bin`:

```powershell
cd ..\..                              # repository root
node scripts\install-tools.mjs
```

For a machine without internet access, download on a connected machine with
`--download-only <folder> --platform win32-x64`, copy the folder over, and
install with `--from <folder>`. Details and pins: [SUPPLY-CHAIN.md](SUPPLY-CHAIN.md#fd-and-ripgrep).

## Run

Always start gah through `bin\gah.ps1`. It loads exactly the policy this
repository ships; running pi's `cli.js` directly bypasses the policy.

gah starts without your team's skills, but is built around them: until they
load, a line above the input box points at `/setup-skills`. Point it at a
clone of your team's skills repository, or create one if you are the first:

```powershell
.\bin\gah.ps1 init ..\my-org-skills          # only if your team has none yet
$env:GAH_SKILLS_DIR = '..\my-org-skills\skills'
.\bin\gah.ps1
```

To keep `GAH_SKILLS_DIR` across new shells:

```powershell
[Environment]::SetEnvironmentVariable('GAH_SKILLS_DIR', (Resolve-Path ..\my-org-skills\skills).Path, 'User')
```

A checkout reads skills from any local clone, so the skills repository can live
on any git host ([DEPLOY.md](DEPLOY.md#the-team-forge)). What belongs in it:
[SKILLS.md](SKILLS.md).

The first launch runs the skills repository's `setup\NN-*.ps1` steps before the
agent starts. The starter step asks for your inference endpoint and API key and
writes `~\.gah\agent\models.json`, readable only by you, which a checkout reads
by default ([PROVIDERS.md](PROVIDERS.md)). The steps are idempotent; later
launches skip what is already configured.

**Script execution blocked?** Run once with
`powershell -ExecutionPolicy Bypass -File .\bin\gah.ps1`, or allow local
scripts for your user with `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned`.

### Tools

The model is offered exactly the tools the policy allows: `read`, `grep`,
`find`, `ls`, `edit`, `write`. Shells are off by default; on Windows the shell
tool is `powershell`:

```powershell
$env:GAH_ALLOW_TOOLS = 'powershell'
```

The editor's `!command` prefix follows the same rule: it works only when a
shell tool is allowed.

Quote comma lists on the PowerShell command line: `--tools 'read,ls'`. An
unquoted `read,ls` is an array and reaches gah as two words.

### Smoke test

The equivalent of `make smoke`:

```powershell
$env:GAH_ALLOW_NO_SKILLS = '1'   # tests the harness, not your skills; hides the /setup-skills line
.\bin\gah.ps1 --version
.\bin\gah.ps1 --list-models | Out-Null; if ($?) { "list-models OK" }
```

### Where things live

- Audit log: `C:\Users\<you>\.gah\audit.log` (`$env:GAH_AUDIT_LOG` overrides)
- Agent config: `C:\Users\<you>\.gah\agent\`

## Behind a corporate proxy

Two things fail behind a corporate proxy, and neither error says "network":

- Node ships its own CA bundle and ignores the Windows certificate store, so a
  TLS-inspecting proxy's CA is not trusted and HTTPS calls fail validation.
- Node's built-in `fetch` ignores `HTTPS_PROXY` unless told otherwise, so
  install scripts go direct and hang or are refused.

Set both before installing:

```powershell
$env:NODE_OPTIONS = "--use-system-ca --use-env-proxy"
$env:HTTPS_PROXY  = "http://your-proxy:8080"
```

Persist them with `setx` the same way. They go in `NODE_OPTIONS`, not on one
command line, because install scripts run as child processes.

- `--use-system-ca` needs Node 22.15+; `--use-env-proxy` needs Node 22.21+ or
  24.5+. An unknown flag in `NODE_OPTIONS` makes every `node` exit at once, so
  check `node --version` first.
- `HTTP_PROXY` should not be needed: nothing in the install fetches over plain HTTP.
- `npm config set cafile` is not enough (it doesn't reach install scripts), and
  `strict-ssl false` turns off certificate checking for everything. Use neither.

This set has not yet been confirmed on a machine behind a proxy
([#14](https://github.com/charliesolomon/gah/issues/14)).

## Not supported on Windows

- `make` targets (use the PowerShell commands above)
- `scripts/sync-upstream.sh`, `apply-patches.sh`, `clean-vendor.sh`
- `make patch-new` / `patch-export` and the pre-push smoke hook

Do upstream syncs and patch work on a Linux or macOS clone, push, and
`git pull` on Windows.
