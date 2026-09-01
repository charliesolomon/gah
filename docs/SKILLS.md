# The skills repository

GAH ships an agent, a deployment mechanism and a set of policy controls. It
ships almost no skills, and that is deliberate: the skills are what make the
tool useful to *your* organization, and they cannot come from upstream.

So every GAH deployment has two halves:

| | Lives in | Owned by |
|---|---|---|
| Agent, policy, branding, launchers | this repository | whoever maintains the fork |
| Skills, setup steps, org context | **your skills repository** | your organization |

**GAH will not start without the second half.** A session with no skills is a
misconfiguration, not a lighter mode — the system prompt is written around
skills that are not there, so the agent ends up declining ordinary work while
the user has no way to see why. Refusing at launch, with instructions, is the
kinder failure.

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
  10-create-models-json.sh   .ps1 alongside each .sh
  20-collect-api-key.sh
context/
  README.md
```

`gah init` refuses to write into a directory that already has anything in it.

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

### `--no-skills` is not an opt-out

It means *do not auto-discover from the user-global config dir*. `gah-launch`
passes it on every launch to pin the loaded set. It does not satisfy the check.

To start a genuinely empty session — debugging the harness itself, essentially —
set `GAH_ALLOW_NO_SKILLS=1`.

## Setup steps

`setup/NN-*.sh` (`.ps1` on Windows) run in numeric order before the agent
starts. They are for work that must happen outside the model's context:
collecting a credential, writing a config file. They run on **every** launch, so
each must be idempotent — exit immediately once its work is done.

The two shipped in the scaffold configure an OpenAI-compatible endpoint and
collect its API key. Delete them if your deployment gets its models another way.

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
