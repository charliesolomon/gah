# Built-in model data GAH ships

Upstream PI hydrates `packages/ai/src/providers/data/` from about twenty vendor
APIs during `npm run build`, then bundles the result (39 providers, ~650K) into
`dist/`. GAH denies that catalogue at runtime (patch 0010), so the fetch bought
nothing and broke every fresh clone without network — see issue #15.

Patch `0030-offline-model-data` replaces the fetch with
`packages/ai/scripts/gah-model-data.ts`, which materialises the data directory
from **this** folder: every provider that has a `<provider>.json` here is
shipped verbatim, every other provider ships an empty catalogue (`{}`). The
build makes no network calls, and the model list in `dist/` is exactly what is
committed here.

Point `GAH_MODEL_DATA_DIR` at another directory to seed from somewhere else;
set it to the empty string to ship every provider empty.

## What is here and why

| File | Why it is shipped |
|---|---|
| `amazon-bedrock.json` | The shared host allowlists `amazon-bedrock/us.anthropic.*` (`deploy/host/users.d/agent.conf.example`). Bedrock resolves AWS credentials internally, which the policy pack cannot re-create through `registerProvider`, so its models have to exist in the built-in catalogue for `GAH_BUILTIN_MODELS` to have anything to match. |
| `anthropic.json` | `bin/gah` and `bin\gah.ps1` default `GAH_BUILTIN_MODELS` to `anthropic/*` for development against an Anthropic key or OAuth login. |

`GAH_BUILTIN_MODELS` still filters at runtime: a provider being seeded here
does not expose it. Removing a file from this folder removes that provider's
models from every build, whatever the allowlist says.

## Refreshing

The files are upstream's generated output, copied as-is. To pick up new models
or pricing, on a machine with network access:

```bash
make refresh-model-data    # hydrates from the vendor APIs, copies seeded providers back here
git diff --stat packages/policy-pack/model-data
```

Review the diff like any other policy change. A new provider is seeded by
copying its file from `vendor/pi/packages/ai/src/providers/data/` after that
hydration; the file name must match a provider shard upstream still has, or
the build fails and says so.

## Format

Each file is the per-provider structure `check:model-data` validates: models
grouped by API, `{ "<api>": { "<model-id>": { …model } } }`. Do not hand-edit
model entries; regenerate them.
