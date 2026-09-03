# Deployment config scaffold

Copy `gah-deploy.example.json` into your organisation's **deployment
repository** (private; it names your inference endpoint), fill it in, and keep
it under source control next to any `SYSTEM.md` override. Then, from a GAH
checkout with a completed build:

```bash
node scripts/package-windows.mjs --config /path/to/gah-deploy.json
GAH_GITLAB_TOKEN=... node scripts/publish-gitlab.mjs --config /path/to/gah-deploy.json --zip dist-deploy/gah-<org>-<version>.zip
```

`windows/` holds the launcher and installer the packager ships inside every
package; edit them here, not in a built package. Full reference:
[docs/DEPLOY-WINDOWS.md](../../docs/DEPLOY-WINDOWS.md).
