# gah shared agent host

One Linux server runs gah for a small, trusted team (an IT support desk, say).
Each person connects over SSH from a desktop shortcut and lands straight in
the gah TUI, inside a tmux session that survives dropped Wi-Fi. This page is
for the admin who sets up and runs the host. For how this compares with the
other ways to deploy gah, start at [DEPLOY.md](../../docs/DEPLOY.md#choose-a-shape).

**Why a shared host:**

- **Nothing to install on laptops** beyond an SSH key and a shortcut.
- **Any git host for skills.** The host clones the team's skills repository
  with plain git over SSH, so it can live on GitHub, GitLab, Bitbucket or a
  server of your own ([the team forge](../../docs/DEPLOY.md#the-team-forge)).
- **One place to update and audit.** Identity is the Unix account: it signs the
  audit log (`~/.gah/audit.log`) and holds the person's own inference
  credentials (for example per-user cloud keys in `~/.aws/`).
- **No shell hand-out.** The model gets no shell tool unless the person's
  manifest allows one, and the editor's `!command` escape follows the same rule.

```
laptop                            agent host
┌──────────────────┐              ┌──────────────────────────────┐
│ desktop shortcut │   ssh key    │ login shell: gah-session     │
│ wt.exe ssh …     ├─────────────►│  └ tmux new -A -D (reattach) │
└──────────────────┘              │     └ gah-launch             │
                                  │        ├ /etc/gah/users.d/   │
                                  │        │   $USER.conf (root) │      inference
                                  │        ├ skills repo sync ───┼──► any git host (SSH)
                                  │        └ exec bin/gah ───────┼──► e.g. Bedrock
                                  └──────────────────────────────┘
```

## Set it up

**5 steps.** You need a Linux server you have root on (Debian or Ubuntu:
`setup.sh` uses apt), a read-only deploy key for your team's skills
repository, and inference credentials for each person.

1. **Install gah on the host.** From a checkout of this repository (or a copy
   of `deploy/host/`):

   ```bash
   sudo GAH_REPO=git@github.com:charliesolomon/gah.git ./setup.sh
   ```

   It installs git, tmux, Node 22, fd and ripgrep, builds gah at `/opt/gah`
   (root-owned), installs the launcher scripts to `/usr/local/bin`, and creates
   the `gah-agents` group. It is safe to run again. If the gah repository is
   private, root needs read access to it (a deploy key in `/root/.ssh/`, or a
   token in `GAH_REPO`).

2. **Install the skills deploy key** (once). Create a read-only deploy key on
   the skills repository, then install the private half:

   ```bash
   install -m 0640 -g gah-agents skills_deploy_key /etc/gah/skills-deploy-key
   ```

3. **Add each person:**

   ```bash
   gah-adduser jsmith ./jsmith_laptop.pub
   ```

   This creates the account (login shell `gah-session`), authorises the key and
   writes a manifest, `/etc/gah/users.d/jsmith.conf`.

4. **Review the manifest.** It is the person's policy, root-owned; gah refuses
   to start if it isn't. Start from the [template](users.d/agent.conf.example):
   - `SKILLS_REPO`, `SKILLS_BRANCH`: the team's skills repository;
   - `GAH_BUILTIN_MODELS`, `GAH_ALLOWED_HOSTS`: models and the only hosts gah
     may reach ([PROVIDERS.md](../../docs/PROVIDERS.md));
   - `GAH_ALLOW_TOOLS`: extra tools such as `bash`, for skills that run scripts;
   - `GAH_SECRET_FILES`: every credentials file the manifest points at. The
     model can't read them or see their values; scripts still can.

5. **Give each person inference credentials**, for example IAM keys in
   `~jsmith/.aws/credentials` (mode 0600). The cloud policy on those keys, not
   the manifest, is what limits which models the person can invoke.

Then put the shortcut on each laptop ([the laptop side](#the-laptop-side)).

## The laptop side

Every laptop needs the same four things: an SSH key pair for the person, the
host's key pre-seeded in `known_hosts` (so nobody is asked to check a
fingerprint), a Windows Terminal profile, and a desktop shortcut that runs
`wt.exe ssh <user>@<host>`. The public key goes back to the admin for
`gah-adduser`.

How these reach the laptop depends on your endpoint-management tool.
[`deploy/windows/`](../windows/README.md) holds one worked example; the wrapper
that drives it for your organisation (host name, shortcut name, the tool's API)
belongs in your own ops repository.

## Day to day

| Task | How |
|---|---|
| Update gah | `sudo gah-update`. New sessions get the new build; open sessions keep the old one until the person reconnects. It also refreshes the launcher scripts in `/usr/local/bin`, except `gah-update` itself: run `setup.sh` for that. |
| Tell people what changed | Add a dated `## ` section at the top of `/etc/gah/whats-new.md` (start from `whats-new.md.example`). Each person sees it once, at their next launch; `/whats-new` shows all. |
| Update skills | Merge a change in the skills repository. Every launch pulls it; open sessions are told within 10 minutes, and the next launch summarises what changed. |
| Update the knowledge base | Merge the proposal `kb-propose` opened; every launch fast-forwards a clean checkout ([KB.md](../../docs/KB.md)). |
| Change a person's models or tools | Edit `/etc/gah/users.d/<user>.conf`. |
| See what a person's session gets | `sudo -u <user> -H /usr/local/bin/gah-launch --help`: their tools, models, network hosts and skills, from their manifest. It syncs nothing and starts no session. People see the same in a session with `/help`. |
| Test a skill as a person | `sudo -u <user> -H /usr/local/bin/gah-launch --no-mark-seen`. This skips the login shell, which drops arguments, and doesn't mark their skills update as seen (`/skills-seen reset` undoes a launch that did). |
| Update another checkout on the host (an ops repo, a cron tool) | `ssh -A <admin>@<host> "git -C ~/<repo> pull --ff-only"`. The forwarded SSH agent supplies the credential; `sudo -u <user> git pull` loses it. |
| Audit a person's tool calls | `~<user>/.gah/audit.log` (JSON lines, rolled daily, kept 30 days; `GAH_AUDIT_RETENTION_DAYS` in the manifest changes that, `0` keeps all). |
| Audit inference | Your provider's logs, for example Bedrock invocation logging and CloudTrail. |
| Offboard a person | `usermod --lock --shell /usr/sbin/nologin <user>`, then revoke their inference credentials. Home, keys and manifest stay for audit. (`gah-rmuser` removes an account completely, for test accounts.) |
| Run a scheduled job | See [Scheduled jobs](#scheduled-jobs). |

## How a session works

The login shell, `gah-session`, attaches the person's one tmux session (`-A`
reattaches, `-D` drops stale clients), which runs `gah-launch`:

1. **Loads the manifest** `/etc/gah/users.d/$USER.conf`. It refuses to run if
   the file is missing or not root-owned.
2. **Syncs the skills** to `origin/$SKILLS_BRANCH` in `~/.gah/skills-repo`,
   with a hard reset: changes land only through the repository. If the git host
   can't be reached, it warns and keeps the existing copy.
3. **Exports the manifest's settings.** `GAH_BUILTIN_MODELS` is always set
   (empty means none), so a checkout's development default never applies here.
4. **Syncs the knowledge base**, if the manifest sets `KB_REPO`
   ([KB.md](../../docs/KB.md)). This is the one repository the agent writes to,
   so it is never reset: an unclean checkout or a branch is left alone and
   reported.
5. **Starts gah** from `~/work`, with one `--skill` per approved skill folder
   and auto-discovery off. Personal skills (`~/.gah/my-skills`, or
   `MY_SKILLS_REPO`) override shared ones of the same name, with a warning
   ([SKILLS.md](../../docs/SKILLS.md)).

When gah exits, tmux and the SSH connection close.

**There is no in-session setup on this host.** You set accounts up, so there
are no setup skills, no `/setup-skills` and no `gah_setup` tool. If the shared
skills don't load, or can't be updated, the session still starts and one line
above the input box says *Tell your administrator*. The launcher's own warning
is printed in the terminal before the TUI covers it.

### Copy and paste through tmux

Mouse mode is on. In **regular** TUI mode a drag is a tmux selection, sent to
the laptop's clipboard on release. In **fullscreen** mode the TUI copies with
an OSC 52 escape, which tmux forwards because `tmux.conf` sets `set-clipboard on`.
The person's own "Fullscreen copy on select" setting (`/settings`, next to
"TUI mode") must also be on.

## Scheduled jobs

A job that runs on a timer, such as classifying new items in a queue, runs
under its own service account: a manifest like anyone's, but no person, no SSH
key and no login shell. cron starts it in the launcher's headless mode:

```
# /etc/cron.d/<account>   (root-owned, so the job cannot reschedule itself)
*/5 8-17 * * 1-5  <account>  /usr/local/bin/gah-launch --print jobs/prompts/classify.md \
    --only-if jobs/bin/has-work.sh --model amazon-bedrock/<id> --timeout 600 >> /home/<account>/logs/classify.log 2>&1
```

- **What a job does is reviewed like a skill.** The prompt file and the
  `--only-if` check are paths inside the synced skills repository. Point the
  account's `SKILLS_SUBDIR` at the job's own skills to keep its prompt small.
- **Checking costs nothing.** `--only-if` runs after the sync; exit 1 means
  nothing to do, and the launcher exits 0 without calling a model.
- **Nothing carries over between runs.** The skills checkout is reset and
  cleaned, personal skills and setup steps are skipped, each run starts in a
  fresh empty folder with context-file discovery off, and stdin is closed.
- **Exit status is gah's:** 0 when the run completed, non-zero on a provider or
  launcher failure, 124 on timeout. A run that does the wrong thing still exits
  0, so check the outcome the job exists for.
- Its usage goes to the account's own audit log.

Give the account only what its job needs. Don't add it to a group with other
powers just to grant read access to a file; use a file ACL. Add it to
`/etc/cron.deny` so it can't keep a crontab of its own.

## Reference: the skills repository

`SKILLS_REPO` must contain `SKILLS_SUBDIR` (default `skills/`), with one folder
per skill holding a `SKILL.md` (`name` and `description` frontmatter, the same
format as Claude Code skills). Scripts can live elsewhere in the repository
(e.g. `bin/`); skills refer to them by relative path. Layout and authoring:
[SKILLS.md](../../docs/SKILLS.md).

An optional `CHANGELOG.md` at the root, with sections headed `## <version or
date>`, replaces raw commit subjects in the "what changed in your skills"
notice. Write it for the people who use the skills.
