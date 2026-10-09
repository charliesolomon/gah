# Patches against vendor/pi

Each `.patch` here changes upstream pi's source. **Patches are the last
resort**: anything an extension in `packages/policy-pack/` can do goes there,
because extensions never conflict with an upstream sync
([WORKFLOW.md](../docs/WORKFLOW.md#the-rule-extension-first-patch-last)).

`vendor/pi` is committed **with every patch applied**. `scripts/apply-patches.sh`
applies them in name order and skips any already present;
`scripts/check-vendor-clean.sh` checks that the tree is exactly upstream plus
these patches.

## The series

| Patch | Why it cannot be an extension |
|---|---|
| `0001-branding` | The executable name, banners and URLs are inside the binary |
| `0002-branded-cli` | `GAH_*` environment names and gah's `--help` page |
| `0003-release-notes-link` | Upstream's startup changelog becomes one line |
| `0010-restrict-model-sources` | The built-in model catalogue is deny-all unless allowlisted |
| `0011-egress-allowlist` | HTTP requests to hosts outside `GAH_ALLOWED_HOSTS` are refused |
| `0012-proxy-env-scheme` | A proxy variable without a scheme is read as `http://` |
| `0013-offline-runtime` | No runtime downloads or startup network calls |
| `0014-no-session-share` | `/share` is off unless the deployment allows it |
| `0015-login-empty-key` | `/login` never saves an empty API key |
| `0020-bake-policy` | Published builds force-load the bundled policy pack |
| `0030-offline-model-data` | The build seeds model data from `packages/policy-pack/model-data/` instead of fetching it |
| `0040-shell-quote-advisory` | A dependency bump for a security advisory |

Each patch's header says more.

## Numbering

`NNNN-short-name.patch`, applied in lexical order.

| Range | For |
|---|---|
| 0001–0009 | Branding and the CLI |
| 0010–0019 | Runtime restrictions and fixes |
| 0020–0029 | Bootstrap: loading the policy pack |
| 0030 and up | Build, data and dependency changes (justify each) |

## Writing a new patch

Four steps, on your feature branch:

1. **Edit** the files under `vendor/pi`. The tree already has the series
   applied, so you start from what users run.
2. **Write the patch** from your change only:
   ```bash
   git add -N vendor/pi/<new files>            # so new files appear in the diff
   git diff --relative=vendor/pi -- vendor/pi > patches/NNNN-short-name.patch
   ```
   Then add a mail-style header (`From:`, `Date:`, `Subject: [PATCH] short-name: …`)
   and a paragraph on why this cannot be an extension. Copy an existing patch's
   header.
3. **Verify:** `./scripts/check-vendor-clean.sh --worktree` (the tree equals
   upstream plus the series, your patch included), `make build`, and a test for
   the behaviour.
4. **Commit** the patch and the `vendor/pi` change together.

`make patch-new NAME=…` and `make patch-export NAME=… NUM=…` do the same with a
scratch branch and `git format-patch`; after `patch-export`, run `make patches`
and commit the result.

## Regenerating an existing patch

When a sync reports that a patch no longer applies, or you need to change one
(say patch N):

1. Reverse-apply the later patches, last first, then N itself:
   `git apply -R --directory=vendor/pi patches/<patch>`.
2. `git add vendor/pi` to stage that base state.
3. Re-apply N (`git apply --directory=vendor/pi patches/<N>`, or `--3way` if
   upstream moved) and make your change.
4. Write N from the unstaged diff, as in [Authoring a patch](#writing-a-new-patch),
   keeping its header.
5. `./scripts/apply-patches.sh` to put the later patches back, then
   `./scripts/check-vendor-clean.sh --worktree`.

Don't hand-edit hunks: a patch is always written from a real diff.

## Rules

- **One concern per patch.**
- **Say why in the header**: what the patch does and why the policy pack cannot.
- **Prefer adding files to changing them.** New files never conflict with
  upstream.
