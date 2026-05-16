#!/usr/bin/env bash
#
# clean-vendor.sh — discard any local working-tree changes inside vendor/pi.
#
# The PI build script regenerates some tracked source files (notably
# packages/ai/src/models.generated.ts, which is rebuilt from live provider
# catalogs). Run this before a sync to ensure vendor/pi matches the recorded
# upstream state.
#
# Patches in patches/ are NOT in vendor/pi at rest; they live separately and
# are re-applied after a sync. So discarding working-tree changes here is safe.
#
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

if [ ! -d vendor/pi ]; then
  echo "vendor/pi missing — nothing to clean."
  exit 0
fi

if git diff --quiet -- vendor/pi && git diff --quiet --cached -- vendor/pi; then
  echo "vendor/pi is clean."
  exit 0
fi

echo "→ Discarding working-tree changes in vendor/pi"
git checkout HEAD -- vendor/pi
echo "✓ vendor/pi reset to last commit"
