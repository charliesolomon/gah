# Maintaining gah

This page is for whoever maintains gah itself: keeping the vendored pi current,
writing patches, and changing the policy pack. To deploy gah to a team, start
at [DEPLOY.md](DEPLOY.md) instead.

**You need** bash, git, make, Node 22+ and npm (Linux or macOS). On Windows you
can build and run gah ([WINDOWS.md](WINDOWS.md)), but the sync and patch
targets are bash-only.

## The rule: extension first, patch last

Every change is one of two kinds:

1. **Additive, in `packages/policy-pack/`**: an extension, or `SYSTEM.md`. No
   merge conflicts with upstream, ever. ([policy-pack README](../packages/policy-pack/README.md))
2. **A patch in `patches/`**, which changes upstream pi's source. Only when (1)
   cannot do it. ([patches/README.md](../patches/README.md))

pi's [extension API](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/extensions.md)
can replace tools, gate every tool call, override the system prompt, and add
commands and UI. Check it before writing a patch. Skills and prompt templates
belong to an organisation's skills repository, not here ([SKILLS.md](SKILLS.md)).

## First-time setup

Four commands, the first needing the network:

```bash
make sync-init REF=<tag>   # vendor pi, apply patches, install, build (the current pin is in .sync-state)
make install-tools         # fd + ripgrep for the find/grep tools; gah never downloads them at runtime
make smoke                 # bin/gah runs
make install-hooks         # optional: a pre-push smoke gate
```

A fresh clone also builds without `sync-init`: the vendored tree is committed
with patches applied (README quick start). For a machine without network,
stage the tool archives elsewhere ([SUPPLY-CHAIN.md](SUPPLY-CHAIN.md)).

`make` lists every target. The everyday ones:

| Target | What |
|---|---|
| `make build` | Incremental rebuild of coding-agent (after a patch edit) |
| `make build-all` | Upstream's full build chain |
| `make test-policy` | Policy-pack unit tests |
| `make sync REF=<tag>` | Pull upstream, re-apply patches, rebuild ([below](#upstream-sync-ritual)) |
| `make patches` | Re-apply `patches/` |
| `make clean-vendor` | Discard build residue in `vendor/pi` |

## Keeping `vendor/pi` clean

`vendor/pi` must always equal upstream at the `.sync-state` commit plus the
patch series, and nothing else; every sync depends on it.
`scripts/check-vendor-clean.sh` asserts it in CI. Run it with `--worktree`
before committing anything under `vendor/pi`.

Some upstream commands rewrite tracked files there (`npm run generate:models`,
`make refresh-model-data`). If `git status` shows changes in `vendor/pi` you did
not make, run `./scripts/clean-vendor.sh`.

## Upstream sync ritual

Sync to **release tags**, not upstream `main`. Six steps; the first four are one
command.

1. **Sync, build and smoke:** `make sync REF=<tag>` on a branch. It checks the
   vendor tree is clean, reverse-applies the patch series, pulls the tag with
   `git subtree`, re-applies the patches, runs `npm ci`, `make build-all` and
   `make smoke`, and commits as it goes. It also updates `.sync-state` and the
   README's "pi pinned" badge, which CI checks against each other.
2. **Fix any patch that no longer applies** ([below](#patch-failure-during-sync)).
3. **Check `bake-policy` by fault injection:** temporarily break the policy pack
   (rename `SYSTEM.md`) and confirm the built binary notices. A patch that
   applies is not proof that it still works.
4. **Review** the vendor diff and the CI scan results.
5. **Run `make check-live` on a deployment** before merging, and record the
   result in the PR:
   ```bash
   make check-live ENV=/etc/gah/users.d/<user>.conf
   ```
   This step is not optional. Every CI check is offline, so none sees what a
   provider does with our requests; one sync passed CI and broke every Bedrock
   session on its first turn (#108). `check-live` makes each model the
   deployment is configured for call a tool, under that deployment's own
   allowlists and credentials. It costs cents and never runs in CI.
6. **Merge with a merge commit, never squash.** `git subtree` finds its split
   point in the `Squashed 'vendor/pi/' changes from …` commit message; a squash
   merge erases it and breaks every later sync. Nothing enforces this, so check
   the merge button.

### Patch failure during sync

`apply-patches.sh` lists every patch that did not apply.

1. If the code the patch changed is gone upstream, **delete the patch**.
2. If it moved or changed shape, **regenerate the patch** against the new tree
   ([patches/README.md](../patches/README.md)). Never hand-edit a `.patch`.
3. A patch applied "via 3-way merge" worked, but regenerate it so the next sync
   starts from clean context.

`apply-patches.sh` enables `git rerere`, so a conflict you resolve once is
replayed on later syncs.

### Automation

- **`sync-canary.yml`** runs daily against upstream `main` on a throwaway
  branch, commits nothing, and opens (or comments on) a `sync-canary: …` issue
  naming the step that broke; the next passing run closes it. Patch rot shows
  up within a day. Run it on any ref with
  `gh workflow run sync-canary.yml -f ref=<tag-or-sha>`.
- **`upstream-sync.yml`** opens a sync PR for a chosen ref, on demand only:
  `gh workflow run upstream-sync.yml -f ref=<tag>`. `make sync` locally does
  the same.

## Adding a team forge

gah supports one team forge today, GitLab, and only the per-person deployment
packages depend on it; the shared host and checkouts use plain git
([DEPLOY.md](DEPLOY.md#the-team-forge)). A new forge for packages touches:

| Where | What is forge-specific |
|---|---|
| `templates/deploy/windows/gah.ps1`, `templates/deploy/linux/gah.sh` | The update check and download (GitLab's generic package registry), the skills fetch (repository archive API), and the `--gah-internal status / sync-skills / store / list-certs` operations `gah_setup` calls |
| `templates/deploy/windows/Install-Gah.ps1`, `templates/deploy/linux/install.sh`, the uninstallers | Asking for and storing the GitLab token and client certificate (`GAH_GITLAB_*`), and removing them |
| `scripts/package.mjs`, `templates/deploy/gah-deploy.example.json` | The `gitlab` section of `gah-deploy.json`, its validation, and what goes into `deploy.json` |
| `scripts/publish-gitlab.mjs` | Uploading a built package |
| `packages/policy-pack/extensions/onboarding.ts` | `gah_setup`'s token and certificate dialogs and the names it may store |
| `packages/policy-pack/setup-skills/setup-gitlab/` | The built-in setup skill a person follows to get access; a new forge ships its own |
| `.agents/skills/gah-deployments/` | The admin skill and `deploy-status.mjs`, which validate the config and walk through GitLab's UI |
| `templates/kb-repo/bin/_kb-common.sh`, `_kb-url.ps1` | Web links to knowledge base articles (`KB_WEB_STYLE`: `github` or `gitlab`) |
| `scripts/check-onboarding.sh` and the docs | Tests and the deployment docs ([GITLAB.md](GITLAB.md), [DEPLOY-WINDOWS.md](DEPLOY-WINDOWS.md), [DEPLOY-LINUX.md](DEPLOY-LINUX.md)) |

The hardest part is updates: a forge without a package registry needs another
place to publish zips. Skills are a git archive or clone on any forge.

## Branding

User-visible text outside the binary (system prompt, banners, footer) lives in
the policy pack. Anything inside the binary (the executable name, embedded
URLs) is a patch, by convention `0001-branding.patch`.

**The help page.** `--help` is gah's own page, `cli/gah-help.ts` from
`0002-branded-cli.patch`. It reports the session's effective policy (tools from
`GAH_EFFECTIVE_TOOLS`, models, hosts, skills) and lists only the options and
`GAH_*` variables that matter under policy; `--help --verbose` prints
upstream's full reference. Keep it short: if upstream adds a flag gah users
need, add one `row()`. The "This session" rows come from `gahSessionRows()`,
which the patch exports from the package index so that `/help`
(`extensions/help.ts`) shows the same rows in a session. On the shared host
the page is only those rows, since nobody there can pass an option.
`scripts/check-help.sh` checks that the two agree.

**Environment variable names.** Upstream reads some settings from fixed `PI_*`
names. `0002-branded-cli.patch` mirrors each `GAH_<NAME>` onto `PI_<NAME>` at
startup (`core/gah-env.ts`), so both spellings work and `PI_*` wins when both
are set. Names exported to child processes (`PI_CODING_AGENT`, `PI_SESSION_ID`,
`PI_MODEL`, …) keep upstream's spelling, so skill scripts written against
upstream docs still work. When upstream adds an inbound name, add it to
`gah-env.ts`.

## Sharing a session for troubleshooting

A session file (`~/.gah/agent/sessions/<cwd>/<id>.jsonl`) is the best evidence
for "the agent did something odd", and also a map of the machine it ran on.
`scrub-session.mjs` writes a copy with identifiers replaced and the structure
intact:

```bash
make scrub-session FILE=~/.gah/agent/sessions/<cwd>/<id>.jsonl ARGS="--drop-tool-results"
# → <id>.scrubbed.jsonl   share this
# → <id>.scrub-map.json   placeholder → original, mode 0600; never share
```

- It replaces what it learns from this machine (home, user and host names,
  proxies, providers, a `--deploy` config) with stable placeholders such as
  `<host-2>`, and catches the rest with generic patterns (paths, URLs, private
  hostnames, e-mail and IP addresses, certificates, tokens, people in API
  replies). The script's header lists every option.
- `--drop-tool-results` replaces tool output with its length and a hash: the
  call sequence and error text survive, file contents do not. Usually the
  right choice for a bug report.
- The output is leak-checked, and the script exits 1 if anything survived. It
  cannot know meaning (a site, a person, a product named in prose): put those
  in a file for `--words`, and read the output once before sending it.

## Vulnerability handling

`ci/scans/` runs SBOM, dependency CVE and source scans on every PR and nightly;
its README has the failure policy. To silence a finding in `vendor/pi`, exclude
the path in `ci.yml` with a written justification; never edit `vendor/pi` to
satisfy a scanner.

## Anti-patterns

- **Committing edits to `vendor/pi` outside a patch.** Reverse-applying the
  series cannot undo a change no patch describes, so the next sync stops on a
  merge conflict. This once cost 15 failed syncs in a row.
  `check-vendor-clean.sh` now catches it in CI.
- **Squash-merging a sync PR** ([step 6](#upstream-sync-ritual)).
- **Syncing upstream `main`** instead of a release tag.
- **Many small patches** where one extension would do.
- **New dependencies in `packages/policy-pack/`** without need: each one widens
  the CVE surface we own.
