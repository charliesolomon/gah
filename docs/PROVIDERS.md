# Restricting inference providers

Upstream PI ships a catalog of ~15 public inference providers (Anthropic,
OpenAI, Google, Ollama, …) plus three user-side ways to add more. GAH inverts
that: **deny all by default**, with two deployment-controlled mechanisms to
expose approved endpoints, and a third underneath them that decides which hosts
the process may open connections to at all.

Enforced by `patches/0010-restrict-model-sources.patch` (vendor) +
`packages/policy-pack/extensions/providers.ts` (policy pack). Since
`patches/0030-offline-model-data.patch` the built-in catalogue itself is no
longer upstream's: a build ships only the providers seeded from
[`packages/policy-pack/model-data/`](../packages/policy-pack/model-data/README.md)
(currently `amazon-bedrock` and `anthropic`) and an empty list for every other
provider, with no network access during the build.

## Mechanism 1 — `GAH_BUILTIN_MODELS`: allowlist built-in models

Comma-separated `provider/model-id` globs, matched against the built-in
catalog GAH ships. Unset or empty = no built-in models at all. A glob for a
provider that is not seeded matches nothing, however it is spelled.

```bash
# Specific Bedrock models only (Bedrock keeps its native AWS credential chain)
export GAH_BUILTIN_MODELS='amazon-bedrock/anthropic.claude-opus-4-7,amazon-bedrock/anthropic.claude-haiku-*'

# All Anthropic models (what bin/gah defaults to for development)
export GAH_BUILTIN_MODELS='anthropic/*'
```

Use this for providers whose auth can't be expressed as an API key — e.g.
`amazon-bedrock` resolves AWS credentials (profile, IAM keys, ECS/IRSA roles)
internally, which `registerProvider` cannot re-create.

The repo's `bin/gah` / `bin\gah.ps1` default this to `anthropic/*` so
development keeps working; **published artifacts have no wrapper and are
deny-all until the deployment sets it.**

## Mechanism 2 — `providers.json`: register approved endpoints

`providers.ts` reads `$GAH_PROVIDERS_FILE` (default `~/.gah/providers.json`).
Schema and a worked example: [`packages/policy-pack/providers.example.json`](../packages/policy-pack/providers.example.json)
(also shipped inside published artifacts at `dist/gah-policy/`).

- Works for any endpoint speaking an API PI knows: `openai-completions`,
  `openai-responses`, `anthropic-messages`, etc. Most enterprise gateways
  and proxies are OpenAI-compatible → `openai-completions`.
- `"apiKey": "$SOME_ENV_VAR"` resolves from the environment per request, so
  the file itself holds no secrets.
- **No file → nothing registered** (mechanism 1 still applies).
- **Bad file → fail closed**: nothing registered, error in stderr + audit log.
- Registered providers appear in `/login` alongside any allowlisted built-ins;
  everything else is absent from the list, not shown disabled.
- When a file is present it is authoritative for logins: built-in OAuth flows
  (`anthropic`, `github-copilot`, `openai-codex`) not listed in `keepOAuth`
  are removed from `/login`.

## Mechanism 3 — `GAH_ALLOWED_HOSTS`: network egress allowlist

`patches/0011-egress-allowlist.patch`. Comma-separated hostname globs; no HTTP
request leaves the process unless its host matches one. Unset or empty =
**deny everything**. Hostnames only, case-insensitive; ports and schemes are not
part of the policy.

```bash
# Shared host, Bedrock via static IAM keys in us-west-1
export GAH_ALLOWED_HOSTS='bedrock-runtime.us-west-1.amazonaws.com'

# Bedrock with role assumption, any region
export GAH_ALLOWED_HOSTS='*.amazonaws.com'

# Anthropic direct with OAuth: the API plus the token-refresh endpoint
export GAH_ALLOWED_HOSTS='api.anthropic.com,platform.claude.com'

# Corporate gateway from providers.json
export GAH_ALLOWED_HOSTS='inference.corp.example'
```

This is what makes the other two mechanisms a guarantee rather than a
configuration: a model that slipped past the registry, an extension that
registered a provider it should not have, or upstream code added after the
patch series was written all hit the same refusal. It covers every HTTP stack
in the process — undici (`fetch`, which the Anthropic, OpenAI and Google SDKs
and OAuth use), `node:http`/`node:https` and `node:http2` (which the AWS SDK
uses for Bedrock, with and without a proxy). Under an HTTP proxy the check sees
the target host, not the proxy.

A refused request fails with `GAH egress policy: "<host>" is not in
GAH_ALLOWED_HOSTS`, surfaced as the provider error, and is appended to the
audit log as `egress_blocked` once per host per session.

Defaults: `bin/gah` and `bin\gah.ps1` set `*` (no restriction — a workstation
points at whatever its user has, and the user owns the environment anyway).
`deploy/host/gah-launch` exports it empty, so the manifest must name the hosts;
`deploy/host/users.d/agent.conf.example` shows the Bedrock line. Published
artifacts have no wrapper and deny everything until the deployment sets it.

## What's closed off

| Surface | Disposition |
|---|---|
| Built-in catalog | Only seeded providers have any models (patch 0030); those are hidden unless `GAH_BUILTIN_MODELS` matches (patch 0010) |
| `/login`, `gah auth`, `ModelRegistry.getProviders()` | List only providers with at least one usable model (patch 0010). A denied built-in provider does not appear, so nobody stores a credential for a provider that can never serve a model. |
| Re-registering a built-in provider id from an extension | Still subject to `GAH_BUILTIN_MODELS`, whether registered by config or as a native provider object (patch 0010). A `providers.json` entry that reuses a built-in id such as `anthropic` therefore also needs that provider allowlisted; use a new id to sidestep the built-in catalogue entirely. |
| `~/.gah/agent/models.json` | Read unless `GAH_ALLOW_MODELS_JSON` is set to anything but `1` (patch 0010). `bin/gah` and `bin\gah.ps1` default it **on**, since a workstation exists to point at its user's endpoint. `deploy/host/gah-launch` defaults it **off** and exports it either way, so a user's own environment cannot switch it on — models.json carries its own `baseUrl` and `apiKey`, so honouring one there would route around this table entirely. |
| `pi.registerProvider()` from extensions | Only GAH's own extensions load (`--no-extensions` + explicit list / baked `gah-policy`) |
| Built-in OAuth `/login` flows | Removed when a providers file is present, except `keepOAuth` entries |
| Stray env API keys (`OPENAI_API_KEY`, …) | Inert — keys only matter for models that exist in the registry |
| Any HTTP request to a host not in `GAH_ALLOWED_HOSTS` | Refused before it leaves the process, on every HTTP stack (patch 0011). Unset = deny all. |

All provider registrations and OAuth removals are appended to the audit log
(`$GAH_AUDIT_LOG`, default `~/.gah/audit.log`).

## Layers, summarised

| Layer | Answers | Where |
|---|---|---|
| IAM policy on the per-agent AWS keys | which Bedrock models the credentials can invoke | AWS, not GAH |
| `GAH_ALLOWED_HOSTS` (0011) | which hosts the process may connect to | the binary, every HTTP stack |
| `GAH_BUILTIN_MODELS` (0010) + `providers.json` | which models and endpoints the user can pick | the model registry and the policy pack |

Each is independent; the two GAH layers are defence in depth around the first.
