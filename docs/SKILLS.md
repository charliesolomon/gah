# The skills repository

Your team's skills are what make gah useful to you, and they live in a git
repository your organization owns. This page is for whoever sets that
repository up and for the people who write skills in it.

**Getting started takes 3 steps:** create the repository, host it where your
team can reach it, and point gah at it. You need a built gah checkout
([README](../README.md#quick-start)) and git. You end up with a repository of
skills, prompt templates and setup steps that every session loads.

## What lives where

| | Lives in | Owned by |
|---|---|---|
| Agent, policy, launchers | this repository | whoever maintains gah |
| Skills, prompt templates, setup steps, context | **your skills repository** | your organization |
| Facts about your organization (optional) | your knowledge base ([KB.md](KB.md)) | your organization |

A skill is what your team **does**; the knowledge base is what is **true**.
Small deployments keep a few facts in the skills repository's `context/` folder
and never need a knowledge base.

## 1. Create it

```bash
./bin/gah init ../my-org-skills          # PowerShell: .\bin\gah.ps1 init ..\my-org-skills
```

This writes files and stops: no git remote, no network. It refuses a directory
that already has anything in it.

```
skills/
  onboarding/SKILL.md        answers "what can I do with this?" from the loaded set
  skill-authoring/SKILL.md   how to write the next skill
prompts/                     slash commands (/summarize, /draft-email, /rrr)
setup/
  10-configure-inference.sh  .ps1 alongside each .sh
context/
  README.md
```

The two starter skills are gah's guidance, not yours, and gah keeps them
current ([below](#keeping-the-starter-skills-current)). Everything else should
be specific to your organization: a skill that would work unchanged anywhere
probably belongs in gah instead.

## 2. Host it

Commit it and push it somewhere your team can reach. A skills repository on one
laptop helps one person.

Where you host it depends on how your team runs gah ([DEPLOY.md](DEPLOY.md#choose-a-shape)).
gah supports one team forge today: GitLab. The per-person packages (Windows and
Linux) use it for updates, the team's skills and in-session setup. The shared
Linux host and gah checkouts use plain git, so their skills can live on any git
host. See [The team forge](DEPLOY.md#the-team-forge) for what adding another
forge involves.

## 3. Point gah at it

| How gah runs | Setting | Value |
|---|---|---|
| gah checkout (one person) | `GAH_SKILLS_DIR` | the local `skills/` folder of a clone |
| Shared Linux host | `SKILLS_REPO` in each user's manifest | a git URL ([deploy/host/README.md](../deploy/host/README.md)) |
| Per-person package | `skills.project` and `skills.branch` in `gah-deploy.json` | a GitLab project ([DEPLOY-WINDOWS.md](DEPLOY-WINDOWS.md#gah-deployjson)) |

In a checkout:

```bash
GAH_SKILLS_DIR=../my-org-skills/skills ./bin/gah
```

```powershell
$env:GAH_SKILLS_DIR = '..\my-org-skills\skills'; .\bin\gah.ps1
```

For a single run, `--skill <path>` works without any setting. On the shared
host, people can add personal skills with `MY_SKILLS_REPO`; they shadow shared
ones of the same name, with a warning.

## When no skills are loaded

gah still starts. One line above the input box says so, and the model is told
the session has no shared skills, so it helps with ordinary work instead of
declining it.

- **Per-person package:** the line points at `/setup-skills`, which works out
  what is missing (usually GitLab access) and fetches the skills into the same
  session. It is also offered when the launcher could not update skills it
  already had, such as after a token expires. Details:
  [DEPLOY-WINDOWS.md](DEPLOY-WINDOWS.md#first-launch-and-setup).
- **gah checkout:** `/setup-skills` prints how to set `GAH_SKILLS_DIR`.
- **Shared host:** there is no in-session setup. The line tells the person to
  contact the administrator.

Once the team's skills load, none of this is registered: not in the system
prompt, not in the slash menu. The built-in setup skills live in
`packages/policy-pack/setup-skills/`. A package can replace them by name or
turn setup off (`setupSkills` in `gah-deploy.json`).

## Prompt templates

`prompts/<name>.md` becomes `/name` in the editor. Typing `/brief 18746` pastes
the file's text into the message, with `$1` replaced by `18746`, and sends it.
No code runs and no tool is granted. A skill is capability the agent picks up
when relevant; a template is a button for a request people make often.

Templates are the natural home for house rules (tone, format, "show me the
draft and stop") and can name a skill so nobody has to learn skill names. Every
launcher loads the repository's `prompts/`, so templates get the same review as
skills. People can keep personal ones in `~/.gah/agent/prompts/`.

Replace the three starters with your own routine. Format and arguments:
[upstream's reference](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/prompt-templates.md).

## Setup steps

Setup steps prepare your machine; skills do work. `setup/NN-*.sh` (`.ps1` on
Windows) run in numeric order before the agent starts, for anything that must
happen outside the model's context, such as collecting a credential or writing
a config file.

- They run on **every** launch, so each must be idempotent: exit at once when
  its work is done.
- A failing step is reported and skipped; the session still starts.
- They are found next to `skills/` (`GAH_SKILLS_DIR/../setup` in a checkout).
  `GAH_SKIP_SETUP=1` skips them.
- They are code at the same trust level as the skills, reviewed the same way.
  Guard anything interactive on a terminal being present (`[ -t 0 ]`, or
  `[Environment]::UserInteractive`) so an unattended launch does not hang.

The shipped step configures an OpenAI-compatible endpoint (base URL, provider
id, model ids, API key) and writes `~/.gah/agent/models.json`, readable only by
the owner. A checkout reads that file by default, so models work on the first
launch. Delete the step if your deployment gets its models another way.

Setup steps that run inside the session, for things a person does once, are
planned in [#139](https://github.com/charliesolomon/gah/issues/139).

## How this tends to roll out

1. **One person, building.** The repository on a laptop with `GAH_SKILLS_DIR`.
   The agent writes most skills, against real work.
2. **A small group.** Push the repository, then move people to the shared host
   or a package. Personal skills let people experiment without touching the
   shared set.
3. **Released.** The shared repository is reviewed like code. Adding a person
   gives them the same skills as everyone else.

## Reference

### Keeping the starter skills current

```bash
./bin/gah update-skills ../my-org-skills    # PowerShell: .\bin\gah.ps1 update-skills ..\my-org-skills
```

This refreshes `onboarding`, `skill-authoring` and the shipped setup step, and
touches nothing else. It needs a clean tree, so `git diff` shows what changed
and `git checkout` undoes it. It does not bring back a starter skill you
deleted. A session started from a checkout says when the starters are behind.

### Two folders at once: shared plus private

To work on private or not-yet-shared skills next to the shared set, keep the
shared folder in `GAH_SKILLS_DIR` and add the private one per run:

```powershell
$env:GAH_SKILLS_DIR = 'C:\dev\team-skills\skills'
.\bin\gah.ps1 --skill C:\dev\my-skills\skills --prompt-template C:\dev\my-skills\prompts
```

```bash
GAH_SKILLS_DIR=~/dev/team-skills/skills ./bin/gah --skill ~/dev/my-skills/skills --prompt-template ~/dev/my-skills/prompts
```

- Only `GAH_SKILLS_DIR` gets its `prompts/` loaded automatically; name other
  template folders with `--prompt-template`.
- **The first folder passed wins** when two skills share a name; the later one
  is reported at startup and skipped. `GAH_SKILLS_DIR` is passed first, so the
  shared skill wins. To test a private copy of a shared skill, rename it or pass
  both folders with `--skill`, private first.
- **Promoting** a private skill means moving its folder into the shared
  repository's `skills/` and opening a pull or merge request. The private
  folder need not be a git repository.

### `--no-skills` and `GAH_ALLOW_NO_SKILLS`

`--no-skills` means *do not auto-discover skills from the user's config
folder*. The shared host and the packages pass it to pin the loaded set; the
skills named with `--skill`, and the setup skills when offered, still load. A
checkout leaves discovery on, so `~/.gah/agent/skills` loads there too.

`GAH_ALLOW_NO_SKILLS=1` hides the no-skills line, for checks and CI that start
without skills on purpose. A deployment that never uses shared skills sets
`skillsNudge: false` in `gah-deploy.json` instead.

### Organization-specific launchers

`deploy/host/gah-launch` knows about skills repositories, not about any
organization. A launcher that starts naming your ticketing system or directory
service belongs in your own repository, next to the skills it serves.
