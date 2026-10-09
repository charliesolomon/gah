---
name: gah-deployments
description: Create, upgrade and republish GAH deployment packages (the Windows and Linux zips consumers install from an organisation's GitLab). Use when the admin says "update the <name> deployment to the latest gah", "upgrade gah-deploy-engineering to 1.0.4", "republish the package", "I changed the deploy config", "create a new gah deployment", "set up gah for another team", or "what version is <deployment> on".
allowed-tools: Read, Grep, Find, Ls, Edit, Write, Bash(node .agents/skills/gah-deployments/scripts/deploy-status.mjs:*), Bash(node scripts/package-windows.mjs:*), Bash(node scripts/package.mjs:*), Bash(node scripts/probe-endpoint.mjs:*), Bash(git:*)
---

# GAH deployments

You are helping the **GAH administrator**, in a session started from this gah
repository, maintain the deployment packages their organisations install. A
deployment is a folder in the organisation's GitLab, cloned on the admin's
machine, holding `gah-deploy.json` and a `README.md`; the package is built from
*this* checkout plus that config, and published to the deployment project's
package registry, where every installed launcher looks for updates.

Reference, in this repo: `docs/DEPLOY-WINDOWS.md` (config schema, what is in
the package, certificates and proxies), `docs/DEPLOY-LINUX.md` (what differs
for the Linux package), `docs/GITLAB.md` (the two GitLab
projects, versioning), `templates/deploy/` (example config, README template).
Read the relevant section rather than guessing a field.

This skill needs a shell tool. On Windows the admin starts gah from the repo
folder with `$env:GAH_ALLOW_TOOLS='powershell'; .\bin\gah.ps1`; on Linux,
`GAH_ALLOW_TOOLS=bash bin/gah`. The first launch asks to trust the project,
because this skill lives in `.agents/skills/`. If no shell tool is available,
say so and give the commands for the admin to run instead.

## Which platforms

One config builds both packages: `<name>-win11-<version>.zip` and
`<name>-linux-<version>.zip`, where `<name>` is the config's `name` (default
`gah-<org>`, slugged; the status prints it). Both go into one registry
package, `gitlab.package` (default `<name>`), under the same version. Ask
which platforms the deployment serves if you cannot tell: the registry's
newest version lists the zips that exist. A config with `gitlab.linuxPackage`
predates this and is refused: remove the key, and tell the admin that every
installed copy reinstalls once from the new package, because installed
launchers look for updates under the old registry package name. Build and publish each one it
serves, at the same version; every step below that names the Windows package
applies to the Linux one with the names above. A deployment that has never had
a Linux package needs nothing in the config to start one; the defaults apply.

The admin's own machine may be Linux. Then the commands below are the same with
`/` paths, `bin/gah` for the launcher, and for the token in step 6:
`read -rs GAH_GITLAB_TOKEN && export GAH_GITLAB_TOKEN`, then `unset
GAH_GITLAB_TOKEN` after publishing. The client certificate for `--cert` is a
PEM path, the one `git config --get-urlmatch http.sslcert <url>` names.

## Always start with the status

```
node .agents/skills/gah-deployments/scripts/deploy-status.mjs --config <deployment folder>/gah-deploy.json --fetch
```

It reports this checkout's gah and pi versions and whether the build is
current, checks the config against the schema, and proposes the next package
version. Show its output. Anything marked ✗ blocks a build; fix those first.
Each ! is worth a sentence to the admin, not a stop.

Ask for the deployment folder if the admin did not name it. A deployment called
`gah-deploy-engineering` is usually a sibling of this repository. Find it by
name, with `find` and the pattern `gah-deploy*/gah-deploy.json` in the parent
folder, rather than listing that folder: on a workstation the parent is often
the admin's home, and a listing of it ends up in every session log they share. Before anything else in that folder,
`git -C <folder> pull --ff-only` so you work from what GitLab holds.

## Flow A: upgrade a deployment to this checkout's gah

For "update gah-deploy-engineering to 1.0.4" and the like.

1. **Status.** Run it, with `--fetch`.
2. **Bring this checkout up to date, outside this session.** If the status
   says behind, stale or missing build, the admin must update the checkout in
   a separate window *with gah closed*: the running session holds files the
   rebuild replaces (on Windows, `npm ci` fails on the locked native modules),
   and it is running the old build anyway. Give them exactly:
   ```powershell
   cd <this repo>
   git pull --ff-only
   cd vendor\pi; npm ci --ignore-scripts; npm run build; cd ..\..
   ```
   `npm run build`, not `build:offline`: only the full build re-seeds the
   model data (docs/WINDOWS.md). Then they relaunch gah here and say
   "continue". Run the status again; continue only when nothing is ✗.
3. **Say what changes for consumers.** The last package records the gah
   commit it was built from, as `gahRev` in its `VERSION` file. Look first in
   this repo's `dist-deploy\<name>-win11-<version>\VERSION` from the last
   build (the admin's build machine often has no installed copy); otherwise,
   where the package is installed, `%LOCALAPPDATA%\gah\current.txt` names the
   package folder. With that commit:
   - `git log --first-parent --format='%cs %s' <gahRev>..HEAD` — summarise in
     a few lines what a consumer will notice, not the plumbing;
   - `git log --oneline <gahRev>..HEAD -- templates/deploy docs/DEPLOY-WINDOWS.md docs/GITLAB.md`
     — anything here may mean a new config field or README section. Compare
     the deployment's README with `templates/deploy/DEPLOY-PROJECT-README.md`
     and offer to carry new sections over; never overwrite the organisation's
     own text.
   If neither file can be found, say so and skip to step 4.
4. **Choose the version.** First establish what is already published,
   because the config alone does not say: older deployments bumped the config
   *after* publishing, so its number may be the one published or the next one.
   Ask the admin to read the newest version on the deployment project's
   *Deploy* → *Package registry* page, then rerun the status with
   `--published <that version>`; its proposal is then relative to what is
   actually out. Propose that version and say why in one line. **Do not
   change `version` until the admin has said yes to a number** — not even as
   part of another edit, such as updating version numbers in the README's
   install instructions. Agree the number first, then make every edit that
   depends on it. The rules the launcher imposes: digits and dots, two to four
   parts, and strictly higher than every version already published; a suffix
   like `1.0.4-1` breaks every consumer's update check. A deployment that has
   mirrored gah's version (`0.87.0`) moves to gah's (`1.0.4`); a rebuild of the
   same gah takes a fourth part (`1.0.4.1`). Change `version` in the config only
   after the admin agrees, and say that you did.
5. **Build.**
   ```
   node scripts/package-windows.mjs --config <folder>/gah-deploy.json
   node scripts/package.mjs --config <folder>/gah-deploy.json --platform linux   # when it serves Linux
   ```
   It assembles the package, runs the tool-surface check against it (Git Bash
   is needed for that on Windows), and writes
   `dist-deploy/<name>-win11-<version>.zip` (or `-linux-`) and `.sha256`. The check
   sets its own tool allowlist, so the shell this session was started with
   does not leak into it. Report the `✓` line:
   path, sha256, gah and upstream versions. If the check fails, stop and show
   it. Never publish an unchecked package unless the admin explicitly asks for
   `--skip-check` and understands it skips the policy check.
6. **Publish: the admin runs this, not you.** The GitLab token must never
   enter this session. Walk them through it:
   - **Token** (once, or when expired): GitLab → avatar → *Edit profile* →
     *Access tokens* → *Add new token*; a name like `gah-publish`, a short
     expiry, scope **api**. A project access token on the deployment project
     with the Developer role and `api` scope works too.
   - **Client certificate**, if the status says mutual TLS: the thumbprint git
     already uses is in `git config --get-regexp "http\..*sslcert"` (safe to
     read; it is not a secret). The spec is `CurrentUser\MY\<thumbprint>`.
   - **The command**, in their own PowerShell window from this repo:
     ```powershell
     $env:GAH_GITLAB_TOKEN = Read-Host -AsSecureString 'GitLab token' | ConvertFrom-SecureString -AsPlainText
     node scripts\publish-gitlab.mjs --config <folder>\gah-deploy.json --zip dist-deploy\<name>-win11-<version>.zip --cert "CurrentUser\MY\<thumbprint>"
     Remove-Item Env:GAH_GITLAB_TOKEN
     ```
     For the Linux package, the same command with
     `--zip dist-deploy\<name>-linux-<version>.zip`; it lands in the same
     registry package and version. Drop `--cert` without mutual TLS. Behind a proxy, the variables in
     docs/DEPLOY-WINDOWS.md "Certificates and proxies" apply. (Windows
     PowerShell 5.1 has no `-AsPlainText`; there, paste the token into
     `$env:GAH_GITLAB_TOKEN = '...'` and clear it afterwards.)
   - **Check it landed:** the deployment project → *Deploy* → *Package
     registry* → `<name>` → the new version, with each platform's `.zip` and
     `.sha256`.
7. **Commit the deployment change.** Show `git -C <folder> diff`, then commit
   with a message naming the gah version, e.g. `Package 1.0.4: gah 1.0.4 (pi
   v1.0.4)`. Push only when the admin says to; if the default branch is
   protected, push a branch and walk them through *Merge requests* → *New*.
8. **Prove the rollout on the admin's own machine.** Close any open session,
   start from the desktop shortcut (on Linux, `gah` in a new terminal): the
   launcher should report the update and relaunch on the new version;
   `gah --version` names it. Installed consumers
   switch on their next launch, with no action. If the admin's own launch did
   not update: the publish went to a different project or package name, or
   the version is not higher; re-read the status and the registry page.

## Flow B: create a new deployment

For "set up gah for another team". Collect everything first, in one message,
offering defaults; then build. Ask only what the status or the admin's git
config cannot tell you.

1. **Ask:**
   - organisation or team name, and the shortcut name (default `<org> Assistant`);
   - GitLab URL, the deployment project path to create (e.g. `tools/gah-deploy-<team>`),
     and the skills project consumers will use (existing, or create one);
   - is GitLab behind mutual TLS (check `git config --get-regexp "http\..*sslcert"`
     first) and a proxy (`$env:HTTPS_PROXY`);
   - the inference endpoint: base URL, and how each consumer gets a key
     (`"$VAR"` collected by the installer, or `/login` on first run);
   - whether consumers may have a shell (`GAH_ALLOW_TOOLS=powershell`; default
     no), and credential files they must never see (`GAH_SECRET_FILES`);
   - optional: an icon (`.ico`), a `SYSTEM.md` override;
   - optional, for onboarding (#135): a proxy to suggest when the inference
     endpoint is not reachable directly (`inferenceProxy`), the deployment's
     own setup skills (`setupSkills`, a folder of skills such as a
     `setup-gitlab` with who issues certificates and internal links), and
     whether to show the /setup-skills line at all (`skillsNudge`).
2. **Probe the endpoint** so the models and tool-call support are facts, not
   guesses: `node scripts/probe-endpoint.mjs <baseUrl> --key-env <VAR>`. The
   key must already be in that environment variable *before* this session
   started; never ask for it in chat. Without it, skip the probe and say the
   model list is unverified. A gateway that refuses tool calls needs
   `"tools": "prompted"` on the provider (docs/PROVIDERS.md).
3. **GitLab, walked through step by step:**
   - **Deployment project:** *New project* → *Create blank project*; the path
     from step 1; visibility **Internal** if every consumer may see it without
     a token, otherwise **Private** (each consumer then needs a `read_api`
     token, which the installer asks for). Untick *Initialize with README*.
   - **Package registry on:** project *Settings* → *General* → *Visibility,
     project features, permissions* → *Package registry* enabled.
   - **Skills project**, if new: create it the same way, then from this repo
     `.\bin\gah.ps1 init <folder>` scaffolds it locally; commit and push it.
     It needs at least one skill, or consumers see the /setup-skills line
     with nothing to fetch.
   - Clone the empty deployment project next to the others.
4. **Scaffold the deployment folder** from the answers:
   `gah-deploy.json` from `templates/deploy/gah-deploy.example.json` (keep its
   `$comment`; fill every field; `GAH_ALLOWED_HOSTS` must cover the endpoint's
   host; `version` either this checkout's gah version or `1.0.0`, say which),
   and `README.md` from `templates/deploy/DEPLOY-PROJECT-README.md` with
   `<Org>`, `<org>`, `<provider>` and `<admin contact>` filled in. Show both
   before writing them.
5. **Status, build, publish, commit**: Flow A from step 1, skipping step 3.
6. **Install it yourself first.** The admin downloads the zip from the package
   registry, unzips it, runs `.\Install-Gah.ps1` (Linux: `bash install.sh`),
   starts the shortcut (Linux: `gah`), runs
   `/rrr` and `what can you do?`. Only then does the README go to the team.

## Flow C: republish after a config change

A changed provider, allowed host, icon or `SYSTEM.md`, same gah build: Flow A
steps 1, 4 (the fourth-part bump), 5, 6, 7, 8. No checkout update needed.

## What not to do

- Never ask for, print, or write a token or API key. Tokens are typed in the
  admin's own window; keys reach consumers through the installer or `/login`.
- Never commit a deployment's config or README into this repository. They name
  an organisation's endpoints and GitLab, and this repository is public and
  organisation-neutral.
- Do not edit `vendor/` or `patches/`; packaging never needs to.
- Do not rebuild this checkout from inside this session (step 2 says why).
- Do not push to GitLab or bump a version without the admin agreeing.
