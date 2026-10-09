# Deployment config scaffold

The starting files for a team's **deployment project** on GitLab: the config a
package is built from, and a README for the team's people. The full guide is
[docs/DEPLOY-WINDOWS.md](../../docs/DEPLOY-WINDOWS.md) (Linux differences in
[docs/DEPLOY-LINUX.md](../../docs/DEPLOY-LINUX.md)).

| File | What to do with it |
|---|---|
| `gah-deploy.example.json` | Copy into your deployment project as `gah-deploy.json` and fill it in. Keep the project private: the config names your inference endpoint. |
| `DEPLOY-PROJECT-README.md` | Copy next to the config as the project's README, and replace the `<placeholders>`. |
| `windows/`, `linux/` | The launchers and installers shipped inside every package. Edit them here, never in a built package. |

Then, from a gah checkout with a completed build:

```bash
node scripts/package-windows.mjs --config /path/to/gah-deploy.json
GAH_GITLAB_TOKEN=... node scripts/publish-gitlab.mjs --config /path/to/gah-deploy.json --zip dist-deploy/<name>-win11-<version>.zip
# The Linux package, from the same config, at the same version:
node scripts/package.mjs --config /path/to/gah-deploy.json --platform linux
GAH_GITLAB_TOKEN=... node scripts/publish-gitlab.mjs --config /path/to/gah-deploy.json --zip dist-deploy/<name>-linux-<version>.zip
```
