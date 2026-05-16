# GAH development workflow

## The principle

Every customization is one of:

1. **Additive in `packages/policy-pack/`** — new extension, new skill, new prompt, new file in `SYSTEM.md`. Zero merge conflict surface.
2. **A discrete patch in `patches/`** — modifies upstream PI sources. Use only when (1) is impossible.

We are aggressive about pushing things into (1). The PI extension API can replace built-in tools, gate every tool call, override the system prompt, customize compaction, register commands and UI, etc. Reach for a patch only after confirming there's no extension hook.

## First-time setup

```bash
make sync-init REF=v0.74.0   # or `main` to track tip; release tags recommended
make smoke                    # confirm bin/gah runs
make install-hooks            # (optional) symlink the pre-push smoke gate
```

This vendors upstream PI under `vendor/pi/` via `git subtree --squash`, applies our patch series, installs npm deps, builds the full dependency chain (tui → ai → agent → coding-agent), and produces a runnable `bin/gah` launcher that loads `packages/policy-pack/` as the only extension source.

`make` (with no args) lists all targets. The most common are:

| Target | What |
|--------|------|
| `make build` | Incremental rebuild of coding-agent (after editing patches) |
| `make sync REF=<tag>` | Pull upstream, re-apply patches, rebuild |
| `make patches` | Re-apply patches only |
| `make clean-vendor` | Discard build artifacts in vendor/pi |
| `make patch-new NAME=foo` | Open scratch branch for a new patch |
| `make patch-export NAME=foo NUM=0002` | Export scratch → patches/, return to main |

## Build artifacts

The PI build regenerates some **tracked** source files in `vendor/pi/` (e.g. `packages/ai/src/models.generated.ts`, which is rebuilt from live provider catalogs). These are not changes we want to commit and not changes we want to merge.

- `scripts/sync-upstream.sh pull` auto-runs `scripts/clean-vendor.sh` before pulling.
- Run `./scripts/clean-vendor.sh` manually whenever `git status` shows working-tree noise in `vendor/pi/` you didn't author.

Never commit changes to `vendor/pi/` outside the patch flow (`patches/README.md`).

## Daily flow

- Adding policy/branding/skill behavior → edit `packages/policy-pack/`, commit normally.
- Need to change upstream PI source → see `patches/README.md` for how to author and export a patch. Never edit `vendor/pi/` files directly on `main`.

## Upstream sync ritual

Sync on **release tags**, not `main`. Releases batch upstream changes so we don't pay merge cost per commit.

```bash
# 1. Pull the new release into a sync branch
git checkout -b sync/v0.75.0
./scripts/sync-upstream.sh pull v0.75.0

# 2. Re-apply our patches
./scripts/apply-patches.sh

# 3. Run our test/scan loop
npm --workspace packages/policy-pack test   # once we add tests
# ci/scans/* runs in CI; can also run locally

# 4. Open a PR; review; merge
```

CI does this automatically every Monday — see `.github/workflows/upstream-sync.yml`. The schedule + manual trigger together let you sync proactively for security releases.

## Patch failure during sync

`apply-patches.sh` will list any patches that don't apply cleanly. To repair:

1. Check whether the patched code still exists upstream. If not, **delete the patch** — the change is no longer needed.
2. If the code moved or changed shape, **regenerate the patch** against the new tree (see `patches/README.md`). Don't hand-edit `.patch` files.
3. `git rerere` (enabled by the apply script) remembers your resolutions, so subsequent rebases of the same conflict reuse them.

## Vulnerability handling

`ci/scans/` configures SBOM, dep CVE, and source-level scanners. Failure policy is in `ci/scans/README.md`. The expectation is that vulnerability assessment is a passive property of CI, not a manual project.

## Branding

Anything user-visible that lives **outside** the binary (system prompt, banners shown by the extension layer, footer/header content) goes in `packages/policy-pack/`. Anything **inside** the binary (the `pi` executable name, embedded URLs, package-level branding) needs a patch — by convention `patches/0001-branding.patch`.

## Anti-patterns

- Editing files in `vendor/pi/` directly on `main` and committing — these will be silently clobbered by the next subtree pull.
- Adding many small patches when one extension would do.
- Adding new dependencies to `packages/policy-pack/` casually — each one expands the CVE surface we own.
- Merging upstream `main` instead of a tagged release.
