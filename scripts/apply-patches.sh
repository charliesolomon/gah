#!/usr/bin/env bash
#
# apply-patches.sh — apply the patches/ series against vendor/pi.
#
# Patches are numeric-prefixed and applied in lexical order:
#   patches/0001-branding.patch
#   patches/0010-remove-providers.patch
#   ...
#
# Convention: patch paths are relative to vendor/pi (i.e. crafted with
# `git format-patch --relative=vendor/pi` or `git diff --relative=vendor/pi`).
#
# Each patch should be:
#   - Atomic (one concern per patch)
#   - Self-documenting (header comment explains *why*)
#   - Stable against expected upstream churn
#
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PATCH_DIR="$REPO_ROOT/patches"
TARGET="$REPO_ROOT/vendor/pi"

cd "$REPO_ROOT"

if [ ! -d "$TARGET" ]; then
  echo "vendor/pi missing. Run scripts/sync-upstream.sh init first." >&2
  exit 1
fi

shopt -s nullglob
patches=("$PATCH_DIR"/[0-9]*.patch)
shopt -u nullglob

if [ ${#patches[@]} -eq 0 ]; then
  echo "No patches in $PATCH_DIR — nothing to apply."
  exit 0
fi

# Enable rerere so conflict resolutions are remembered across syncs.
git config rerere.enabled true

failed=()
threeway=()
for p in "${patches[@]}"; do
  name=$(basename "$p")
  echo "→ Applying $name"
  if git apply --check --directory=vendor/pi "$p" 2>/dev/null; then
    git apply --directory=vendor/pi "$p"
    echo "  ✓ applied"
  elif git apply --reverse --check --directory=vendor/pi "$p" 2>/dev/null; then
    # The vendor tree is committed with patches applied, so on a normal
    # checkout every patch is already present — only a pristine tree
    # (mid-sync) actually needs applying.
    echo "  ✓ already applied — skipping"
  elif git apply --3way --directory=vendor/pi "$p" 2>/dev/null; then
    # Context drifted but the change still merges — typically an import block
    # or a nearby edit upstream. Without this fallback a patch that needed only
    # a context shift failed outright: at v0.84.4, 0020-bake-policy fails for
    # exactly that reason while its real anchor is untouched.
    echo "  ✓ applied via 3-way merge (context moved — consider regenerating)"
    threeway+=("$name")
  else
    echo "  ✗ does not apply cleanly"
    # Re-run without silencing stderr so the operator gets hunk-level detail
    # instead of just a filename.
    git apply --directory=vendor/pi "$p" 2>&1 | sed 's/^/      /' || true
    failed+=("$name")
  fi
done

if [ ${#threeway[@]} -ne 0 ]; then
  echo ""
  echo "Applied via 3-way merge — regenerate these against the new tree so the"
  echo "next sync starts from clean context (docs/WORKFLOW.md):"
  printf '  - %s\n' "${threeway[@]}"
fi

if [ ${#failed[@]} -ne 0 ]; then
  echo ""
  echo "FAILED patches (resolve manually, regenerate with git format-patch):"
  printf '  - %s\n' "${failed[@]}"
  exit 1
fi

echo ""
echo "✓ All ${#patches[@]} patches applied"
