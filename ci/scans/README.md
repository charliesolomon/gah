# Security scans

Scans run on every PR and nightly. Failures block merges. This directory holds the configs; CI invokes them from `.github/workflows/`.

## Planned scanners

| Scanner | Catches | Config | Status |
|---------|---------|--------|--------|
| `npm audit` | Known dep CVEs | (built-in) | TODO |
| Renovate / Dependabot | Outdated deps | `.github/dependabot.yml` or `renovate.json` | TODO |
| CycloneDX SBOM | Supply-chain transparency | `cyclonedx.json` output as release artifact | TODO |
| CodeQL | Source-level vulns (JS/TS) | `.github/workflows/codeql.yml` | TODO |
| semgrep | Custom rules + OWASP top-10 | `ci/scans/semgrep.yml` | TODO |
| socket.dev (optional) | Malicious package signals | API token in secrets | TODO |

## Triage policy

- **Critical** in `packages/policy-pack/` or `vendor/pi/` runtime path → blocks the next release.
- **High** → fix within 7 days, tracked as a GitHub issue with `security` label.
- **Medium / Low** → tracked but doesn't block.
- **Dev-only deps** → lower priority unless escalated by upstream.

Plug each scanner into `.github/workflows/upstream-sync.yml` so security state is verified on every upstream pull.
