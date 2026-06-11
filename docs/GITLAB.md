# Distributing gah from enterprise GitLab

GitHub stays the development home (patches, upstream sync, CI scans). The
enterprise GitLab instance is a **distribution endpoint**: it carries a
read-only mirror of this repo and publishes the installable npm package from
`.gitlab-ci.yml`.

The published artifact enforces policy without the `bin/gah` wrapper:
`patches/0020-bake-policy.patch` makes the CLI force-load extensions from
`dist/gah-policy/` (created by `scripts/bundle-policy.sh`) and disables
extension auto-discovery. Dev builds have no `gah-policy/` dir and keep using
the wrapper.

## 1. Set up the mirror

Create an empty project on the GitLab instance (e.g. `<group>/gah`), then
pick one of:

### Option A — GitLab pull mirror (Premium/Ultimate)

Project → **Settings → Repository → Mirroring repositories**:

- Git repository URL: `https://github.com/charliesolomon/gah.git`
- Direction: **Pull**
- Authentication: a GitHub PAT with `repo` read scope (the repo is private)
- Enable **Trigger pipelines for mirror updates** so tags run the publish job

GitLab polls every ~30 minutes; "Update now" forces a sync. Tags are
mirrored, which is what drives releases.

### Option B — push mirror from GitHub Actions (any GitLab tier)

Add a GitLab deploy token (or project access token) with `write_repository`
scope as a GitHub secret (`GITLAB_MIRROR_TOKEN`), then add this workflow on
the GitHub side:

```yaml
# .github/workflows/mirror-gitlab.yml
name: mirror-to-gitlab
on:
  push:
    branches: [main]
    tags: ["v*"]
jobs:
  mirror:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with: { fetch-depth: 0 }
      - run: |
          git push --force \
            "https://gitlab-ci-token:${{ secrets.GITLAB_MIRROR_TOKEN }}@<gitlab-host>/<group>/gah.git" \
            "refs/remotes/origin/main:refs/heads/main" "refs/tags/*:refs/tags/*"
```

Pushed tags trigger the GitLab pipeline automatically — no Premium needed.

Either way: **never commit on the GitLab side.** It's a mirror; changes flow
GitHub → GitLab only.

## 2. The pipeline

`.gitlab-ci.yml` is already in the repo, so the mirror picks it up as-is:

- **build** (default branch + `v*` tags): `npm ci`, build the four
  workspaces, `bundle-policy.sh`, smoke test. Keeps the mirror provably
  releasable.
- **publish** (`v*` tags only): renames the package to
  `@<root-group>/gah`, sets the version from the tag, and publishes
  `vendor/pi/packages/coding-agent` to the **project npm registry** using
  the built-in `CI_JOB_TOKEN` — no secrets to configure.

Two details worth knowing:

- `npm publish --ignore-scripts` is deliberate: upstream's `prepublishOnly`
  runs clean+build, which would wipe `dist/gah-policy` and ship an
  **unpoliced** artifact.
- The npm scope defaults to the GitLab **root group** (`GAH_NPM_SCOPE`
  variable). GitLab's instance-level npm endpoint only resolves packages
  whose scope matches the root namespace; the project-level endpoint works
  with any scope.

## 3. Cut a release

From the GitHub repo (tags flow through the mirror):

```bash
git tag v0.74.0-gah.1   # <upstream-version>-gah.<n>
git push origin v0.74.0-gah.1
```

The suffix keeps our release cadence independent of upstream's: bump `.n`
for policy/patch changes on the same upstream, move the base version on each
upstream sync. (Semver treats `-gah.N` as a prerelease, so pin exact versions
when installing.)

## 4. Install on a user machine

Once per machine (token = a GitLab deploy token with `read_package_registry`):

```bash
npm config set @<root-group>:registry https://<gitlab-host>/api/v4/projects/<project-id>/packages/npm/
npm config set -- //<gitlab-host>/api/v4/projects/<project-id>/packages/npm/:_authToken <token>
npm install -g @<root-group>/gah@0.74.0-gah.1
gah
```

Same commands in PowerShell on Windows (npm is cross-platform; Git for
Windows is still required — see [WINDOWS.md](WINDOWS.md)). No clone, no
build, and the policy pack is baked in — `gah` launches policed with no
wrapper involved.

## Verifying a published artifact

Sanity-check that a release is actually policed:

```bash
npm view @<root-group>/gah --registry https://<gitlab-host>/api/v4/projects/<project-id>/packages/npm/
npx --yes @<root-group>/gah --version
ls "$(npm root -g)/@<root-group>/gah/dist/gah-policy/extensions"   # must list policy.ts, branding.ts
```

If `gah-policy/` is missing from a published package, the release is bad —
yank it and check that the publish job ran `--ignore-scripts`.
