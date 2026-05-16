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

- `aquasecurity/trivy-action@0.36.0`
- `semgrep==1.95.0` (via pip; requires setuptools preinstalled on Python 3.12+)
- `gitleaks v8.21.2`
- `actions/checkout@v4`, `actions/setup-node@v4`, `actions/setup-python@v5`

Bump deliberately when needed; expect to do so manually every few months (no Renovate).
