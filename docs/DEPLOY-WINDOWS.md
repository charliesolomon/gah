# Deploying gah as a Windows package

A deployment package is one zip that a person installs on their own Windows 11
machine. The admin builds it from a gah checkout and a config file, and
publishes it to the team's GitLab. From then on, every launch keeps the
package and the team's skills up to date. The person needs no git, npm or
clone: only Node 22+.

This page is for the admin. If you haven't chosen between a package, the
shared Linux host and checkouts yet, start at [DEPLOY.md](DEPLOY.md#choose-a-shape).
Packages use GitLab, the one team forge gah supports today; see
[DEPLOY.md](DEPLOY.md#the-team-forge). The Linux package is built from the same
config: [DEPLOY-LINUX.md](DEPLOY-LINUX.md) covers what differs.

```
admin machine                      team GitLab                     person (Win11)
gah checkout + gah-deploy.json ──► package registry ◄──── Install-Gah.ps1, then gah.ps1 on every launch
                                   skills project   ◄──── the branch, when its head moved
```

**Four steps:** write the config, build, publish, and have people install.

**You need:**
- a gah checkout with a completed build (`make build-all`, or [WINDOWS.md](WINDOWS.md) on Windows);
- on GitLab, a deployment project (for the config and the package registry) and
  a skills project ([GITLAB.md](GITLAB.md));
- an inference endpoint and its models ([PROVIDERS.md](PROVIDERS.md));
- a GitLab token with `api` scope on the deployment project, to publish.

## 1. Write gah-deploy.json

The config lives in your deployment project, not in this repository. Copy
[`templates/deploy/gah-deploy.example.json`](../templates/deploy/gah-deploy.example.json)
and fill in at least:

- `org`, `name` and `version`;
- `gitlab.url` and `gitlab.project` (the deployment project), and `skills.project`;
- `env.GAH_ALLOWED_HOSTS`: the inference host, the only host the agent may reach;
- `providers`: the inference endpoint and its models.

Every field is described in the [reference](#gah-deployjson) below. The
config never holds keys or tokens.

## 2. Build and 3. publish

```bash
make build-all                                             # once per gah version
node scripts/package-windows.mjs --config ../deploy/gah-deploy.json
GAH_GITLAB_TOKEN=... node scripts/publish-gitlab.mjs --config ../deploy/gah-deploy.json --zip dist-deploy/<name>-win11-<version>.zip
```

- **Raise `version` before you build**, because the zip is named from it.
  Publish, then commit the config, so it always names the published version.
  Versions are digits and dots, two to four parts (`1.0.4`, or `1.0.4.1` for a
  rebuild); anything else, such as `1.0.4-1`, breaks every update check.
- The packager checks that the package offers the model exactly the policy's
  tools before it zips.
- Behind a client certificate or a proxy, see
  [Certificates and proxies](#certificates-and-proxies).

The `gah-deployments` skill walks through all of this, including creating a
new deployment project and the steps in GitLab. Start gah from this repository
with a shell allowed (`$env:GAH_ALLOW_TOOLS='powershell'; .\bin\gah.ps1` on
Windows, `GAH_ALLOW_TOOLS=bash bin/gah` elsewhere), trust the project when
asked, and say what you want, e.g. "upgrade our deployment to the latest gah".

Building in a GitLab pipeline instead is tracked in
[#84](https://github.com/charliesolomon/gah/issues/84).

## 4. People install

Give people the deployment project's README; [a template](../templates/deploy/DEPLOY-PROJECT-README.md)
is ready to fill in. In short:

1. Download `<name>-win11-<version>.zip` from the deployment project's package
   registry and unzip it.
2. In PowerShell, in the unzipped folder, run `.\Install-Gah.ps1`. It:
   - checks Node 22+, and copies the package to `%LOCALAPPDATA%\gah\<package>`;
   - verifies and unpacks the pinned `fd` and `rg`;
   - asks for a GitLab token (Enter skips it: the project may be visible
     without one, or the person can add it later with `/setup-skills`);
   - asks for a client certificate, when `gitlab.clientCert` is `"user"`;
   - asks for any API key the config collects through an environment variable;
   - creates the desktop shortcut and a `gah` command in the PowerShell
     profile (an existing `gah` is left alone, with a warning).
3. Double-click the shortcut.

Re-running the installer repairs an installation. `-NoPrompt` asks nothing,
for installs through a management tool; set keys as user environment
variables separately.

To uninstall, run `%LOCALAPPDATA%\gah\Uninstall-Gah.ps1`. It removes the
packages, the skills cache, the shortcut, the `gah` command and the stored
token and API keys (`-KeepSecrets` keeps those). The agent's own state in
`~\.gah` (keys from `/login`, audit log, sessions) stays unless `-Purge`.

## First launch and setup

A session starts as soon as Node works and a model can be reached with a key.
Everything else, including GitLab access, can be finished from inside the
session ([#135](https://github.com/charliesolomon/gah/issues/135)).

**Before the session**, the launcher makes sure of three things:

| Needed | When it is missing |
|---|---|
| **Node 22+** | Offers to install Node.js LTS with `winget`, or says where to get it. |
| **A route to the model** | `preflight.mjs` tries, in order: what worked last time, a direct connection, `HTTPS_PROXY`, the Windows system proxy (including an automatic configuration script), the config's `inferenceProxy`, and finally asks. A proxy that wants a login stops with a clear message; gah does not support those. |
| **A working API key** | Checked against the provider's model list, never with a chat request (some gateways bill per message). When no provider has a key that works, the person is asked for one, masked, until one works or they give up. |

Node does not use the Windows proxy settings by itself, so the launcher
exports the route preflight found as `HTTPS_PROXY`. On a direct route it adds
the inference hosts to `NO_PROXY` instead. A proxy without a scheme
(`10.0.0.1:8080`) is read as `http://`.

**In the session**, setup appears only while it can help
([#138](https://github.com/charliesolomon/gah/issues/138)):

- With no team skills, a line above the input box says *gah is better with
  your team's skills. Type /setup-skills to set them up.*
- When the launcher could not update the skills it already had (an expired
  token, say), the line says *Your team's skills couldn't be updated* instead.
- Otherwise none of the setup is registered: it is not in the system prompt or
  the slash menu.

`/setup-skills` runs the `setup-skills` skill, which only the person can
start. It uses the `gah_setup` tool to find what is missing and does only the
next step: fetch the skills if GitLab already works, or run `setup-gitlab`
(a client certificate if needed, then a `read_api` token typed into a masked
dialog). The model never sees the token.

A deployment can replace `setup-gitlab`, or any setup skill, with its own
(`setupSkills`), for what only its people know: who issues certificates,
internal help links. `setupSkills: false` turns in-session setup off.

Updates need none of this when the deployment project is public: the update
check falls back to an anonymous request.

## Certificates and proxies

**Admin scripts** run in Node. Behind a corporate proxy, set
`NODE_OPTIONS=--use-system-ca --use-env-proxy` and `HTTPS_PROXY`, as for the
build ([WINDOWS.md](WINDOWS.md)). If GitLab's certificate comes from an
internal CA that Node doesn't trust, point `NODE_EXTRA_CA_CERTS` at the PEM
git uses (`git config --get http.sslCAInfo`). Exclude an internal GitLab with
`NO_PROXY=<gitlab-host>`.

**The person's launcher and installer** talk to GitLab from PowerShell, which
uses the Windows certificate store and system proxy. Managed machines
normally trust the corporate CA already.

**Mutual TLS.** Some GitLab instances sit behind a front end that wants a
client certificate (a sign: git needs `http.<url>.sslCert` to reach it). Set
`gitlab.clientCert` to `"user"`:

- the installer lists the person's certificates that have a private key, and
  stores the chosen thumbprint as `GAH_GITLAB_CERT_THUMBPRINT`;
- the launcher presents it on every GitLab call;
- to publish, pass the same certificate to the admin script, e.g.
  `--cert "CurrentUser\MY\<thumbprint>"` (or `GAH_GITLAB_CLIENT_CERT`). Uploads
  then go through `curl.exe`, which uses the Windows store as git does.

## Reference

### gah-deploy.json

| Field | Meaning |
|---|---|
| `org` | Organisation name |
| `name` | Optional base name of the registry package and the zips: lower-case letters, digits, `.`, `_` and `-` (e.g. `gah-orgname-engineering`). Default `gah-<org>`, slugged. Builds are `<name>-win11-<version>.zip` and `<name>-linux-<version>.zip`. Changing `name` or `gitlab.package` later strands installed copies, which keep looking under the old registry package: each must reinstall once from the new one. |
| `shortcutName` | Desktop shortcut and window title (default `<org> Assistant`) |
| `version` | Package version, digits and dots; the launcher updates when the registry has a higher one ([GITLAB.md](GITLAB.md#versioning)) |
| `gitlab.url`, `gitlab.project`, `gitlab.package` | Where packages are published and looked up (generic package registry). `package` defaults to `name`; the Windows and Linux zips of a version share it, and each launcher updates to the highest version that holds its own platform's zip |
| `gitlab.clientCert` | `"user"` when GitLab sits behind a mutual-TLS front end ([above](#certificates-and-proxies)); `null` otherwise |
| `gitlab.clientCertIssuer` | Optional substring of the issuing CA's name (e.g. `"Org Issuing CA"`); the installer lists certificates from that CA first. A certificate git already uses for this GitLab is always listed first and marked. |
| `gitlab.proxy` | `null` (default): the machine's `HTTPS_PROXY` / `HTTP_PROXY`, honouring `NO_PROXY`, falling back to the Windows proxy settings. A URL forces that proxy; `"none"` forces a direct connection. |
| `skills.project`, `skills.branch` | The skills project fetched on every launch (default branch `main`) |
| `env` | `GAH_*` variables the launcher exports: `GAH_ALLOWED_HOSTS` (the inference host; unset means nothing is reachable), `GAH_BUILTIN_MODELS` (usually empty), `GAH_ALLOW_TOOLS` (usually empty; `powershell` to allow a shell), `GAH_SECRET_FILES` (credential files the model may never see, `;`-separated globs, e.g. `%USERPROFILE%\\*.env`), `GAH_ALLOW_SHARE` |
| `providers` | The contents of `providers.json` ([PROVIDERS.md](PROVIDERS.md)). `apiKey` may be a literal, `"$VAR"` (the installer prompts and stores `VAR` as a user environment variable), or omitted (the key lands in `auth.json`). `"tools": "prompted"` for a gateway that refuses native tool calls ([PROVIDERS.md](PROVIDERS.md#gateways-that-refuse-tool-calls-tools-prompted)). |
| `systemMd` | Optional path, relative to the config, of a `SYSTEM.md` override |
| `icon` | Optional `.ico` for the desktop shortcut (16/32/48/256 sizes), relative to the config. Absent = the stock terminal icon |
| `windowsArch` | Default `["x64"]`; add `"arm64"` to ship both tool sets |
| `linuxArch` | The Linux package's tool architectures (default `["x64"]`); see [DEPLOY-LINUX.md](DEPLOY-LINUX.md) |
| `inferenceProxy` | Optional proxy URL to offer when the inference endpoint is not reachable directly ([first launch](#first-launch-and-setup)). `null` = none. |
| `setupSkills` | Optional folder, relative to the config, of the deployment's own setup skills: one folder per skill with a `SKILL.md`. One with the same name as a built-in one (`setup-skills`, `setup-gitlab`) replaces it; the packager marks each `disable-model-invocation: true` so only the person starts it, and refuses one that looks like it holds a credential (anyone in the organisation can download the zip). `false` turns in-session setup off entirely, for a deployment its admin configures. |
| `skillsNudge` | Default `true`. `false` hides the /setup-skills line, for a deployment that never uses shared skills. |

### What is in the package

`<name>-win11-<version>.zip` unpacks to one folder:

| Path | What |
|---|---|
| `bundle/` | upstream's self-contained build; runs on bare Node |
| `dist/…`, `docs/`, `package.json` | the few assets the bundle reads beside itself |
| `node_modules/jiti`, `…/photon-node`, `…/@earendil-works/chord` | the packages the bundle leaves external (the packager checks this list against upstream's bundle script) |
| `node_modules/esbuild` | a stub: upstream imports esbuild at startup for a plugin bundler gah never runs, so the stub saves an 11 MB native binary and fails clearly if that path is ever reached |
| `gah-policy/` | the policy pack, your `SYSTEM.md` if given, and `providers.json` from the config. Always loaded (patch 0020); auto-discovery is off. |
| `gah-policy/setup-skills/`, `gah-policy/deploy-setup-skills/` | the built-in setup skills and the deployment's own (`setupSkills`) |
| `preflight.mjs` | run before every session: a route to the model and a working key |
| `tools/` | pinned `fd` and `ripgrep` archives plus `SHA256SUMS` |
| `gah.ps1`, `Install-Gah.ps1`, `Uninstall-Gah.ps1` | the launcher, installer and uninstaller (the uninstaller is also copied to `%LOCALAPPDATA%\gah\`) |
| `deploy.json`, `VERSION` | what the launcher and installer read; package, gah and upstream versions |
| `shortcut.ico` | the shortcut icon, only when the config names one |

### What happens on every launch

`gah.ps1`, started through the stable stub `%LOCALAPPDATA%\gah\gah-launch.ps1`:

0. **Node.** 22 or newer, or offers to install it.
1. **Update.** If the registry holds a higher version with a Windows zip:
   downloads it and its `.sha256`, verifies, unpacks beside the current
   package, runs its installer with `-Update`, and relaunches from it.
   `GAH_NO_UPDATE=1` skips this.
2. **Skills.** If the skills branch head moved: downloads the archive, unpacks
   it to `skills\<sha>`, switches `current.txt`. A failure in step 1 or 2 is
   one line, and the launch goes on; a failed skills update is passed to the
   session, which keeps `/setup-skills` available.
3. **Environment.** Exports `env` from `deploy.json`, defaults
   `GAH_BUILTIN_MODELS` and `GAH_ALLOWED_HOSTS` to empty, points
   `GAH_PROVIDERS_FILE` at the packaged `providers.json`, disables
   `models.json`, and puts `bin\` on `PATH` for `fd` and `rg`.
4. **Preflight.** A route to the model and a working key
   ([above](#first-launch-and-setup)). `GAH_SKIP_PREFLIGHT=1` skips it.
5. **Setup steps.** Runs the skills repository's `setup\NN-*.ps1` ([SKILLS.md](SKILLS.md#setup-steps)).
6. **Start.** `node bundle\cli.js --no-extensions --no-skills [--skill <repo>\skills --prompt-template <repo>\prompts]`.

Steps 1 and 2 run in PowerShell, outside the agent, so the agent's egress
allowlist ([PROVIDERS.md](PROVIDERS.md)) still names only the inference host.
So does `gah_setup`, which calls back into this script
(`--gah-internal status | sync-skills | store | list-certs`). `--help` and
`--version` skip steps 1, 2, 4 and 5.
