---
name: package-deploy
description: Build and publish a GAH deployment package for Windows consumers from an organisation's gah-deploy.json. Use when a GAH admin asks to package, release, publish, or roll out GAH to teammates, or to bump the deployment version.
allowed-tools: Read, Grep, Glob, Bash
---

# Package and publish a GAH deployment

You are helping a GAH **admin** turn this repository plus their organisation's
`gah-deploy.json` into a zip their teammates install. Everything you need is
in the repo; read `docs/DEPLOY-WINDOWS.md` first if anything below is unclear.

## Before you start

1. Find the config. Ask for the path if it is not obvious; it usually lives in the
   organisation's own deployment repo, not here. Validate it by reading it against
   the schema in `docs/DEPLOY-WINDOWS.md` and `templates/deploy/gah-deploy.example.json`.
   Point out anything that looks wrong **before** building: an empty
   `GAH_ALLOWED_HOSTS` (nothing will be reachable), a provider without `models`,
   a `version` that was already published.
2. Confirm the tree is built: `vendor/pi/packages/coding-agent/dist/bundle/cli.js`
   must exist. If not, run `make build-all` (or `cd vendor/pi && npm run build`).

## Build

```bash
node scripts/package-windows.mjs --config <path>/gah-deploy.json
```

This assembles `dist-deploy/gah-<org>-<version>/`, runs the tool-surface check
against that tree (the package must offer the model exactly the policy's tools),
and writes `dist-deploy/gah-<org>-<version>.zip` with a `.sha256`. Report the
sha256 line and the versions it prints. If the check fails, stop and show the
failure; do not publish.

## Publish

```bash
GAH_GITLAB_TOKEN=... node scripts/publish-gitlab.mjs --config <path>/gah-deploy.json --zip dist-deploy/gah-<org>-<version>.zip
```

Ask the admin for the token if it is not in the environment; never echo it.
Consumers already installed pick the new version up on their next launch.

## Bump for next time

After a successful publish, increment `version` in the config (semantic:
patch for policy/prompt tweaks, minor for a new gah build) and tell the admin
to commit it to their deployment repo. Do not edit the config without saying so.

## What not to do

- Do not change files under `vendor/` or `patches/`; packaging never needs to.
- Do not put endpoint URLs, tokens or keys into this repository or into chat
  output. They belong in the organisation's deployment repo and environment.
