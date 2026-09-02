# Runtime supply chain

**Contract: at runtime, GAH reaches the network only to talk to approved
inference endpoints.** Nothing is downloaded, phoned home, or looked up.
Everything the binary needs is present after installation, so an installation
with no internet access works exactly like one with it.

This page records the decision behind issue #3, what upstream PI does that GAH
turns off, and how to install the two helper binaries the agent needs.

## What upstream does at runtime, and what GAH does instead

Upstream PI makes these network calls in a default session. All of them are
disabled by `patches/0013-offline-runtime.patch`, which forces upstream's own
`--offline` mode unconditionally and removes the tool download path outright.

| Upstream behaviour | When | GAH |
|---|---|---|
| Download `fd` and `ripgrep` from GitHub — whatever release is "latest", no checksum | TUI startup, and first use of the find/grep tools | Removed. The lookup remains (agent bin dir, then PATH); a missing tool warns with install instructions. |
| Version check against the npm registry | startup | Off. GAH is not published on npm. |
| Install-report ping to `pi.dev` | startup | Off. |
| Remote model-catalogue refresh from `pi.dev` | startup and periodically | Off. The catalogue is what the build seeded ([model-data](../packages/policy-pack/model-data/README.md)), filtered by `GAH_BUILTIN_MODELS` ([PROVIDERS.md](PROVIDERS.md)). |
| Package update check | startup | Off. GAH loads its extensions by path, not from packages. |
| `/share`: upload the session transcript as a GitHub gist via the `gh` CLI | on request | Off (`patches/0014-no-session-share.patch`), audited as `share_disabled`. A child process the egress allowlist cannot see, and the transcript is the organisation's data. `GAH_ALLOW_SHARE=1` re-enables it. |

Enforcement is in the binary (`main()` and the tools manager), not in launcher
environment, so it holds for `bin/gah`, the shared-host launcher, published
artifacts and the SDK path alike. One layer down, `GAH_ALLOWED_HOSTS`
(patch 0011, [PROVIDERS.md](PROVIDERS.md)) refuses any HTTP request to a host
the deployment has not named, so the contract holds even for code paths this
page does not list.

## fd and ripgrep

The agent's `find` and `grep` tools shell out to `fd` and `rg` and fail without
them ("fd is not available"). Nothing else needs them. The agent looks in
`~/.gah/agent/bin` first (`$GAH_CODING_AGENT_DIR/bin` if set), then on PATH
under the names `fd`, `fdfind` and `rg`.

### Decision

Option B from #3 — block the runtime download — plus a deployment-time
installer, so the default install is still complete. Vendoring binaries into
this repository was rejected: it puts 12 platform archives into git and every
sync, for the same assurance a pinned checksum table gives. Audit-only was
rejected because it still executes an unpinned download.

### Installing

**System packages** (simplest where a package manager is available):

| Platform | Command |
|---|---|
| Debian/Ubuntu | `apt install fd-find ripgrep` — the binary is `fdfind`, which the agent recognises. `deploy/host/setup.sh` does this. |
| macOS | `brew install fd ripgrep` |
| Windows | `winget install sharkdp.fd BurntSushi.ripgrep.MSVC` |

**Pinned installer** (any platform; needs only Node and the system `tar`):

```bash
node scripts/install-tools.mjs          # or: make install-tools
```

Downloads the pinned release archives for this machine from GitHub, verifies
each against the SHA-256 in the script, extracts into `~/.gah/agent/bin`, runs
`--version` on the result and appends a `tool_installed` line to
`~/.gah/audit.log` (`$GAH_AUDIT_LOG`). A checksum mismatch installs nothing.
`--dest DIR` overrides the target directory.

**Offline installation.** On any connected machine with a clone of this repo:

```bash
node scripts/install-tools.mjs --download-only ./gah-tools --platform win32-x64
node scripts/install-tools.mjs --download-only ./gah-tools --all-platforms   # one bundle for every platform
```

Copy the directory to the target machine, then:

```bash
node scripts/install-tools.mjs --from ./gah-tools
```

`--from` makes no network calls and verifies the archives against the same
checksums before installing, so a bundle that was tampered with in transit is
refused. A directory produced with `--all-platforms` serves every platform.

### The pins

| Tool | Version | Platforms | Checksum provenance |
|---|---|---|---|
| fd | 10.5.0 | linux x64/arm64 (glibc), macOS x64/arm64, Windows x64/arm64 (MSVC) | fd publishes no checksums. Hashes are of what `github.com` served over TLS on 2026-09-02. |
| ripgrep | 15.2.0 | linux x64 (musl, static; no glibc build is published), linux arm64, macOS x64/arm64, Windows x64/arm64 (MSVC) | ripgrep publishes a `.sha256` per asset; every pinned hash matched it on 2026-09-02. |

The table of assets and hashes lives at the top of
[`scripts/install-tools.mjs`](../scripts/install-tools.mjs).

### Bumping a version

1. Change `version`/`tag` for the tool and refresh every asset name and hash.
   For ripgrep, take the hashes from the published `.sha256` files. For fd,
   download each asset and hash it, and say in the commit how the hashes were
   obtained.
2. Run `node scripts/install-tools.mjs --download-only /tmp/t --all-platforms`
   — it verifies every entry.
3. Review like any other policy change.

## What the user sees when a tool is missing

At TUI startup, one warning per missing tool:

```
fd not found. GAH does not download tools at runtime: install it on PATH or into
~/.gah/agent/bin (node scripts/install-tools.mjs -- see docs/SUPPLY-CHAIN.md).
```

The session continues; only `find` and `grep` are unavailable until the tool is
installed.
