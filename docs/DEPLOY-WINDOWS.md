# Deploying GAH to Windows consumers

A GAH **admin** turns a built checkout plus an organisation config into one zip.
A **consumer** downloads it, runs the installer, and gets a desktop shortcut.
From then on the launcher keeps both the package and the skills current on
every start. No git, no npm, no clone on the consumer machine: only Node 22+.

```
admin machine                      corporate GitLab                 consumer (Win11)
gah checkout + gah-deploy.json ──► package registry ◄──── Install-Gah.ps1, then gah.ps1 on every launch
                                   skills repository ◄──── archive of <branch> when its head moved
```

## What is in the package

`<name>-win11-<version>.zip` unpacks to one folder:

| Path | What |
|---|---|
| `bundle/` | upstream's self-contained build; runs on bare Node |
| `dist/…`, `docs/`, `package.json` | the few assets the bundle reads beside itself (themes, HTML export, docs, version) |
| `node_modules/jiti`, `…/photon-node`, `…/@earendil-works/chord` | the packages the bundle leaves external (the packager checks this list against upstream's bundle script) |
| `node_modules/esbuild` | a generated stub, not esbuild. Upstream's experimental plugin bundler imports esbuild at startup; GAH never runs it, so the stub satisfies the import and throws a clear error if that path is ever reached, instead of shipping an 11 MB native binary. |
| `gah-policy/` | the policy pack: `extensions/`, `SYSTEM.md` (your override if given), `providers.json` from the config. Force-loaded by patch 0020; auto-discovery is off. |
| `gah-policy/setup-skills/`, `gah-policy/deploy-setup-skills/` | the built-in setup skills behind `/setup-skills`, and the deployment's own when the config names them (`setupSkills`) |
| `preflight.mjs` | run before every session: finds the route to the model (proxy) and makes sure a key works |
| `tools/` | pinned `fd` and `ripgrep` archives plus `SHA256SUMS`; the installer verifies and unpacks them |
| `gah.ps1` | the launcher (below) |
| `Install-Gah.ps1` | the installer (below) |
| `Uninstall-Gah.ps1` | the uninstaller; also copied to `%LOCALAPPDATA%\gah\` so it survives updates |
| `deploy.json`, `VERSION` | what the launcher and installer read; package, gah and upstream versions |
| `shortcut.ico` | the shortcut icon, only when the config names one |

The package is built by `scripts/package-windows.mjs` (`scripts/package.mjs`
with the platform fixed to Windows), which runs the
tool-surface check (`scripts/check-tool-surface.sh`) against the assembled
tree before zipping, so every package is known to offer the model exactly the
policy's tools.

## gah-deploy.json

Lives in **your** deployment repository, not in this one. Start from
[`templates/deploy/gah-deploy.example.json`](../templates/deploy/gah-deploy.example.json).

| Field | Meaning |
|---|---|
| `org` | Organisation name |
| `name` | Optional base name of the registry package and the zips, lower-case letters, digits, `.`, `_` and `-` (e.g. `gah-orgname-engineering`). Default `gah-<org>`, slugged. Builds are `<name>-win11-<version>.zip` and `<name>-linux-<version>.zip`. Changing `name` or `gitlab.package` later strands installed copies, which keep looking under the old registry package: each reinstalls once from the new one. |
| `shortcutName` | Desktop shortcut and window title (default `<org> Assistant`) |
| `version` | Package version, semantic; the launcher updates when the registry has a higher one |
| `gitlab.url`, `gitlab.project`, `gitlab.package` | Where packages are published and looked up (generic package registry). `package` defaults to `name`; the Windows and Linux zips of a version share it, and each launcher updates to the highest version that holds its own platform's zip |
| `gitlab.clientCert` | `"user"` when GitLab sits behind a mutual-TLS front-end: the installer lets the consumer pick a certificate from their Windows store and the launcher presents it on every GitLab call. `null` otherwise. |
| `gitlab.clientCertIssuer` | Optional substring of the issuing CA's name (e.g. `"Org Issuing CA"`); the installer lists certificates from that CA first. Independently of this, a certificate git already uses for this GitLab is listed first and marked. |
| `gitlab.proxy` | `null` (default): the consumer machine's `HTTPS_PROXY` / `HTTP_PROXY`, honouring `NO_PROXY`, falling back to the Windows proxy settings, so sites with different proxies need no per-site package. A URL forces that proxy; `"none"` forces a direct connection. |
| `skills.project`, `skills.branch` | The skills repository consumers fetch as an archive on every launch (default branch `main`) |
| `env` | `GAH_*` variables the launcher exports: `GAH_ALLOWED_HOSTS` (the inference host; unset means nothing is reachable), `GAH_BUILTIN_MODELS` (usually empty), `GAH_ALLOW_TOOLS` (usually empty; `powershell` to allow a shell), `GAH_SECRET_FILES` (credentials files the model may never see, `;`-separated globs, e.g. `%USERPROFILE%\\*.env`), `GAH_ALLOW_SHARE` |
| `providers` | The contents of `providers.json` ([PROVIDERS.md](PROVIDERS.md)). `apiKey` may be a literal, `"$VAR"` (the installer prompts and stores `VAR` as a user environment variable), or omitted (the consumer runs `/login` once and the key lands in `auth.json`). `"tools": "prompted"` on a provider whose gateway refuses native tool calls ([PROVIDERS.md](PROVIDERS.md#gateways-that-refuse-tool-calls-tools-prompted)). The endpoint never leaves this file. |
| `systemMd` | Optional path, relative to the config, of a `SYSTEM.md` override |
| `icon` | Optional path, relative to the config, of a `.ico` for the desktop shortcut (16/32/48/256 sizes). Carried as `shortcut.ico`; the installer keeps it at `%LOCALAPPDATA%\gah\shortcut.ico` across updates. Absent = the stock terminal icon |
| `windowsArch` | Default `["x64"]`; add `"arm64"` to ship both tool sets |
| `inferenceProxy` | Optional proxy URL that the launcher offers when the inference endpoint is not reachable directly, after the machine's own `HTTPS_PROXY` and system proxy ([first launch](#first-launch-and-setup)). `null` = none. |
| `setupSkills` | Optional folder, relative to the config, of the deployment's own setup skills: one folder per skill with a `SKILL.md`. A skill with the same name as a built-in one (`setup-skills`, `setup-gitlab`) replaces it. The packager refuses one that looks like it holds a credential, because the zip is downloadable by anyone in the organisation. |
| `skillsNudge` | Default `true`. `false` hides the /setup-skills line, for a deployment that never uses shared skills. |
| `linuxArch` | The Linux package's tool architectures (default `["x64"]`); see [DEPLOY-LINUX.md](DEPLOY-LINUX.md) |

## Admin: build and publish

```bash
make build-all                                             # once per gah version
node scripts/package-windows.mjs --config ../deploy/gah-deploy.json
GAH_GITLAB_TOKEN=... node scripts/publish-gitlab.mjs --config ../deploy/gah-deploy.json --zip dist-deploy/<name>-win11-<version>.zip
```

`make package-windows DEPLOY=../deploy/gah-deploy.json` wraps the first script.
The `gah-deployments` project skill (`.agents/skills/`) walks through all of
it: upgrading an existing deployment to this checkout's gah, creating a new
deployment project, and republishing after a config change, including the
steps in GitLab. Start this repository's own launcher from the repository
folder with a shell allowed (`$env:GAH_ALLOW_TOOLS='powershell'; .\bin\gah.ps1`
on Windows, `GAH_ALLOW_TOOLS=bash bin/gah` elsewhere), trust the project when
asked, and say what you want, e.g. "upgrade gah-deploy-engineering to the
latest gah".

**Version first, then build.** Set `version` in the config to the new number
*before* packaging (the zip is named from it), publish, then commit the
config: the committed config then always names the version that is
published. The launcher compares versions as PowerShell `[version]`: digits
and dots, two to four parts, so `1.0.4.1` is a valid rebuild of `1.0.4` and
`1.0.4-1` would break every consumer's update check.

Phase 1 builds on the admin's machine. A GitLab CI job in the deployment
project that runs the same two scripts with a checkout of this repository as a
build input is [#84](https://github.com/charliesolomon/gah/issues/84); there is
no mirror ([GITLAB.md](GITLAB.md)).

### Certificates and proxies

The admin scripts are Node: behind a corporate proxy set `NODE_OPTIONS=--use-system-ca --use-env-proxy` and `HTTPS_PROXY` as for the build ([WINDOWS.md](WINDOWS.md)); if GitLab presents a certificate from an internal CA that is not in the Windows store, point Node at the PEM git uses (`git config --get http.sslCAInfo`) with `NODE_EXTRA_CA_CERTS`. If GitLab is inside the network, exclude it with `NO_PROXY=<gitlab-host>`. The publish script's `curl` fallback honours the same variables.

The consumer launcher and installer talk to GitLab from PowerShell, which uses the Windows certificate store and system proxy: the prerequisite on a consumer machine is that the corporate CA is in that store, which managed machines normally have.

**Mutual TLS.** Some corporate GitLab instances sit behind a front-end that requires a client certificate (the sign that git needs `http.<url>.sslCert` to reach it). Set `gitlab.clientCert` to `"user"`: the installer lists the consumer's certificates that have a private key, they pick one, and its thumbprint is stored as `GAH_GITLAB_CERT_THUMBPRINT`; the launcher passes it with `-CertificateThumbprint`. For publishing, give the admin script the same certificate in curl's syntax — on Windows the store reference git uses, `--cert "CurrentUser\MY\<thumbprint>"` (or `GAH_GITLAB_CLIENT_CERT`); uploads then go through `curl.exe`, which uses schannel exactly as git does. The launcher reaches GitLab through whatever proxy the consumer machine's environment names, so a GitLab that is reachable only through the proxy needs no extra config as long as `HTTPS_PROXY` is set there.

## Consumer: install

1. Download `<name>-win11-<version>.zip` from the GitLab package registry and unzip it anywhere.
2. In PowerShell, inside the unzipped folder: `.\Install-Gah.ps1`
   - checks Node 22+;
   - copies the package to `%LOCALAPPDATA%\gah\<package>`;
   - verifies the tool archives against the pinned checksums and unpacks `fd.exe`, `rg.exe`;
   - asks for a GitLab token (Enter to skip: the project may be visible without one, or the person can set it up later from inside gah with `/setup-skills`) and stores it as `GAH_GITLAB_TOKEN`;
   - asks for any API key the config collects through an environment variable; names providers that use `/login` instead;
   - writes `current.txt`, creates the desktop shortcut and a `gah` command in the PowerShell profile. A `gah` the profile already defines, such as an admin's wrapper for a gah checkout, is left alone with a warning.
3. Double-click the shortcut. The first launch fetches the skills repository when GitLab access works, and starts anyway when it does not.

Older packages named the command `gg`. The first automatic update to a package
with this installer replaces that profile line with `gah`, and says so; the
change shows in new PowerShell windows.

Re-running the installer repairs an installation. `-NoPrompt` skips the
questions (RMM use; keys are then set as user environment variables separately).

`%LOCALAPPDATA%\gah\Uninstall-Gah.ps1` reverses all of it: every installed
package with the skills cache and downloads, the shortcut, the `gah` command, and
the stored GitLab token and API-key variables (`-KeepSecrets` keeps those). The
agent's own state in `~\.gah` (keys from `/login`, audit log, sessions) stays
unless `-Purge`.

## First launch and setup

gah is built around the organisation's skills, but none of the setup beyond
Node and a working API key is required to start a session ([#135](https://github.com/charliesolomon/gah/issues/135)).
The harder steps, GitLab access in particular, are finished from inside the
session, where gah can help.

**Before the session**, the launcher makes sure of three things, and helps
with each:

| Needed | When it is missing |
|---|---|
| **Node 22+** | Offers to install Node.js LTS with `winget`, or says where to get it. |
| **A route to the model** | `preflight.mjs` tries a direct connection, then `HTTPS_PROXY`, then the Windows system proxy (from the system settings, including an automatic configuration script), then the config's `inferenceProxy`, and finally asks. The route that worked is remembered and tried first next time. A proxy that asks for a login stops with a clear message; gah does not support those. |
| **A working API key** | Checked against the provider's model list, never with a chat request, because some gateways bill per message. An endpoint without a model list is accepted unchecked. When no provider has a key that works, the person is asked for one, masked, until one works or they give up. It is stored as the user environment variable the config names, or where `/login` keeps it. |

Node does not use the Windows proxy settings by itself. The launcher exports
the route preflight found as `HTTPS_PROXY` with `NODE_USE_ENV_PROXY=1`, which
needs Node 22.21 or newer.

**In the session**, while no shared skills are loaded, one line above the
input box says *gah is better with your team's skills. Type /setup-skills to
set them up.*, and the model is told the session has none, so it still helps
with ordinary work. `/setup-skills` runs the `setup-skills` skill, which uses
the `gah_setup` tool to find out what is missing and does only the next step:

- **GitLab works already**, for example a public skills project: fetch the
  skills and reload them into the same session.
- **GitLab needs access**: the `setup-gitlab` skill. A client certificate first
  when the front end wants one (the person picks it from their certificate
  store), then a `read_api` token, typed into a masked dialog the tool opens.
  The model never sees the token; the tool stores it as `GAH_GITLAB_TOKEN` and
  reports only whether GitLab now accepts it.
- **Something only a person can fix** (no access to the project, no
  certificate, no network): say what, and stop.

A deployment can replace `setup-gitlab`, or any setup skill, with its own
(`setupSkills`), for what only its people know: who issues certificates,
internal help links.

**Updates do not need any of this** when the deployment project is public: the
update check goes anonymously, and falls back to anonymous when a stored token
is refused.

## What happens on every launch

`gah.ps1`, started through the stable stub `%LOCALAPPDATA%\gah\gah-launch.ps1`:

0. **Node.** Present and 22 or newer, or offers to install it.
1. **Update.** Asks the registry for the newest `gitlab.package` version. If higher than the installed one: downloads the zip and its `.sha256`, verifies, unpacks beside the current package, runs the new package's installer with `-Update` (tools, `current.txt`), and re-launches from it. `GAH_NO_UPDATE=1` skips the check.
2. **Skills.** Asks the skills repository for the branch head. If it moved: downloads the archive, unpacks to `skills\<sha>`, switches `current.txt`. Without any, the session starts without shared skills.
   A GitLab failure in either step is one line, naming the first reason, and the launch goes on.
3. **Environment.** Exports `env` from `deploy.json`, defaults `GAH_BUILTIN_MODELS` and `GAH_ALLOWED_HOSTS` to empty when unset, points `GAH_PROVIDERS_FILE` at the packaged `providers.json`, disables `models.json`, and prepends `bin\` to `PATH` for `fd` and `rg`.
4. **Preflight.** `preflight.mjs`, as above: a route to the model and a working key. `GAH_SKIP_PREFLIGHT=1` skips it.
5. **Setup steps.** Runs the repository's `setup\NN-*.ps1`.
6. **Start.** `node bundle\cli.js --no-extensions --no-skills [--skill <repo>\skills --prompt-template <repo>\prompts]`. The baked `gah-policy\` supplies the policy and the setup skills.

Steps 1 and 2 talk to GitLab from PowerShell, outside the agent process, so the
agent's egress allowlist ([PROVIDERS.md](PROVIDERS.md)) still names only the
inference host. So does `gah_setup`, which calls back into this script
(`--gah-internal status | sync-skills | store | list-certs`). `--help` and
`--version` skip steps 1, 2, 4 and 5.

## Relationship to the other deployment shapes

- The **shared Linux host** (`deploy/host/`) uses the same policy pack and the
  same environment variables, with git and a deploy key instead of the archive
  API and a root-owned manifest instead of `deploy.json`.
- The **Linux per-machine package** (RHEL 9) is built from this same config
  with `scripts/package.mjs --platform linux` and published into the same
  registry package and version as the Windows zip. [DEPLOY-LINUX.md](DEPLOY-LINUX.md)
  covers what differs.
- [GITLAB.md](GITLAB.md) describes what the organisation's GitLab holds for
  this package (deployment project, skills project) and why no mirror,
  npm registry or GitLab pipeline is involved.
