# <Org> Assistant

<!-- Template for the README of a team's deployment project on GitLab.
     Copy next to gah-deploy.json, replace the <placeholders>, drop the Linux
     section if you publish no Linux package, and keep "If something goes
     wrong" current with what people actually hit. -->

An AI assistant for <Org> staff, run under our policies: it uses the skills we
publish, talks only to our inference service, and logs every action it takes.

Installing takes about five minutes. You need **Node.js 22 or newer** and,
unless this project is visible to you without one, a **GitLab personal access
token** with the `read_api` scope.

## Install on Windows 11

1. **Download** the newest package: **Deploy → Package Registry → <name>**,
   then `<name>-win11-<version>.zip`.
2. **Unzip and install**, in PowerShell:
   ```powershell
   Expand-Archive -LiteralPath ~\Downloads\<name>-win11-<version>.zip -DestinationPath ~\gah-install
   cd ~\gah-install\<name>-win11-<version>
   .\Install-Gah.ps1
   ```
   It asks for your GitLab token (Enter skips it), and for a client
   certificate if ours needs one: pick the one issued to you by <Org>.
3. **Start it** from the desktop shortcut **<Org> Assistant**, or type `gah`
   in a new PowerShell window.

## Install on Linux (RHEL 9)

1. **Install Node.js 22:** `sudo dnf module enable nodejs:22 && sudo dnf install nodejs`
2. **Download** `<name>-linux-<version>.zip` as above, then:
   ```bash
   unzip <name>-linux-<version>.zip
   bash <name>-linux-<version>/install.sh
   ```
   It asks the same questions. Answers are kept in
   `~/.config/gah/secrets.env`, readable only by you and hidden from the
   assistant.
3. **Start it:** type `gah` in a new terminal, or pick **<Org> Assistant** from
   the applications menu.

## First start

- **API key.** If gah has no key that works, it asks for one before it
  starts. What you type is hidden.
- **Our skills.** If they aren't set up yet, a line above the input box says
  *Type /setup-skills to set them up*. Type `/setup-skills` and follow it.
  Your token goes into a hidden box, never into the chat.
- **Try it:** type `what can you do?`, or `/` to see the commands.

## Day to day

Updates are automatic: each start checks for a newer package and for changes
to our skills. If a start says an update failed, it carries on with what it
has; tell <admin contact> if it keeps happening.

To uninstall: on Windows, `& "$env:LOCALAPPDATA\gah\Uninstall-Gah.ps1"`; on
Linux, `~/.local/share/gah/uninstall.sh`. Add `-Purge` (Windows) or
`--purge` (Linux) to also remove your keys and sessions in `~/.gah`.

## If something goes wrong

| Symptom | What to do |
|---|---|
| `Node.js 22 or newer is required` | Install Node.js LTS, open a new window, and start again |
| An update fails at every start | GitLab is not reachable: check the proxy, your token, or your certificate. Type `/setup-skills` to see what is wrong. |
| The window closes at once | Start it with `gah` from PowerShell or a terminal to read the message |

## For the admin

`gah-deploy.json` here is the source of truth: our GitLab locations, allowed
hosts and tools, and the inference service and its models. It never holds keys
or tokens.

To publish a new version, raise `version` in `gah-deploy.json` (digits and
dots, e.g. `1.0.4` or `1.0.4.1`), then build and publish from a gah checkout,
and commit the config. People get the new version on their next start. The
steps are in the gah repository's `docs/DEPLOY-WINDOWS.md`, and its
`gah-deployments` skill walks through them.
