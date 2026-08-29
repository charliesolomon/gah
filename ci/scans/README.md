# Security scans

Scans run on every push and PR via `.github/workflows/ci.yml`. The sync PRs opened by `upstream-sync.yml` go through the same checks automatically.

## What's wired

| Scanner | Catches | Failure threshold |
|---------|---------|--------------------|
| `npm audit --omit=dev` | Known CVEs in runtime npm deps | high/critical |
| Trivy (filesystem) | CVEs in deps + misconfig + secrets in files | critical/high (unfixed ignored) |
| Semgrep (`p/owasp-top-ten`, `p/javascript`, `p/typescript`, `p/secrets`) | SAST findings in our owned source | any finding |
| Gitleaks | Secrets committed in git history (full depth) | any finding |

All scanners use OSS configurations and run without external service accounts, so the workflow ports cleanly to GitLab CI later. No GHAS dependencies.

**Scope:** Semgrep only scans owned code (`packages/`, `scripts/`, `bin/`). `vendor/pi/` is upstream and out of scope for our SAST — we can't fix issues there and we don't want to be alerted about issues that aren't ours. Trivy and npm audit *do* cover `vendor/pi/` because we run them against the installed dependency tree, which we ship.

## Triage policy

- **Critical** in `packages/`, `scripts/`, `bin/`, or in runtime deps of `vendor/pi/` → blocks the next release.
- **High** → fix within 7 days; tracked as a GitHub issue labeled `security`.
- **Medium / low** → tracked but doesn't block.
- **Dev-only deps** → lower priority unless escalated by upstream.

## Tuning

- **npm audit threshold:** change `--audit-level=high` in `ci.yml` to `moderate` for tighter gating.
- **Trivy severity:** change `severity: CRITICAL,HIGH` in `ci.yml`.
- **Semgrep rule packs:** add/remove `--config=p/...` lines in `ci.yml`. The Semgrep registry is at https://semgrep.dev/explore.
- **Gitleaks config:** add `.gitleaks.toml` at repo root to allowlist false positives. Document any allowlist with a comment per entry.

## Deliberately not yet wired

- **CycloneDX SBOM.** No release pipeline yet; revisit when we ship.
- **License compliance scan.** Not relevant until we add owned runtime deps with non-trivial license surface.
- **Dependabot/Renovate.** Skipped per the Option-2 decision — current owned-dep surface is small enough that `npm audit` in CI plus a quarterly hygiene check is sufficient. Revisit if owned deps grow.
- **CodeQL.** Requires GHAS on private repos; skipped to keep CI portable to GitLab.

## Pinned versions

Scanners are pinned to specific versions to avoid silent behavior drift:

- `aquasecurity/trivy-action@v0.36.0`
- `semgrep/semgrep:1.95.0` (Docker image; chosen over pip to avoid setuptools/pkg_resources drift on Python 3.12+)
- `gitleaks v8.21.2`
- `actions/checkout@v4`, `actions/setup-node@v4`

Bump deliberately when needed; expect to do so manually every few months (no Renovate).

## Scan exclusions

Every exclusion is recorded here so it can be reviewed rather than discovered in YAML.

### `vendor/pi/packages/coding-agent/examples/` — Trivy

Upstream ships example extensions with their own nested `package-lock.json`. npm treats
that directory as a workspace and ignores those lockfiles, so nothing in them is ever
installed, built, or shipped in GAH. Trivy scanned them anyway and flagged
`shell-quote` (GHSA-w7jw-789q-3m8p / CVE-2026-9277, critical).

The remediation reached for at the time was to edit the vendored lockfiles by hand
(commits `173d9e23`, `237d8025`). That put changes into `vendor/pi/` that no patch
described — which meant the sync workflow could not restore a pristine tree, and
**every `git subtree pull` from 2026-05-18 onward hit a merge conflict and failed.**
Fifteen consecutive silent failures, caused by a scanner finding on code we do not ship.

So the exclusion is the fix, and the vendored lockfiles have been restored to pristine
upstream content. For reference, upstream v0.84.4 carries `shell-quote` 1.10.0 in the
root lockfile — the real dependency was never vulnerable for long; only the unshipped
example lagged.

**Rule:** never edit `vendor/pi/` to satisfy a scanner. Exclude the path here, with the
reasoning written down. `scripts/check-vendor-clean.sh` enforces this in CI.

## Known accepted findings

`npm audit` currently reports high-severity advisories for `undici` and `ws`, both
reached transitively through upstream dependencies we cannot fix without an `overrides`
block. This has kept `scan-deps` red on `main` since early July 2026.

Also note `npm audit` resolves against the live GitHub advisory database, so a green run
can turn red overnight with no code change — CI is not reproducible in time by
construction. Both points need a deliberate policy decision (accept and document, pin
overrides, or raise the threshold); the v0.84.4 sync may resolve them upstream.
