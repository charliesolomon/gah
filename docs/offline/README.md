# Offline bootstrap: model catalog data

`pi-model-data.zip` — the 39 provider JSON files that
`vendor/pi/packages/ai/src/providers/data/` must contain before the build will run.
59K compressed, ~656K expanded.

## Why this exists

Those files are **gitignored upstream**, but 39 tracked `*.models.ts` shards import
them and `src/models.generated.ts` requires all 39 to be present. A fresh clone
therefore cannot build without first hydrating them from ~20 vendor APIs — see
[WINDOWS.md](../WINDOWS.md#network-requirements).

On a network with a TLS-inspecting, authenticating proxy that hydration cannot
complete: Node's `fetch` reaches the proxy only with `--use-env-proxy`, and then
undici can offer **Basic** auth only — so an NTLM or Kerberos proxy returns 407 and
no flag will get past it. See [#14](https://github.com/charliesolomon/gah/issues/14).

This archive removes the network from the equation entirely.

## Use

```powershell
# from the repository root
Expand-Archive docs\offline\pi-model-data.zip -DestinationPath vendor\pi\packages\ai\src\providers\
cd vendor\pi
npm run build:offline
```

```bash
unzip -o docs/offline/pi-model-data.zip -d vendor/pi/packages/ai/src/providers/
cd vendor/pi && npm run build:offline
```

`build:offline` is the correct command *once the data exists* — it skips hydration
and compiles what is there.

## Staleness does not matter here

The catalogs are a point-in-time snapshot and will drift from upstream. That has no
practical effect: `patches/0010-restrict-model-sources.patch` denies the built-in
catalogue entirely — *"unset or empty means NO built-in models are exposed"* — so
these entries are compiled in and then filtered to nothing. Models come from the
policy pack and `/etc/gah/users.d/<user>.conf`.

Refresh it by re-zipping `data/` from any clone that has built with network access.

## Delete this when #15 lands

[#15](https://github.com/charliesolomon/gah/issues/15) proposes making the catalogue
vestigial — emitting empty catalogs without network calls, so no data is needed and
no vendor model list ships in `dist/`. This directory is a workaround for a problem
that issue removes.

Snapshot taken 2026-09-01 from upstream v0.84.4; verified with
`node packages/ai/scripts/check-model-data.ts` → *Generated model data is valid.*
