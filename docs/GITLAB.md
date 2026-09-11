# GitLab's role in a deployment

GitHub stays the development home: patches, upstream syncs, CI scans, and the
organisation-neutral code. An organisation's GitLab holds what its consumers
touch, and nothing else. There is **no mirror of this repository on GitLab, no
npm publish, and no GitLab pipeline**; an earlier design had all three, and
this page replaces it.

## Two projects, and what each holds

| Project | Holds | Who reads it |
|---|---|---|
| **Deployment project** (e.g. `it/gah-deploy`) | The organisation's `gah-deploy.json`, its `SYSTEM.md` and icon if any, a README for consumers, and the **generic package registry** where each package version's zip and `.sha256` are published | The admin publishes; the packaged launcher checks it for updates at every start |
| **Skills project** (e.g. `it/it-skills`) | The skills repository: `skills/`, `prompts/`, `setup/`, `context/`, `bin/` | The launcher fetches the branch head through the repository archive API at every start |

Both are ordinary GitLab projects. Nothing in them is built by GitLab.

## The flow

1. **Build on the admin's machine.** From a checkout of this repository on any
   OS with Node: `node scripts/package-windows.mjs --config gah-deploy.json`
   assembles the zip, runs the tool-surface check against a mock endpoint, and
   writes the checksum ([DEPLOY-WINDOWS.md](DEPLOY-WINDOWS.md)).
2. **Publish to the deployment project.** `scripts/publish-gitlab.mjs` uploads
   the zip and its checksum to
   `<gitlab>/api/v4/projects/<deployment project>/packages/generic/<package>/<version>/`.
   It needs a token with `api` scope on that project. Behind mutual TLS, pass
   the client certificate with `--cert` and the upload goes through curl.
3. **Consumers install once** from the zip and the deployment project's README
   ([the template](../templates/deploy/DEPLOY-PROJECT-README.md)). From then on
   the launcher self-updates from the registry and re-syncs skills from the
   skills project on every launch.

## Access

- **Public-to-the-organisation projects** need no token on the consumer side.
  Otherwise each consumer needs a personal access token with `read_api`,
  which the installer asks for and stores as a user environment variable.
- **Mutual TLS** in front of GitLab: the installer offers the consumer's
  certificates, ranked by what git already uses for that host; the launcher
  presents the chosen one. **Proxies** come from the machine's environment
  unless the config says otherwise. Details in
  [DEPLOY-WINDOWS.md](DEPLOY-WINDOWS.md#certificates-and-proxies).
- The agent process itself never talks to GitLab. Updates and skills sync run
  in the launcher before the agent starts, so the agent's egress allowlist
  still names only the inference host.

## Versioning

Two version numbers, deliberately independent:

- **gah's version** is upstream's, `0.85.1` for a build from the v0.85.1 sync,
  plus the gah commit it was built from. Both are recorded in the package's
  `VERSION` file and in `deploy.json`. This repository does not cut release
  tags of its own; a package is built from a commit on `main`.
- **The package version** is `version` in `gah-deploy.json` and is the
  organisation's: it moves when the organisation changes anything in its
  package, a new gah build, a config change, a new icon. The launcher updates
  a consumer when the registry holds a higher one. Semantic versioning, so
  `1.2.0` follows `1.1.9`.

Bumping the package version without a new gah build is normal; shipping a new
gah build without bumping the package version means nobody updates.

## What the old design needed and this one does not

- A GitLab mirror of this repository: only a GitLab pipeline needed the source
  there. Deleted along with `.gitlab-ci.yml`.
- The project npm registry and `npm install -g` on consumer machines: consumers
  needed npm and registry access, and got a bare CLI with no providers, no
  allowlist environment, no skills sync, no `fd`/`ripgrep`, and no updates.
  The zip carries all of that.
- Git for Windows on consumer machines: Node is the only prerequisite. Git
  Bash matters only when a deployment grants the `bash` tool.

If a deployment wants GitLab to run the package build, that is a pipeline in
the **deployment project**, running the two steps above with a checkout of
this repository as a build input; it still needs no mirror. A template for
that pipeline is [#84](https://github.com/charliesolomon/gah/issues/84).
