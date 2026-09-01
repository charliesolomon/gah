# Restricting inference providers

Upstream PI ships a catalog of ~15 public inference providers (Anthropic,
OpenAI, Google, Ollama, …) plus three user-side ways to add more. GAH inverts
that: **deny all by default**, with two deployment-controlled mechanisms to
expose approved endpoints.

Enforced by `patches/0010-restrict-model-sources.patch` (vendor) +
`packages/policy-pack/extensions/providers.ts` (policy pack).

## Mechanism 1 — `GAH_BUILTIN_MODELS`: allowlist built-in models

Comma-separated `provider/model-id` globs, matched against PI's built-in
catalog. Unset or empty = no built-in models at all.

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
- When a file is present it is authoritative for logins: built-in OAuth flows
  (`anthropic`, `github-copilot`, `openai-codex`) not listed in `keepOAuth`
  are removed from `/login`.

## What's closed off

| Surface | Disposition |
|---|---|
| Built-in catalog (~15 providers) | Hidden unless `GAH_BUILTIN_MODELS` matches (patch 0010) |
| `~/.gah/agent/models.json` | Read unless `GAH_ALLOW_MODELS_JSON` is set to anything but `1` (patch 0010). `bin/gah` and `bin\gah.ps1` default it **on**, since a workstation exists to point at its user's endpoint. `deploy/host/gah-launch` defaults it **off** and exports it either way, so a user's own environment cannot switch it on — models.json carries its own `baseUrl` and `apiKey`, so honouring one there would route around this table entirely. |
| `pi.registerProvider()` from extensions | Only GAH's own extensions load (`--no-extensions` + explicit list / baked `gah-policy`) |
| Built-in OAuth `/login` flows | Removed when a providers file is present, except `keepOAuth` entries |
| Stray env API keys (`OPENAI_API_KEY`, …) | Inert — keys only matter for models that exist in the registry |

All provider registrations and OAuth removals are appended to the audit log
(`$GAH_AUDIT_LOG`, default `~/.gah/audit.log`).

## Not yet implemented

Network-level egress allowlisting (wrap PI's global undici dispatcher in
`core/http-dispatcher.ts` with an approved-hosts check) would guarantee that
no code path — present or future — reaches a non-approved host. Reserved as a
potential `0011` patch if defense in depth is wanted on top of the registry
restriction.
