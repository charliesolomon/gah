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

`gah-<org>-<version>.zip` unpacks to one folder:

| Path | What |
|---|---|
| `bundle/` | upstream's self-contained build; runs on bare Node |
| `dist/…`, `docs/`, `package.json` | the few assets the bundle reads beside itself (themes, HTML export, docs, version) |
| `node_modules/jiti`, `…/photon-node` | the two packages the bundle leaves external |
| `gah-policy/` | the policy pack: `extensions/`, `SYSTEM.md` (your override if given), `providers.json` from the config. Force-loaded by patch 0020; auto-discovery is off. |
| `tools/` | pinned `fd` and `ripgrep` archives plus `SHA256SUMS`; the installer verifies and unpacks them |
| `gah.ps1` | the launcher (below) |
| `Install-Gah.ps1` | the installer (below) |
| `Uninstall-Gah.ps1` | the uninstaller; also copied to `%LOCALAPPDATA%\gah\` so it survives updates |
| `deploy.json`, `VERSION` | what the launcher and installer read; package, gah and upstream versions |

The package is built by `scripts/package-windows.mjs`, which runs the
tool-surface check (`scripts/check-tool-surface.sh`) against the assembled
tree before zipping, so every package is known to offer the model exactly the
policy's tools.

## gah-deploy.json

Lives in **your** deployment repository, not in this one. Start from
[`templates/deploy/gah-deploy.example.json`](../templates/deploy/gah-deploy.example.json).

| Field | Meaning |
|---|---|
| `org` | Organisation name; slugged into the package name |
| `shortcutName` | Desktop shortcut and window title (default `<org> Assistant`) |
| `version` | Package version, semantic; the launcher updates when the registry has a higher one |
| `gitlab.url`, `gitlab.project`, `gitlab.package` | Where packages are published and looked up (generic package registry; `package` defaults to `gah-windows`) |
| `skills.project`, `skills.branch` | The skills repository consumers fetch as an archive on every launch (default branch `main`) |
| `env` | `GAH_*` variables the launcher exports: `GAH_ALLOWED_HOSTS` (the inference host; unset means nothing is reachable), `GAH_BUILTIN_MODELS` (usually empty), `GAH_ALLOW_TOOLS` (usually empty; `powershell` to allow a shell), `GAH_ALLOW_SHARE` |
| `providers` | The contents of `providers.json` ([PROVIDERS.md](PROVIDERS.md)). `apiKey` may be a literal, `"$VAR"` (the installer prompts and stores `VAR` as a user environment variable), or omitted (the consumer runs `/login` once and the key lands in `auth.json`). The endpoint never leaves this file. |
| `systemMd` | Optional path, relative to the config, of a `SYSTEM.md` override |
| `windowsArch` | Default `["x64"]`; add `"arm64"` to ship both tool sets |

## Admin: build and publish

```bash
make build-all                                             # once per gah version
node scripts/package-windows.mjs --config ../deploy/gah-deploy.json
GAH_GITLAB_TOKEN=... node scripts/publish-gitlab.mjs --config ../deploy/gah-deploy.json --zip dist-deploy/gah-<org>-<version>.zip
```

`make package-windows DEPLOY=../deploy/gah-deploy.json` wraps the first script.
The `package-deploy` skill in `skills/` walks through all of it; run this
repository's own `bin/gah` with `GAH_SKILLS_DIR=$PWD/skills` and
`GAH_ALLOW_TOOLS=bash` to use it. Then bump `version` in the config and commit.

Phase 1 builds on the admin's machine. A GitLab CI job that runs the same two
scripts from the mirrored checkout is the intended next step (issue #41).

## Consumer: install

1. Download `gah-<org>-<version>.zip` from the GitLab package registry and unzip it anywhere.
2. In PowerShell, inside the unzipped folder: `.\Install-Gah.ps1`
   - checks Node 22+;
   - copies the package to `%LOCALAPPDATA%\gah\<package>`;
   - verifies the tool archives against the pinned checksums and unpacks `fd.exe`, `rg.exe`;
   - asks for a GitLab token (Enter to skip when the project is visible without one) and stores it as `GAH_GITLAB_TOKEN`;
   - asks for any API key the config collects through an environment variable; names providers that use `/login` instead;
   - writes `current.txt`, creates the desktop shortcut and a `gg` alias in the PowerShell profile.
3. Double-click the shortcut. The first launch fetches the skills repository.

Re-running the installer repairs an installation. `-NoPrompt` skips the
questions (RMM use; keys are then set as user environment variables separately).

`%LOCALAPPDATA%\gah\Uninstall-Gah.ps1` reverses all of it: every installed
package with the skills cache and downloads, the shortcut, the `gg` alias, and
the stored GitLab token and API-key variables (`-KeepSecrets` keeps those). The
agent's own state in `~\.gah` (keys from `/login`, audit log, sessions) stays
unless `-Purge`.

## What happens on every launch

`gah.ps1`, started through the stable stub `%LOCALAPPDATA%\gah\gah-launch.ps1`:

1. **Update.** Asks the registry for the newest `gitlab.package` version. If higher than the installed one: downloads the zip and its `.sha256`, verifies, unpacks beside the current package, runs the new package's installer with `-Update` (tools, `current.txt`), and re-launches from it. Any failure is a warning and the current version runs. `GAH_NO_UPDATE=1` skips the check.
2. **Skills.** Asks the skills repository for the branch head. If it moved: downloads the archive, unpacks to `skills\<sha>`, switches `current.txt`. Any failure keeps the local copy. No skills at all is fatal, as in `bin/gah`.
3. **Environment.** Exports `env` from `deploy.json`, defaults `GAH_BUILTIN_MODELS` and `GAH_ALLOWED_HOSTS` to empty when unset, points `GAH_PROVIDERS_FILE` at the packaged `providers.json`, disables `models.json`, and prepends `bin\` to `PATH` for `fd` and `rg`.
4. **Setup steps.** Runs the repository's `setup\NN-*.ps1`.
5. **Start.** `node bundle\cli.js --no-extensions --no-skills --skill <repo>\skills --prompt-template <repo>\prompts`. The baked `gah-policy\` supplies the policy.

Steps 1 and 2 talk to GitLab from PowerShell, outside the agent process, so the
agent's egress allowlist ([PROVIDERS.md](PROVIDERS.md)) still names only the
inference host. `--help` and `--version` skip steps 1, 2 and 4.

## Relationship to the other deployment shapes

- The **shared Linux host** (`deploy/host/`) uses the same policy pack and the
  same environment variables, with git and a deploy key instead of the archive
  API and a root-owned manifest instead of `deploy.json`.
- A **RHEL9 per-machine package** is planned as phase 2 of #41 and reuses this
  config schema; nothing in it is Windows-specific except `windowsArch`.
- The **GitLab npm package** ([GITLAB.md](GITLAB.md)) is the `npm install -g`
  route for people who already have npm and registry access.
