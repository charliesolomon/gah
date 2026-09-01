# Skills for GAH

Created by `gah init`. This repository is the organization-specific half of a
GAH deployment: GAH supplies the agent, the deployment mechanism and the policy
controls; this supplies everything that makes it useful to *your* organization.

```
skills/     one directory per skill, each with SKILL.md
setup/      steps run before the agent starts, on every launch
context/    what your organization knows (see context/README.md)
```

## Next steps

**1. Put this under source control.**

```bash
git init && git add . && git commit -m "Initial skills repo"
```

Then push it somewhere your team can reach and point deployments at it with
`SKILLS_REPO`. A skills repo on one laptop helps one person.

**2. Try it.**

Start a session and ask what you can do. The `onboarding` skill answers from the
skills actually loaded, so the answer stays honest as this repository grows.

**3. Write your third skill.**

Two shipped with this scaffold. Ask the agent to help — `skill-authoring` exists
for exactly that, which also means the tool teaches its own extension.

## The two starter skills

| Skill | Purpose |
|---|---|
| `onboarding` | Answers "what can I do with this?" from the loaded set, never a written list |
| `skill-authoring` | How to write the next skill |

Both are deliberately generic. Everything else here should be specific to you —
if a skill would make sense at another organization unchanged, it probably
belongs upstream rather than here.

## Setup steps

`setup/NN-*.sh` (and `.ps1` on Windows) run before the agent starts, in numeric
order, on every launch. They are the place for anything that must happen outside
the model's context — collecting a credential, writing a config file.

Keep them **idempotent**: they run every time, so each should exit immediately
once its work is done.

The two shipped here configure an OpenAI-compatible endpoint and collect its API
key. Delete them if your deployment gets its models another way.
