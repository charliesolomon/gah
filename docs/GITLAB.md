# GitLab in a package deployment

GitLab is the team forge gah supports today. The per-person packages
([Windows](DEPLOY-WINDOWS.md), [Linux](DEPLOY-LINUX.md)) use it for updates,
the team's skills and in-session setup. The shared Linux host and gah
checkouts use plain git, so they don't need GitLab. Adding another forge is
described in [DEPLOY.md](DEPLOY.md#the-team-forge).

This page says what the team's GitLab holds and how a package moves through
it. This repository stays on GitHub; GitLab holds only what the team's people
touch.

## Two projects

| Project | Holds | Who reads it |
|---|---|---|
| **Deployment project** (e.g. `it/gah-deploy`) | `gah-deploy.json`, any `SYSTEM.md` and icon, a README for people ([template](../templates/deploy/DEPLOY-PROJECT-README.md)), and the **generic package registry** with each version's zips and `.sha256` files | The admin publishes; every launcher checks it for updates |
| **Skills project** (e.g. `it/it-skills`) | The skills repository: `skills/`, `prompts/`, `setup/`, `context/`, `bin/` ([SKILLS.md](SKILLS.md)) | Every launcher fetches the branch head through the repository archive API |

Both are ordinary projects. GitLab builds nothing: there is no mirror of this
repository, no npm registry and no pipeline. (A pipeline that runs the
package build is tracked in [#84](https://github.com/charliesolomon/gah/issues/84).)

## How a package moves

1. **Build** on the admin's machine, from a gah checkout:
   `node scripts/package.mjs --config gah-deploy.json [--platform linux]`.
   Both zips of a version go into one registry package named by `name`:
   `<name>-win11-<version>.zip` and `<name>-linux-<version>.zip`.
2. **Publish** with `scripts/publish-gitlab.mjs`, which uploads the zip and its
   checksum to
   `<gitlab>/api/v4/projects/<deployment project>/packages/generic/<package>/<version>/`.
   It needs a token with `api` scope. Behind mutual TLS, pass the client
   certificate with `--cert`; the upload then goes through curl.
3. **People install once.** From then on the launcher updates itself from the
   registry and fetches the skills on every launch.

## Access

- **Projects visible to the whole organisation** need no token on people's
  machines. Otherwise each person needs a personal access token with
  `read_api`, which the installer or `/setup-skills` asks for.
- **Mutual TLS and proxies:** see
  [DEPLOY-WINDOWS.md](DEPLOY-WINDOWS.md#certificates-and-proxies) and
  [DEPLOY-LINUX.md](DEPLOY-LINUX.md#certificates-and-proxies).
- **The agent never talks to GitLab.** Updates and the skills fetch run in the
  launcher before the agent starts, so the agent's egress allowlist names only
  the inference host.

## Versioning

There are two version numbers, and they move independently:

- **gah's version** is the pi release the build was synced to (`.sync-state`),
  plus the gah commit it was built from. Both are recorded in the package's
  `VERSION` file and `deploy.json`. gah has no release tags of its own; a
  package is built from a commit on `main`.
- **The package version** is `version` in `gah-deploy.json`, and it belongs to
  the team. Raise it for any change: a new gah build, a config change, a new
  icon. Launchers update when the registry holds a higher one. Digits and
  dots, two to four parts, so `1.2.0` follows `1.1.9`.

Raising the package version without a new gah build is normal. A new gah build
without a higher package version reaches nobody.
