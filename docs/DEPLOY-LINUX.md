# Deploying gah as a Linux package (RHEL 9)

The Linux package is the Windows package for people who work on their own
Linux machine: one zip, an installer, and a launcher that keeps the package
and the team's skills current. It is built from the same `gah-deploy.json`
and published to the same GitLab registry package and version.

This page covers only what differs. Read [DEPLOY-WINDOWS.md](DEPLOY-WINDOWS.md)
first: it has the steps, the config reference and first-launch setup. For
many people on one shared machine, use the shared Linux host instead
([DEPLOY.md](DEPLOY.md#choose-a-shape)).

Built and tested on RHEL 9. Any Linux with bash, Node 22+ and curl should
work; nothing is RHEL-specific except the CA bundle path and the `dnf` hint.

## What differs from Windows

| | Windows | Linux |
|---|---|---|
| Build | `scripts/package-windows.mjs` | `scripts/package.mjs --platform linux` |
| Zip | `<name>-win11-<version>.zip` | `<name>-linux-<version>.zip` |
| Tool architectures | `windowsArch` | `linuxArch`, default `["x64"]`; add `"arm64"` for both |
| Scripts | `gah.ps1`, `Install-Gah.ps1`, `Uninstall-Gah.ps1` | `gah.sh`, `install.sh`, `uninstall.sh` |
| Installed to | `%LOCALAPPDATA%\gah\<package>` | `~/.local/share/gah/<package>` |
| Token and API keys | user environment variables | `~/.config/gah/secrets.env`, mode 0600 |
| Client certificate | a thumbprint from the Windows store | a PEM certificate and key, as git's `http.sslCert` / `http.sslKey` |
| Start | desktop shortcut, `gah` in the PowerShell profile | applications-menu entry, `gah` in `~/.local/bin` |
| Setup steps | `setup/NN-*.ps1` | `setup/NN-*.sh` |
| Shortcut icon | `icon` from the config | the desktop's stock terminal icon |

## Build and publish

```bash
make build-all                                             # once per gah version
node scripts/package.mjs --config ../deploy/gah-deploy.json --platform linux
GAH_GITLAB_TOKEN=... node scripts/publish-gitlab.mjs --config ../deploy/gah-deploy.json --zip dist-deploy/<name>-linux-<version>.zip
```

- The zip goes next to the Windows zip of the same version. You can publish
  one platform without the other: each launcher updates to the highest
  version that holds its own platform's zip.
- Version rules are the same as Windows; the Linux launcher compares versions
  exactly as PowerShell does.
- The build works on any machine, Windows included; the tool-surface check
  needs bash.

## Install

**Two steps**, after Node 22:

```bash
sudo dnf module enable nodejs:22 && sudo dnf install nodejs   # Node 22 LTS from AppStream
```

`curl`, `tar`, `sha256sum` and `python3` are in every RHEL 9 install.

1. Download `<name>-linux-<version>.zip` from the deployment project's package
   registry (*Deploy* → *Package registry* → `<name>`), then:
   ```bash
   unzip <name>-linux-<version>.zip          # or: python3 -m zipfile -e <name>-linux-<version>.zip .
   bash <name>-linux-<version>/install.sh
   ```
   The installer:
   - checks Node 22+, curl, tar and sha256sum, and copies the package to
     `~/.local/share/gah/<package>`;
   - verifies and unpacks the pinned `fd` and `rg`;
   - asks for a GitLab token (Enter skips it), and for the client certificate
     and key when `gitlab.clientCert` is `"user"`, offering what git already
     uses for this GitLab;
   - asks for any API key the config collects through an environment variable;
   - stores the answers in `~/.config/gah/secrets.env` (directory 0700, file 0600);
   - puts `gah` in `~/.local/bin` (an existing `gah` is left alone, with a
     warning), adding that directory to `PATH` in `~/.bashrc` if needed;
   - adds an applications-menu entry (`--no-desktop` skips it).
2. Open a new terminal and type `gah`.

Re-running the installer repairs an installation. `--no-prompt` asks nothing:
a `GAH_GITLAB_TOKEN` or API-key variable already in the environment is
stored, and anything missing is named.

To uninstall, run `~/.local/share/gah/uninstall.sh`. It removes the packages,
the skills cache, the menu entry, `gah`, the `PATH` line it added and
`secrets.env` (`--keep-secrets` keeps that). The agent's state in `~/.gah`
stays unless `--purge`.

## Certificates and proxies

**GitLab calls** (update check, skills) go through `curl`, which uses the
system trust store in `/etc/pki`. If the corporate CA is missing there:
`sudo cp <ca>.pem /etc/pki/ca-trust/source/anchors/ && sudo update-ca-trust`.
`gitlab.proxy` works as on Windows: `null` leaves it to curl's
`HTTPS_PROXY` / `https_proxy` and `NO_PROXY`; a URL forces that proxy; `"none"`
forces a direct connection.

**Mutual TLS.** curl presents the PEM certificate and key named by
`GAH_GITLAB_CLIENT_CERT` and `GAH_GITLAB_CLIENT_KEY` in `secrets.env`. The key
must have no passphrase, because curl runs without a terminal prompt. Git
uses the same files: `git config --get-urlmatch http.sslcert <gitlab-url>`
names them. In the session, `/setup-skills` asks for the paths in a dialog.

**The agent's own calls** come from Node, which has its own CA list. The
launcher points `NODE_EXTRA_CA_CERTS` at the system bundle when it is unset.
The route to the model is found by preflight, as on Windows, minus the system
proxy (Linux has none to read): last time, direct, `HTTPS_PROXY`, the config's
`inferenceProxy`, then the person.

## How it works

`gah.sh`, started through `~/.local/share/gah/gah-launch`, runs the
[same steps as gah.ps1](DEPLOY-WINDOWS.md#what-happens-on-every-launch), in the
same order. The differences:

- **Node:** when it is missing, offers to install it with `sudo dnf`, or says how.
- **Skills** arrive as `archive.tar.gz`. Updates are unpacked with `unzip`
  when present, or python3's `zipfile` otherwise.
- **Environment:** besides the Windows variables, the launcher
  - loads `secrets.env` values that are not already set;
  - adds `secrets.env` itself to `GAH_SECRET_FILES`, so the policy refuses to
    read it and redacts its values from tool results ([PROVIDERS.md](PROVIDERS.md));
  - sets `NODE_EXTRA_CA_CERTS=/etc/pki/tls/certs/ca-bundle.crt` when unset.
- **Preflight:** a key typed here goes into `secrets.env`.
- **Start:** the knowledge base's skills and prompts load after the team's
  when `GAH_KB_DIR` names a clone ([KB.md](KB.md)).

`gah init`, `init-kb`, `update-kb` and `update-skills` need a gah checkout and
are refused in a package, as on Windows.

## Not yet tested

- The installer's prompts and the menu entry on a real RHEL 9 desktop (tested
  in a RHEL 9 userland under a pseudo-terminal).
- arm64 builds (wired, untested).
- Other distributions.
