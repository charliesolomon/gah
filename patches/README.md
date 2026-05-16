# Patches against vendor/pi

Each `.patch` here modifies upstream PI sources. **Patches are the last resort** —
anything expressible as a `packages/policy-pack/` extension goes there instead, because
extensions create zero merge conflict surface during upstream syncs.

## Naming

`NNNN-short-name.patch` — applied in lexical order by `scripts/apply-patches.sh`.

Recommended numbering:

| Range | Purpose |
|-------|---------|
| 0001–0009 | Branding (binary name, banner strings, URLs) |
| 0010–0019 | Hard removals (delete unused providers, unwanted tools) |
| 0020–0029 | Bootstrap (wire policy-pack as default extension) |
| 0030–0099 | Surgical core modifications (rare, justify each) |

## Authoring a patch

```bash
# 1. Stage changes in vendor/pi (only commit them to a scratch branch — never main)
git checkout -b scratch/my-change
cd vendor/pi && $EDITOR src/...
git add vendor/pi && git commit -m "branding: replace banner"

# 2. Export as a patch relative to vendor/pi
git format-patch -1 --relative=vendor/pi \
  --output=../../patches/0001-branding.patch HEAD

# 3. Discard the scratch branch — the patch is the source of truth
git checkout main && git branch -D scratch/my-change

# 4. Re-apply via the script to verify it round-trips
./scripts/apply-patches.sh
```

## Hygiene rules

- **One concern per patch.** Branding and provider removal go in separate files.
- **Patches must self-document.** Add a comment block in the patch header
  explaining *why* this can't be done in policy-pack.
- **Avoid touching files that change often upstream.** Prefer adding new files
  (which never conflict) to modifying existing ones.
- **`git rerere` is enabled by `apply-patches.sh`** so conflict resolutions
  replay across syncs.
- **If a patch fails to apply after upstream sync:** regenerate from scratch
  using the steps above against the new tree, rather than hand-editing the
  `.patch` file.
