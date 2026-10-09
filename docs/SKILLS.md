# The skills repository

GAH ships an agent, a deployment mechanism and a set of policy controls. It
ships almost no skills, and that is deliberate: the skills are what make the
tool useful to *your* organization, and they cannot come from upstream.

So every GAH deployment has two halves:

| | Lives in | Owned by |
|---|---|---|
| Agent, policy, branding, launchers | this repository | whoever maintains the fork |
| Skills, setup steps, org context | **your skills repository** | your organization |

There is an optional third piece: a **knowledge base** — what is *true* at your
organization, as against what your team *does*, which is what a skill is. It is a
separate repository with its own scaffold (`gah init-kb`) and its own four
skills, because facts and procedures have different authors, different review
rules and different lifetimes. See [KB.md](KB.md). Small deployments keep context
in this repository's `context/` folder and never need one; the knowledge base is
what that grows into when people start correcting it as they work.

**GAH starts without the second half, and says so** ([#135](https://github.com/charliesolomon/gah/issues/135)).
It used to refuse, because a session with no skills was a misconfiguration: the
system prompt is written around skills, so the agent declined ordinary work.
That put the hardest setup step in front of the first session. Now every
launcher starts anyway, and while no shared skills are loaded:

- one line above the input box says *gah is better with your team's skills.
  Type /setup-skills to set them up.*;
- the model is told the session has no shared skills, so it helps with ordinary
  work instead of declining it;
- `/setup-skills` helps connect them: on a deployment package it runs a
  built-in skill that works out what is missing and does the next step (GitLab
  access, then the skills fetch, in the same session); in a checkout it prints
  how to point at a skills repository.

**Setup is there only while it can help** ([#138](https://github.com/charliesolomon/gah/issues/138)).
Once the team's skills load, the setup skills, `/setup-skills` and the
`gah_setup` tool are not registered at all, so they are in neither the system
prompt nor the slash menu. They come back when a package's launcher could not
update the skills (an expired GitLab token, say): the session then runs on the
copy it already had, and the line says *Your team's skills couldn't be updated.
Type /setup-skills to see why and fix it.* Even while offered, the setup skills
carry `disable-model-invocation: true`: only the person starts them, and the
model never picks one for an unrelated question.

The shared host has no in-session setup at all: the administrator sets accounts
up. When its skills did not load or could not be updated, the line says to tell
the administrator. A package whose administrator configures everything turns
setup off with `setupSkills: false` in gah-deploy.json.

The setup skills ship with the policy pack (`packages/policy-pack/setup-skills/`),
so they exist before any skills repository does. A deployment package can ship
its own that replace them by name (`setupSkills` in gah-deploy.json,
[DEPLOY-WINDOWS.md](DEPLOY-WINDOWS.md)); the packager marks them
`disable-model-invocation` too. They never count as the team's skills, so the
line stays until real ones load.

## Creating it

```bash
./bin/gah init ../my-org-skills          # PowerShell: .\bin\gah.ps1 init ..\my-org-skills
```

That writes a scaffold and stops. It is files only — no git remote, no network,
nothing to configure first — because the first person to set GAH up in a new
organization has nothing to clone yet. Version it yourself, or ask the agent to:

```
skills/
  onboarding/SKILL.md        answers "what can I do with this?" from the loaded set
  skill-authoring/SKILL.md   how to write the next one
setup/
  10-configure-inference.sh  .ps1 alongside each .sh
context/
  README.md
```

`gah init` refuses to write into a directory that already has anything in it.

### Taking an update to the starter skills

`onboarding` and `skill-authoring` are gah's guidance rather than yours —
`skill-authoring` tells your people how to write the next skill, and `onboarding`
answers "what can I do with this?" from the loaded set — so they improve
upstream. `gah update-skills <directory>` refreshes those two and the setup
steps, and touches nothing else: your skills, your prompts, your README and your
`context/` are yours from the moment you ran `init`.

```bash
./bin/gah update-skills ../my-org-skills    # PowerShell: .\bin\gah.ps1 update-skills ..\my-org-skills
```

It wants a clean tree, so `git diff` afterwards shows exactly what changed and
`git checkout` puts it back, and it will not resurrect a starter skill you
deleted — that was a decision. A session says when the starters are behind, so
you do not have to remember to check; a repository that has removed both is
never nagged.

### Why those two starter skills

The `onboarding` skill derives its answer from the skills actually loaded rather
than reciting a written list, so it stays honest as the repository grows. The
`skill-authoring` skill means the first thing a new deployment can do is extend
itself — which is the fastest route out of the empty state.

Everything else in the repository should be specific to you. A skill that would
work unchanged at another organization probably belongs upstream instead.

## Pointing GAH at it

Two mechanisms, for two different situations:

| Variable | Value | Used by | Situation |
|---|---|---|---|
| `GAH_SKILLS_DIR` | a **local directory** | `bin/gah`, `bin/gah.ps1` | one person, one machine |
| `SKILLS_REPO` | a **git URL** | `deploy/host/gah-launch` | shared host, many users |

On a workstation:

```bash
GAH_SKILLS_DIR=../my-org-skills/skills ./bin/gah
```

```powershell
$env:GAH_SKILLS_DIR = '..\my-org-skills\skills'; .\bin\gah.ps1
```

On a shared Linux host, `gah-launch` clones `SKILLS_REPO` fresh on every launch
and passes each skill directory explicitly. Set it in the per-user manifest —
see [deploy/host/README.md](../deploy/host/README.md). Users may also set
`MY_SKILLS_REPO` for personal skills, which shadow shared ones by name (loudly).

For a single run, `--skill <path>` works without either variable.

### Two folders at once: a shared project plus your private one

You can develop against your shared skills project **and** a second folder of
private or not-yet-promoted skills in the same session. `GAH_SKILLS_DIR` gives
the wrapper one folder; each extra `--skill <path>` adds another, and one
`--skill` pointed at a project's `skills/` loads every `<name>/SKILL.md` under
it. Keep the shared project in the variable and add the private one per run:

```powershell
# shared, tracked in git, in your PowerShell profile:
$env:GAH_SKILLS_DIR = 'C:\dev\it-skills\skills'
# add your private project (its prompts too, if it has any):
.\bin\gah.ps1 --skill C:\dev\my-skills\skills --prompt-template C:\dev\my-skills\prompts
```

```bash
GAH_SKILLS_DIR=~/dev/it-skills/skills   ./bin/gah --skill ~/dev/my-skills/skills --prompt-template ~/dev/my-skills/prompts
```

The wrapper auto-loads a `prompts/` sibling only for `GAH_SKILLS_DIR`, so name
the private project's templates with `--prompt-template` explicitly. A profile
function makes it one word:

```powershell
function gahdev { .\bin\gah.ps1 --skill C:\dev\my-skills\skills --prompt-template C:\dev\my-skills\prompts @args }
```

**Precedence is first-wins.** When both folders hold a skill of the *same name*,
the one passed **first** is kept and the later one is reported as a collision at
startup and skipped. `GAH_SKILLS_DIR` is always passed before command-line
`--skill` flags, so **shared wins** by default — right when your private skills
are new, distinct names. It only matters if you fork a shared skill to iterate
before promoting it; then either rename the work-in-progress copy, or invert the
order by passing both folders explicitly, private first (which also satisfies
the skills check, so the variable is not needed for that run):

```powershell
.\bin\gah.ps1 --skill C:\dev\my-skills\skills --skill C:\dev\it-skills\skills
```

**Promoting** a private skill is a move: relocate its `<name>/` directory into
the shared project's `skills/`, commit, and open a merge request. This mirrors
the shared host, where personal skills in `~/.gah/my-skills` shadow shared ones
and graduate the same way. The private folder need not be a git repo at all; a
plain local directory works, only the shared project needs tracking.

### `--no-skills` is not an opt-out

It means *do not auto-discover from the user-global config dir*. Every launcher
passes it to pin the loaded set; the setup skills, when offered, still load,
through the policy pack.

`GAH_ALLOW_NO_SKILLS=1` hides the /setup-skills line, for checks and CI that
start without skills on purpose. A deployment that never uses shared skills
sets `skillsNudge: false` in gah-deploy.json instead, and one whose
administrator configures everything sets `setupSkills: false`.

## Prompt templates

`prompts/<name>.md` in the skills repository becomes `/name` in the editor. Typing
`/brief 18746` pastes the file's text into the message with `$1` replaced by
`18746`, and sends it. Nothing else happens: no code runs, no tool is granted, the
model receives ordinary text. A template is the button a person presses for a
request they make often.

That makes it the natural home for house rules — tone, format, "always cite the
ticket number", "show me the draft and stop" — and for hiding skill names from
the people using them: a template can say "use the ticket-brief skill and give me
exactly five lines". Contrast with a skill, which is capability the *agent* picks
up when relevant. Skill is capability; template is a button.

The launchers pass `<repo>/prompts` through automatically (`bin/gah` and
`bin\gah.ps1` relative to `GAH_SKILLS_DIR`, `gah-launch` from the synced clone),
so templates ride the same PR review as skills. Upstream's discovery of a
person's own `~/.gah/agent/prompts/` is deliberately left on: personal templates
are text the person could have typed, so there is nothing to pin.

`gah init` ships three neutral starters — `/summarize`, `/draft-email`, and
`/rrr`, a pirate's stanza about the working directory that proves the
mechanism in ten seconds — meant to be replaced by the organisation's routine (`/morning`,
`/brief <ticket>`, …). Format and argument syntax are upstream's:
[prompt-templates.md](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/prompt-templates.md).

## Setup steps

`setup/NN-*.sh` (`.ps1` on Windows) run in numeric order before the agent
starts. They are for work that must happen outside the model's context:
collecting a credential, writing a config file. They run on **every** launch, so
each must be idempotent — exit immediately once its work is done. A step that
fails is reported and skipped; the session still starts.

They are found **next to** the skills directory — `GAH_SKILLS_DIR/../setup` —
which is the layout `gah init` scaffolds. A run that passes `--skill <path>`
without `GAH_SKILLS_DIR` therefore runs no setup steps, having no repository to
locate them in. `GAH_SKIP_SETUP=1` skips them explicitly.

Steps are agent-authored code at the same trust level as the skills beside them;
the skills repo's review is the change control. Guard anything interactive on a
terminal being present (`[ -t 0 ]`, or `[Environment]::UserInteractive`) so an
unattended launch skips the prompt rather than hanging on it.

The one shipped in the scaffold configures an OpenAI-compatible endpoint: it
asks for the base URL, provider id, model ids and API key, then writes them to
`~/.gah/agent/models.json` with owner-only permissions. That file is read by
default on a workstation, so models work on the first launch — no second step,
no environment variable, no `/login`.

The key goes straight into that file rather than somewhere adjacent. Keeping it
out of the config reads as the safer choice, but it left the user with a config
that was written and then ignored, and a failure that named neither the file nor
the fix. One prompt and one file is the version people actually get working.
Delete the step if your deployment gets its models another way.

## How this tends to roll out

1. **One person, building.** Skills repo on a laptop, `GAH_SKILLS_DIR`, git but
   no remote yet. Most skills are written by the agent, against real work.
2. **A small group.** Push the repo somewhere the team can reach it, move to the
   shared host, set `SKILLS_REPO` in each manifest. Personal skills via
   `MY_SKILLS_REPO` let people iterate without touching the shared set.
3. **Released.** The shared repo is reviewed like code. Onboarding a new user is
   adding a manifest — the skills they get are the skills everyone gets.

## A note on org-specific launchers

`deploy/host/gah-launch` is deliberately generic: it knows about skills repos,
not about any particular organization. If a launcher starts naming your
ticketing system, your directory service or your campuses, that is the signal to
keep it in your own repository rather than upstreaming it — likely alongside the
skills it exists to serve.
