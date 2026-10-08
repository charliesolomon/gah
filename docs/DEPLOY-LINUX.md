# Deploying GAH to Linux consumers (RHEL 9)

The same deployment as [DEPLOY-WINDOWS.md](DEPLOY-WINDOWS.md), for people who
work on their own Linux machine: one zip from the organisation's GitLab, an
installer, and a launcher that keeps the package and the skills current on
every start. Same `gah-deploy.json`, same skills repository, same registry
project; only the launcher, the installer and the tool binaries differ. This
page covers what differs. Everything else, including the config schema, is in
DEPLOY-WINDOWS.md.

Built and tested for RHEL 9. Any Linux with bash, Node 22+ and curl should
work; nothing in the launcher is RHEL-specific except the CA bundle path it
offers Node (below).

```
admin machine                      corporate GitLab                 consumer (RHEL 9)
gah checkout + gah-deploy.json ──► package registry ◄──── install.sh, then gah.sh on every launch
                                   (gah-linux package)
                                   skills repository ◄──── archive of <branch> when its head moved
```

The shared Linux host in `deploy/host/` is a different shape: many people on
one machine, root-owned manifests, git with a deploy key. This page is for one
person on their own machine.

## What is different from the Windows package

| | Windows | Linux |
|---|---|---|
| Build | `scripts/package.mjs` (or `package-windows.mjs`) | `scripts/package.mjs --platform linux` |
| Zip | `gah-<org>-<version>.zip` | `gah-<org>-linux-<version>.zip` |
| Registry package | `gitlab.package`, default `gah-windows` | `gitlab.linuxPackage`, default `gah-linux` |
| Tool binaries | `windowsArch`, default `["x64"]` | `linuxArch`, default `["x64"]`; add `"arm64"` for both |
| Scripts | `gah.ps1`, `Install-Gah.ps1`, `Uninstall-Gah.ps1` | `gah.sh`, `install.sh`, `uninstall.sh` |
| Installed to | `%LOCALAPPDATA%\gah\<package>` | `~/.local/share/gah/<package>` |
| Token and API keys | user environment variables | `~/.config/gah/secrets.env`, mode 0600 |
| Client certificate | a thumbprint from the Windows store | a PEM certificate and key, as git's `http.sslCert` / `http.sslKey` |
| Start | desktop shortcut, `gah` in the PowerShell profile | applications-menu entry, `gah` in `~/.local/bin` |
| Setup steps | `setup/NN-*.ps1` | `setup/NN-*.sh` |
| Skills archive | `archive.zip` | `archive.tar.gz` |

Both packages carry the same version number from the same config, and each
platform's launcher looks only at its own registry package. A deployment can
publish one platform without the other. The two package names must differ;
the status script in the `gah-deployments` skill blocks a config where they
are the same.

`icon` applies to the Windows shortcut only. The Linux menu entry uses the
desktop's stock terminal icon.

## Admin: build and publish

```bash
make build-all                                             # once per gah version
node scripts/package.mjs --config ../deploy/gah-deploy.json --platform linux
GAH_GITLAB_TOKEN=... node scripts/publish-gitlab.mjs --config ../deploy/gah-deploy.json --zip dist-deploy/gah-<org>-linux-<version>.zip
```

The packager runs the same tool-surface check against the assembled tree as
for Windows. The publisher reads the platform from the zip's name and uploads
it to `gitlab.linuxPackage`. It refuses a zip whose version is not the
config's. Version rules are the same as Windows: digits and dots, two to four
parts. The Linux launcher compares versions exactly as PowerShell's
`[version]` does, so both platforms agree on what "newer" means.

Building the Linux package works on any machine with the build, Windows
included; the tool-surface check needs bash.

## Consumer: install

Prerequisites on the machine:

```bash
sudo dnf module enable nodejs:22 && sudo dnf install nodejs   # Node 22 LTS from AppStream
node --version                         # v22 or newer
```

`curl`, `tar`, `sha256sum` and `python3` are part of every RHEL 9 install.
Updates are unpacked with `unzip` when it is present and with python3's
`zipfile` module otherwise.

1. Download `gah-<org>-linux-<version>.zip` from the deployment project's
   package registry (*Deploy* → *Package registry* → `gah-linux`) and unpack it:
   ```bash
   unzip gah-<org>-linux-<version>.zip          # or: python3 -m zipfile -e gah-<org>-linux-<version>.zip .
   cd gah-<org>-linux-<version>
   bash install.sh
   ```
   The installer:
   - checks Node 22+, curl, tar and sha256sum;
   - copies the package to `~/.local/share/gah/<package>`;
   - verifies the tool archives against the pinned checksums and unpacks `fd` and `rg`;
   - asks for a GitLab token (Enter to skip when the project is visible without one);
   - when `gitlab.clientCert` is `"user"`, asks for the client certificate and key files, offering what git already uses for this GitLab;
   - asks for any API key the config collects through an environment variable, and names providers that use `/login` instead;
   - stores the answers in `~/.config/gah/secrets.env` (directory 0700, file 0600);
   - writes `current.txt` and the stable stub `~/.local/share/gah/gah-launch`;
   - puts `gah` in `~/.local/bin` (an existing `gah` that is not the installer's own is left alone, with a warning), adding that directory to `PATH` in `~/.bashrc` only if it is not already there (RHEL 9's default `.bashrc` has it);
   - adds an applications-menu entry that opens a terminal (`--no-desktop` skips it).
2. Open a new terminal and type `gah`. The first launch fetches the skills repository.

Re-running the installer repairs an installation. For unattended installs,
`--no-prompt` asks nothing: a `GAH_GITLAB_TOKEN` or API-key variable already in
the environment is stored, and anything missing is named.

`~/.local/share/gah/uninstall.sh` reverses all of it: the packages, the skills
cache and downloads, the menu entry, `gah`, the `PATH` line it added, and
`secrets.env` (`--keep-secrets` keeps that). The agent's own state in `~/.gah`
stays unless `--purge`.

## What happens on every launch

`gah.sh`, started through `~/.local/share/gah/gah-launch`, does what
[gah.ps1 does](DEPLOY-WINDOWS.md#what-happens-on-every-launch), in the same
order:

0. **Node** 22 or newer; when it is missing, offers to install it with
   `sudo dnf` in a terminal, or says how.
1. **Update** from the `gah-linux` registry package, verified against its
   `.sha256`, finalised by the new package's `install.sh --update`.
2. **Skills** as `archive.tar.gz` at the branch head, when the head moved.
   Without GitLab access the session starts without shared skills; a GitLab
   failure in either step is one line.
3. **Environment.** The same variables as Windows, plus three that are Linux-only:
   - the variables in `secrets.env` that are not already set in the environment;
   - `GAH_SECRET_FILES` extended with `secrets.env` itself. The file is
     readable by the person, and so by the agent's read tool; naming it as a
     secret store makes the policy refuse it and redact its values from any
     tool result ([PROVIDERS.md](PROVIDERS.md), lib/secrets.ts);
   - `NODE_EXTRA_CA_CERTS=/etc/pki/tls/certs/ca-bundle.crt` when it is unset.
4. **Preflight** `preflight.mjs`: a route to the model and a working key, as
   on Windows ([first launch](DEPLOY-WINDOWS.md#first-launch-and-setup)). There
   is no system proxy setting to read on Linux, so the order is a direct
   connection, `HTTPS_PROXY`, the config's `inferenceProxy`, then the person.
   A key typed here goes into `secrets.env`.
5. **Setup steps** `setup/NN-*.sh` from the skills repository.
6. **Start** `node bundle/cli.js --no-extensions --no-skills [--skill … --prompt-template …]`,
   with the knowledge base's skills and prompts after the organisation's when
   `GAH_KB_DIR` names a clone ([KB.md](KB.md)).

`/setup-skills` works as on Windows. A client certificate is a PEM file here:
the person types its path, and the key's if it is separate, into the dialog
`gah_setup` opens; the token goes into `secrets.env`, which the policy already
hides from the agent.

`gah init`, `gah init-kb`, `gah update-kb` and `gah update-skills` are refused with
a pointer to a gah checkout, as on Windows: the templates they copy are not in
a package.

## Certificates and proxies

**GitLab calls** (update check, skills) go through `curl`, which uses the
system trust store in `/etc/pki`. A managed RHEL machine normally already
trusts the corporate CA there; if not, `sudo cp <ca>.pem
/etc/pki/ca-trust/source/anchors/ && sudo update-ca-trust`. The proxy follows
`gitlab.proxy` as on Windows: `null` leaves it to curl, which honours
`HTTPS_PROXY` / `https_proxy` and `NO_PROXY`; a URL forces that proxy; `"none"`
forces a direct connection.

**Mutual TLS.** With `gitlab.clientCert: "user"`, curl presents the PEM
certificate and key named by `GAH_GITLAB_CLIENT_CERT` and
`GAH_GITLAB_CLIENT_KEY` in `secrets.env`. The key must not have a passphrase,
because the launcher runs curl without a terminal prompt. Git uses the same
files, so `git config --get-urlmatch http.sslcert <gitlab-url>` names them.

**The agent's own calls** to the inference endpoint come from Node, which
carries its own CA list rather than the system's. The launcher points
`NODE_EXTRA_CA_CERTS` at the system bundle so the two agree; set it yourself to
override. Behind a proxy, Node needs `NODE_OPTIONS=--use-env-proxy` and
`HTTPS_PROXY`, as for the build ([WINDOWS.md](WINDOWS.md) describes the same
variables).

## Not covered

- **Interactive prompts on a real desktop.** The installer's prompts and the
  menu entry were tested in a RHEL 9 userland (UBI 9) under a pseudo-terminal,
  not yet on a RHEL 9 workstation's GNOME session.
- **arm64** builds are wired (`linuxArch: ["x64", "arm64"]`) but untested.
- **Other distributions.** Nothing assumes RHEL beyond the CA bundle path,
  which is skipped when absent, and the `dnf` line above.
