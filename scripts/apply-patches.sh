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
  else
    echo "  ✗ does not apply cleanly"
    failed+=("$name")
  fi
done

if [ ${#failed[@]} -ne 0 ]; then
  echo ""
  echo "FAILED patches (resolve manually, regenerate with git format-patch):"
  printf '  - %s\n' "${failed[@]}"
  exit 1
fi

echo ""
echo "✓ All ${#patches[@]} patches applied"
