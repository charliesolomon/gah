# Built-in model data gah ships

The only built-in model catalogue a gah build contains. This page is for
maintainers: what is seeded, why, and how to refresh it.

Upstream pi fetches model data from about twenty vendor APIs during its build.
gah denies that catalogue at runtime anyway (patch 0010), so patch
`0030-offline-model-data` replaces the fetch with
`packages/ai/scripts/gah-model-data.ts`, which seeds the data from **this**
folder: each `<provider>.json` here ships as-is, every other provider ships
empty. The build makes no network calls.

`GAH_MODEL_DATA_DIR` seeds from another directory instead; the empty string
ships every provider empty.

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

The refresh then re-applies GAH's corrections to upstream's catalogue, which
live in `scripts/model-data-overrides.mjs` rather than in these files, because a
hand edit here would be undone by the next refresh without anyone noticing.
There is one today:

| File | Override | Why |
|---|---|---|
| `amazon-bedrock.json` | `compat.supportsStrictMode: false` for every model | Bedrock forwards `toolSpec.strict` to model backends that reject it; with it on, every session fails on its first turn (#108). Off is the wire format every pi before 0.86 sent. Re-enable a family only after `make check-live` passes in a deployment configured for one of its models. |

`make test-policy` fails if a committed seed file is missing an override.

Review the diff like any other policy change. A new provider is seeded by
copying its file from `vendor/pi/packages/ai/src/providers/data/` after that
hydration; the file name must match a provider shard upstream still has, or
the build fails and says so.

## Format

Each file is the per-provider structure `check:model-data` validates: models
grouped by API, `{ "<api>": { "<model-id>": { …model } } }`. Do not hand-edit
model entries; regenerate them, and put any correction in the overrides script.
