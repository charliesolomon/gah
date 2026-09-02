# GAH shared agent host

Deployment for a **central Linux host serving the GAH TUI over SSH** to a
small trusted team (the Grace Schools IT-support model). Staff on Windows
laptops get an RMM-deployed desktop shortcut that runs
`wt.exe ssh <user>@<host>`; SSH-ing in lands directly in the GAH TUI inside
a persistent tmux session. There is no raw shell hand-out.

```
Win11 laptop                      agent host                          AWS
┌──────────────────┐              ┌──────────────────────────────┐
│ Desktop shortcut  │   ssh key   │ login shell: gah-session      │
│ wt.exe ssh …      ├────────────►│  └ tmux new -A -D (reattach)  │
│                   │             │     └ gah-launch              │
│ Browser:          │             │        ├ /etc/gah/users.d/    │   ┌─────────┐
│ ticketing system  │             │        │   $USER.conf (root)  │   │ Bedrock │
└──────────────────┘              │        ├ skills repo sync ────┼─┐ │ (IAM-   │
                                  │        └ exec bin/gah ────────┼─┼►│ scoped) │
                                  │           ~/.aws  ~/.gah/     │ │ └─────────┘
                                  └──────────────────────────────┘ │
                                        GitHub skills repo ◄───────┘
                                        (PR-gated, pull on launch)
```

Identity is the Unix account: the RMM-deployed SSH key authenticates the
user, per-user IAM keys in `~/.aws/` authenticate to Bedrock, and both the
GAH audit log (`~/.gah/audit.log`, tool calls) and Bedrock invocation
logging / CloudTrail (inference) attribute activity to that user.

## Install

```bash
# on the host, from a checkout of this repo (or scp deploy/host/ over):
sudo GAH_REPO=git@github.com:charliesolomon/gah.git ./setup.sh
```

`setup.sh` is idempotent: installs git/tmux/Node 22, builds gah at
`/opt/gah` (root-owned), installs the launcher chain to `/usr/local/bin`,
and creates the `gah-agents` group. Private-repo note: root needs read
access to the gah repo (deploy key in `/root/.ssh/` or an https token in
`GAH_REPO`).

Then per component:

1. **Skills deploy key** (once): generate a read-only deploy key for the
   skills repo, add the public half on GitHub (Settings → Deploy keys),
   and install the private half:
   ```bash
   install -m 0640 -g gah-agents skills_deploy_key /etc/gah/skills-deploy-key
   ```
2. **Agent accounts**:
   ```bash
   gah-adduser jsmith ./jsmith_laptop.pub
   ```
   Creates the account (login shell `gah-session`), authorizes the key,
   and drops a manifest at `/etc/gah/users.d/jsmith.conf` from the
   [template](users.d/agent.conf.example) — review it: skills repo/branch,
   `GAH_BUILTIN_MODELS` globs, `GAH_ALLOW_TOOLS`.
3. **fd and ripgrep**: `setup.sh` installs the `fd-find` and `ripgrep`
   packages system-wide, so no per-user copy is needed and nothing is
   downloaded at runtime (docs/SUPPLY-CHAIN.md).
4. **AWS credentials** (Phase 2): per-user IAM keys in
   `~jsmith/.aws/credentials`, mode 0600. The IAM policy — not the manifest
   — is what actually restricts which Bedrock models the user can invoke.

## How a session works

`gah-session` (the login shell) attaches the user's single tmux session
(`-A` reattach, `-D` kick stale clients from dropped Wi-Fi), which runs
`gah-launch`:

1. Loads `/etc/gah/users.d/$USER.conf` — refuses to run if missing or not
   root-owned (the manifest *is* the policy).
2. Syncs `~/.gah/skills-repo` to `origin/$SKILLS_BRANCH` (hard reset — the
   repo is authoritative; changes only land via merged PRs). Offline or
   GitHub down → warns and keeps the existing checkout.
3. Exports the deployment env. `GAH_BUILTIN_MODELS` is always set (empty =
   deny-all) so `bin/gah`'s `anthropic/*` dev default never applies here.
   `GAH_ALLOW_TOOLS` widens the policy-pack tool allowlist (e.g. `bash` for
   skills that drive shell scripts) and is audit-logged at session start.
4. `exec bin/gah --no-skills --skill ~/.gah/skills-repo/skills` from
   `~/work` — auto-discovery off, exactly the approved skills pinned, same
   philosophy as `bin/gah` uses for extensions.

When gah exits, tmux and the SSH connection close.

## Operations

| Task | Command |
|---|---|
| Update gah build | `sudo gah-update` (sessions pick it up on next launch) |
| Update skills | merge a PR in the skills repo — every launch pulls |
| Change a user's models/tools | edit `/etc/gah/users.d/<user>.conf` |
| Audit a user's tool calls | `~<user>/.gah/audit.log` (JSONL) |
| Audit inference | Bedrock model invocation logging + CloudTrail (Phase 2) |
| Offboard | `usermod -L <user>` + deactivate IAM keys |

## Skills repo contract

The manifest's `SKILLS_REPO` must contain `SKILLS_SUBDIR` (default
`skills/`) holding one directory per skill with a `SKILL.md`
(`name`/`description` frontmatter) — the same format as Claude Code
skills, so existing skill dirs port over unchanged. Supporting scripts can
live in the repo (e.g. `bin/`); skills reference them relative to their
own location.
