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
# 0020-bake-policy resolves the policy dir relative to the running entry point
# (import.meta.url), so this must land beside cli.js — which upstream moved from
# dist/ to dist/bundle/ in v0.84.4. Derive it from the package's bin field so it
# tracks future moves instead of silently bundling into the wrong directory.
CA_DIR="$REPO_ROOT/vendor/pi/packages/coding-agent"
CLI_REL="$(node -e "
  const fs=require('node:fs');
  const b=JSON.parse(fs.readFileSync('$CA_DIR/package.json','utf8')).bin;
  console.log(typeof b === 'string' ? b : Object.values(b || {})[0] || 'dist/cli.js');
" 2>/dev/null || echo dist/cli.js)"
DIST="$CA_DIR/$(dirname "$CLI_REL")"
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
