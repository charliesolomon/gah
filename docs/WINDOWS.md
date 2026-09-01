# Running gah on Windows (PowerShell)

Windows is a supported *runtime* for gah, not a maintenance environment. The
upstream PI build is cross-platform (`shx`/`tsgo`), and the patched vendor
state is committed to git — so a Windows machine only needs Node and npm.
The Makefile, `scripts/*.sh`, and the sync/patch ritual are bash-only and
stay on Linux/macOS (see [WORKFLOW.md](WORKFLOW.md)).

## Prerequisites

- Git for Windows — needed beyond cloning: PI expects a bash on Windows at
  runtime and probes Git Bash first, then `bash.exe` on PATH (see
  `vendor/pi/packages/coding-agent/docs/windows.md`). GAH's policy blocks the
  bash *tool*, but the probe still runs.
- Node.js ≥ 22.19 (with npm) — upstream PI's `engines` requirement; builds
  fail on older 22.x with `ERR_UNKNOWN_FILE_EXTENSION` on `.ts` scripts

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

```powershell
cd ..\..
.\bin\gah.ps1
```

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
