# Restricting inference providers

gah denies every model and every network host by default. A deployment opens
exactly what it approves. This page is for the admin choosing which models and
endpoints a deployment can use.

## The three layers

| Layer | Decides | Set with |
|---|---|---|
| [Built-in models](#gah_builtin_models-built-in-models) | which models from gah's own catalogue can be picked | `GAH_BUILTIN_MODELS` |
| [Approved endpoints](#providersjson-approved-endpoints) | which other endpoints (a corporate gateway, say) are registered | `providers.json` |
| [Network egress](#gah_allowed_hosts-network-egress) | which hosts the process may connect to at all | `GAH_ALLOWED_HOSTS` |

Each is independent. Egress is the guarantee under the other two: whatever a
model registry or extension does, a request to an unlisted host never leaves
the process. Cloud IAM (for example, which Bedrock models an agent's AWS keys
may invoke) sits outside gah, as a fourth layer.

Most deployments use one of two patterns:

- **A corporate gateway:** one entry in `providers.json`, its host in
  `GAH_ALLOWED_HOSTS`, `GAH_BUILTIN_MODELS` empty.
- **Bedrock or Anthropic directly:** `GAH_BUILTIN_MODELS` names the models, and
  `GAH_ALLOWED_HOSTS` names the provider's host.

The deployment launchers set these for you from their config:
[DEPLOY-WINDOWS.md](DEPLOY-WINDOWS.md) and [DEPLOY-LINUX.md](DEPLOY-LINUX.md)
for packages, a manifest for the [shared host](../deploy/host/README.md). A
checkout's `bin/gah` and `bin\gah.ps1` open everything up for development
([defaults](#defaults)).

## `GAH_BUILTIN_MODELS`: built-in models

Comma-separated `provider/model-id` globs. Unset or empty means no built-in
models.

```bash
# Specific Bedrock models only (Bedrock keeps its native AWS credential chain)
export GAH_BUILTIN_MODELS='amazon-bedrock/anthropic.claude-opus-4-7,amazon-bedrock/anthropic.claude-haiku-*'

# All Anthropic models (bin/gah's development default)
export GAH_BUILTIN_MODELS='anthropic/*'
```

A build ships models for only two providers, `amazon-bedrock` and `anthropic`,
seeded from [`packages/policy-pack/model-data/`](../packages/policy-pack/model-data/README.md);
a glob for any other provider matches nothing. Use this layer for providers
whose auth is not a plain API key: Bedrock resolves AWS credentials (profile,
IAM keys, roles) itself.

To turn a checkout's development default off, set the variable to `none`. In
PowerShell that is the only way, because assigning an empty string removes the
variable.

## `providers.json`: approved endpoints

The policy pack reads `$GAH_PROVIDERS_FILE` (default `~/.gah/providers.json`).
Schema and a worked example: [`packages/policy-pack/providers.example.json`](../packages/policy-pack/providers.example.json).
Deployment packages generate this file from their config.

- Any API pi speaks works: `openai-completions`, `openai-responses`,
  `anthropic-messages`, and so on. Most enterprise gateways are
  OpenAI-compatible (`openai-completions`).
- `"apiKey": "$SOME_ENV_VAR"` reads the key from the environment, so the file
  holds no secret. Omit `apiKey` and the person runs `/login` once instead.
- **No file:** nothing registered. **A bad file:** fail closed (nothing
  registered, an error on stderr and in the audit log).
- When a file is present, built-in OAuth logins not listed in `keepOAuth` are
  removed from `/login`.

**For a development checkout,** `make add-provider` (`node scripts/add-provider.mjs`)
asks for the endpoint, its protocol, auth and models, and writes the file for
you. It offers to [probe the endpoint](#probing-an-endpoint) first.

### Probing an endpoint

`make probe-endpoint URL=https://... KEY_ENV=VAR` (or `scripts/probe-endpoint.mjs`)
reports what an endpoint actually offers, so the config is built from facts:

- the model ids and, where the server says, their context and output limits;
- which protocol answers (`/responses`, `/chat/completions`) and whether streaming works;
- whether the gateway keeps the conversation history (one that forwards only
  the latest message cannot run an agent);
- whether native tool calls work, which decides the [`"tools"` mode](#gateways-that-refuse-tool-calls-tools-prompted);
- for a prompted endpoint, whether the system prompt reaches the model and the
  model follows the tool protocol.

Each failed check quotes what the model replied. The probe writes nothing, and
the key never goes on a command line. Requests go one at a time, with a 60 s
timeout (`TIMEOUT=seconds`) and one retry.

### The last model picked is the next session's default

Every `/model` pick is saved as the startup default in the agent directory's
`settings.json` (upstream saves only on Ctrl+S). `GAH_REMEMBER_MODEL=0` turns
this off. Each save is an audit line (`default_model`).

### Gateways that refuse tool calls: `"tools": "prompted"`

Some corporate gateways strip or reject the `tools` field. The model then gets
no tools and, instead of saying so, invents what a file or directory listing
might have contained.

Set `"tools": "prompted"` on such a provider (or on one model in it; the
default is `"native"`). gah then sends no `tools` array: it describes the
tools in the system prompt, and the model asks for one with a fenced block:

````
```tool
TOOL_NAME: read
BEGIN_ARG: path
docs/SKILLS.md
END_ARG
```
````

Each block becomes an ordinary tool call, so the allowlist, protected paths,
secret files and audit log all apply as for a native call. The HTTP call is
still upstream's own, so auth, proxies and egress are unchanged. One tool call
per reply; parallel calls are not supported.

Two things a gateway can still break. The probe tells you which:

- **The system prompt never reaches the model** (`System prompt: IGNORED`).
  Set `"toolsPrompt": "user"` (per provider or per model): the whole system
  prompt, protocol included, goes on the person's latest turn instead.
- **The model doesn't follow the protocol** (`Prompted tool protocol: NOT FOLLOWED`).
  Nothing in gah can fix this; pick another model on that endpoint.

The `/rrr` prompt template in a skills repository is a quick acceptance test:
its answer must name real files. For a session that still invents results, set
`GAH_PROMPTED_DEBUG=<file>` to log each prompted request's shape, the stop
reason and the raw reply (it holds conversation text; keep it out of the repo).

Implementation: `packages/policy-pack/extensions/lib/prompted-tools.ts`.
Tests: `make check-prompted` and `make test-policy`.

## `GAH_ALLOWED_HOSTS`: network egress

Comma-separated hostname globs, case-insensitive; no HTTP request leaves the
process unless its host matches one. Unset or empty means **deny everything**.

```bash
# Bedrock via static IAM keys in one region
export GAH_ALLOWED_HOSTS='bedrock-runtime.us-west-1.amazonaws.com'

# Bedrock with role assumption, any region
export GAH_ALLOWED_HOSTS='*.amazonaws.com'

# Anthropic directly with OAuth: the API plus the token-refresh endpoint
export GAH_ALLOWED_HOSTS='api.anthropic.com,platform.claude.com'

# A corporate gateway from providers.json
export GAH_ALLOWED_HOSTS='inference.corp.example'
```

It covers every HTTP stack in the process (`fetch`/undici, `node:http`,
`node:https`, `node:http2`). Behind an HTTP proxy it checks the target host,
not the proxy. A refused request fails with `GAH egress policy: "<host>" is
not in GAH_ALLOWED_HOSTS` and is logged once per host per session
(`egress_blocked`).

## Defaults

| Launcher | `GAH_BUILTIN_MODELS` | `GAH_ALLOWED_HOSTS` | `models.json` |
|---|---|---|---|
| Checkout (`bin/gah`, `bin\gah.ps1`) | `anthropic/*` | `*` (no restriction) | read |
| Deployment package | from the config (usually empty) | from the config | ignored |
| Shared host (`gah-launch`) | from the manifest | from the manifest (empty = deny all) | ignored |
| No wrapper at all | none | deny all | ignored unless `GAH_ALLOW_MODELS_JSON=1` |

A checkout is a workstation: it points at whatever endpoint its user has, so
it reads `~/.gah/agent/models.json` too. A shared host never does, because
`models.json` carries its own URL and key and would route around every layer
above. `bin\gah.ps1` removes the defaults it set when the session ends.

## Reference: what's closed off

| Surface | What happens |
|---|---|
| Built-in catalogue | Only seeded providers have models (patch 0030); those are hidden unless `GAH_BUILTIN_MODELS` matches (patch 0010). |
| `/login`, `gah auth`, the provider list | Show only providers with at least one usable model, so nobody stores a key for a provider that can never serve one (patch 0010). |
| An extension re-registering a built-in id | Still subject to `GAH_BUILTIN_MODELS`. A `providers.json` entry named `anthropic` needs that provider allowed; use a new id to avoid the built-in catalogue. |
| `~/.gah/agent/models.json` | Ignored when `GAH_ALLOW_MODELS_JSON` is set to anything but `1` ([defaults](#defaults)). |
| `pi.registerProvider()` from extensions | Only gah's own extensions load. |
| Built-in OAuth logins | Removed when a providers file is present, except `keepOAuth` entries. |
| Stray API-key variables (`OPENAI_API_KEY`, …) | Inert: a key matters only for a model that exists in the registry. |
| A request to a host not in `GAH_ALLOWED_HOSTS` | Refused before it leaves the process (patch 0011). |

Provider registrations and OAuth removals are written to the audit log
(`$GAH_AUDIT_LOG`, default `~/.gah/audit.log`). Code: `patches/0010-restrict-model-sources.patch`,
`patches/0011-egress-allowlist.patch` and `packages/policy-pack/extensions/providers.ts`.
