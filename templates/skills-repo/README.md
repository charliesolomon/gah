# Skills for GAH

Created by `gah init`. This repository is the organization-specific half of a
GAH deployment: GAH supplies the agent, the deployment mechanism and the policy
controls; this supplies everything that makes it useful to *your* organization.

```
skills/     one directory per skill, each with SKILL.md
prompts/    slash commands: one Markdown file per /name (see below)
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

## Prompt templates

`prompts/<name>.md` becomes `/name` in the editor: typing it pastes the file's
text into your message, with `$1`, `$2` and `$@` replaced by what you typed
after it. That is all a template is — no code runs and no tool is granted. It
is the button a person presses for a request they make often, and it is where
house rules live: tone, format, "always cite the ticket number", "show me the
draft and stop". A template can name a skill ("use the ticket-brief skill and
give me five lines"), so nobody has to learn skill names.

Three neutral starters ship here: `/summarize`, `/draft-email`, `/handoff`.
Replace them with your routine — a `/morning` for the start of a shift, a
`/brief <ticket>` in your fixed format. People can also keep personal ones in
`~/.gah/agent/prompts/`; those load alongside the shared set and are not
reviewed, which is fine for text the person could have typed anyway.

Format and argument syntax: [upstream's prompt-template reference](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/prompt-templates.md).

## Setup steps

`setup/NN-*.sh` (and `.ps1` on Windows) run before the agent starts, in numeric
order, on every launch — found next to `skills/`, so keep them there. They are the place for anything that must happen outside
the model's context — collecting a credential, writing a config file.

Keep them **idempotent**: they run every time, so each should exit immediately
once its work is done.

The one shipped here configures an OpenAI-compatible endpoint — base URL,
provider id, model ids and API key — and writes `~/.gah/agent/models.json`,
readable only by you. Models work on the first launch. Delete it if your
deployment gets its models another way.
