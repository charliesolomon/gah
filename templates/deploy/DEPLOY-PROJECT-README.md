# <Org> Assistant

<!-- Template for the README of an organisation's deployment project on GitLab.
     Copy next to gah-deploy.json, replace the <placeholders>, and keep the
     troubleshooting table current with what your consumers actually hit. -->

An AI assistant for <Org> staff, run under our policies: it can only use the
skills we publish, only talk to our inference service, and every action it
takes is logged. This project holds the installable package and its
configuration.

## Install (Windows 11)

You need Node.js 22 or newer on the machine (`node --version` in PowerShell).

1. **Download** the latest package: **Deploy -> Package Registry -> gah-windows**,
   pick the newest version, download `gah-<org>-<version>.zip`.
2. **Unzip** it to a folder of your choice, for example:
   ```powershell
   Expand-Archive -LiteralPath ~\Downloads\gah-<org>-<version>.zip -DestinationPath ~\gah-install
   cd ~\gah-install\gah-<org>-<version>
   ```
3. **Install:**
   ```powershell
   .\Install-Gah.ps1
   ```
   It asks for:
   - **GitLab token** - press Enter to skip if the project is visible to you on
     the corporate network; otherwise a personal access token with `read_api`.
   - **Client certificate** (if the deployment requires one) - pick the
     certificate issued to you by <Org>'s PKI, the one with your name as the
     subject. This is how GitLab recognises you.
   - Nothing else. Your API key for the inference service is entered inside the
     assistant on first use, never on the command line.
4. **Start it** from the desktop shortcut **<Org> Assistant**, or open a new
   PowerShell window and type `gg`.

## First steps

- The first start fetches our skills; you will see `gah: skills updated to ...`.
- Type `/login`, choose `<provider>`, paste your API key. Once.
- Try `/rrr` - a one-stanza poem about the folder you are in. It proves the
  assistant can see files and reach the model.
- Type `what can you do?` for the skills available to you, and `/` for commands.
- `gg --help` shows what this installation may use: tools, models, network.

## Day to day

- **Updates are automatic.** Every launch checks for a newer package and for
  changes to the skills, and switches before the assistant starts. If a launch
  prints `update check failed` or `skills update failed`, it continues with what
  it has; tell <admin contact> if it keeps happening.
- **Keys and sessions live in `~\.gah`**; the installed package in
  `%LOCALAPPDATA%\gah`.
- **Uninstall:** `& "$env:LOCALAPPDATA\gah\Uninstall-Gah.ps1"` removes the
  package, shortcut and alias. Add `-Purge` to remove your keys and sessions too.

## If something goes wrong

| Symptom | Likely cause |
|---|---|
| `Node.js 22 or newer is required` | Install Node.js LTS, open a new window, rerun the installer |
| `update check failed` / `skills update failed` at every launch | GitLab not reachable: proxy not set for this window, wrong certificate, or missing token. Check `$env:HTTPS_PROXY`, and `$env:GAH_GITLAB_CERT_THUMBPRINT` against `Get-ChildItem Cert:\CurrentUser\My` |
| `No models available` after `/login` | The key was refused; `/login` again |
| The window closes at once | Start from PowerShell with `gg` to read the message |

## For the admin

`gah-deploy.json` in this repository is the source of truth: organisation name,
GitLab locations, allowed hosts and tools, the inference provider and its
models. It never contains keys or tokens.

To publish a new version, from a checkout of the gah repository with a
completed build:

```powershell
node scripts\package-windows.mjs --config <path>\gah-deploy.json
$env:GAH_GITLAB_TOKEN = '<api-scope token>'
node scripts\publish-gitlab.mjs --config <path>\gah-deploy.json --zip dist-deploy\gah-<org>-<version>.zip --cert "CurrentUser\MY\<thumbprint>"
```

Then bump `version` in `gah-deploy.json` and commit. Consumers pick the new
version up on their next launch. Reference: `docs/DEPLOY-WINDOWS.md` in the
gah repository.
