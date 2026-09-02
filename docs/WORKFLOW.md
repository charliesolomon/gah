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

Upstream's build regenerates some **tracked** source files in `vendor/pi/` (e.g. `packages/ai/src/models.generated.ts`, rebuilt from live provider catalogs). GAH's build does not — `0030-offline-model-data` swaps that fetch for a seed step that only writes the gitignored `packages/ai/src/providers/data/` — but `npm run generate:models` and `make refresh-model-data` still do, and those are not changes we want to commit or merge.

- `scripts/sync-upstream.sh pull` auto-runs `scripts/clean-vendor.sh` before pulling.
- Run `./scripts/clean-vendor.sh` manually whenever `git status` shows working-tree noise in `vendor/pi/` you didn't author.

Never commit changes to `vendor/pi/` outside the patch flow (`patches/README.md`).

## Daily flow

- Adding policy/branding/skill behavior → edit `packages/policy-pack/`, commit normally.
- Need to change upstream PI source → see `patches/README.md` for how to author and export a patch. Never edit `vendor/pi/` files directly on `main`.

## Upstream sync ritual

Sync on **release tags**, not `main`. Releases batch upstream changes so we don't pay merge cost per commit.

The vendor tree is committed **with patches applied** (clones run without a
patch step), so every sync starts by reverse-applying the series — otherwise
the subtree pull merges into a patched tree and `apply-patches.sh` has
nothing it can do.

```bash
# 1. Sync branch; restore pristine vendor
git checkout -b sync/v0.80.0
for p in $(ls patches/[0-9]*.patch | sort -r); do
  git apply -R --directory=vendor/pi "$p"
done
git commit -am "sync: restore pristine vendor"

# 2. Pull the new release
./scripts/sync-upstream.sh pull v0.80.0

# 3. Re-apply our patches; commit the patched state
./scripts/apply-patches.sh        # regenerate any patch that fails (see below)
git add -A && git commit -m "sync: vendor v0.80.0, patch series re-applied"

# 4. Rebuild + smoke; deps may have changed
cd vendor/pi && npm ci && cd ../.. && make build-all && make smoke

# 5. Open a PR; review; merge
```

### Merge the sync PR with a merge commit — never squash

This is load-bearing and easy to get wrong from the GitHub UI. `git subtree pull` finds
its split point by reading the `Squashed 'vendor/pi/' changes from <a>..<b>` line out of
the last subtree commit message. **Squash-merging a sync PR erases that marker from
`main` and permanently breaks every future sync.** The one sync that has ever succeeded
(v0.74.0 → v0.79.1, commit `639e0d7e`) was a true two-parent merge commit; keep it that way.

Branch protection is not available on this repo's plan, so nothing enforces this
mechanically — and CI cannot be a required check either. It informs the merge decision;
it does not gate it.

### Verify bake-policy by fault injection

After a sync, confirm `0020-bake-policy` still actually loads the bundled policy — don't
infer it from the patch applying. Temporarily break the policy pack (e.g. rename
`SYSTEM.md`) and confirm the binary notices. This check previously existed only in the
body of commit `639e0d7e`.

### On the automation

`.github/workflows/upstream-sync.yml` attempts this every Monday and opens a PR when it
succeeds. Be aware of its history: **it failed 15 consecutive times between 2026-05-18 and
2026-08-28 without ever succeeding, and nothing surfaced that** — a scheduled workflow's
only default signal is an email to whoever last edited it. It now files an issue on
failure. Treat a long silence as suspicious rather than as good news, and check
`gh run list --workflow upstream-sync` periodically.

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

- **Editing files in `vendor/pi/` directly and committing.** They are *not* silently
  clobbered by the next subtree pull, as this doc used to claim — they are worse than
  that. Reverse-applying the patch series cannot undo a change no patch describes, so the
  pull hits a hard merge conflict and the sync stops dead. This is exactly what happened:
  a `shell-quote` CVE bump and some incidental lockfile churn committed straight into
  `vendor/pi` cost 15 consecutive failed syncs. `scripts/check-vendor-clean.sh` now guards
  this in CI; run it with `--worktree` before you commit.
- **Editing `vendor/pi/` to satisfy a scanner.** Exclude the path in `ci.yml` with a
  documented justification instead (see `ci/scans/README.md`).
- Adding many small patches when one extension would do.
- Adding new dependencies to `packages/policy-pack/` casually — each one expands the CVE surface we own.
- Merging upstream `main` instead of a tagged release.
