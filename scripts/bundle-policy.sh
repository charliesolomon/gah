#!/usr/bin/env bash
#
# bundle-policy.sh — copy the policy pack into the built coding-agent dist.
#
# Publishing prep: patches/0020-bake-policy.patch makes the CLI force-load
# extensions from dist/gah-policy/extensions/ and disable auto-discovery, so
# a published artifact (npm package, tarball) enforces GAH policy without the
# bin/gah wrapper. Dev builds skip this script and keep using the wrapper.
#
# Layout matters: branding.ts resolves SYSTEM.md at ../SYSTEM.md relative to
# itself, so the bundle mirrors the policy-pack shape:
#   dist/gah-policy/extensions/*.ts
#   dist/gah-policy/SYSTEM.md
#
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DIST="$REPO_ROOT/vendor/pi/packages/coding-agent/dist"
PACK="$REPO_ROOT/packages/policy-pack"

if [ ! -d "$DIST" ]; then
  echo "bundle-policy: no build at $DIST — run 'make build' first." >&2
  exit 1
fi

rm -rf "$DIST/gah-policy"
mkdir -p "$DIST/gah-policy/extensions"
cp "$PACK"/extensions/*.ts "$DIST/gah-policy/extensions/"
cp "$PACK/SYSTEM.md" "$DIST/gah-policy/"
cp "$PACK/providers.example.json" "$DIST/gah-policy/"

echo "✓ policy pack bundled into dist/gah-policy/"
ls "$DIST/gah-policy" "$DIST/gah-policy/extensions"
