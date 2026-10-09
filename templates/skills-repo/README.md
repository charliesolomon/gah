# Skills for GAH

Created by `gah init`. This repository holds your organization's half of a GAH
deployment: the skills, prompt templates and setup steps that make the agent
useful to your team. GAH itself supplies the agent and the policy controls.

```
skills/     one folder per skill, each with a SKILL.md
prompts/    slash commands: one Markdown file per /name
setup/      steps run before the agent starts, on every launch
context/    what your organization knows (see context/README.md)
```

## Next steps

There are 3, and the first needs only git.

**1. Put it under source control and push it.**

```bash
git init && git add . && git commit -m "Initial skills repo"
```

Push it somewhere your team can reach. A shared Linux host or a gah checkout
can use any git host; the per-person packages fetch skills from GitLab
([details](https://github.com/charliesolomon/gah/blob/main/docs/DEPLOY.md#the-team-forge)).

**2. Try it.** Start a session and ask what you can do. The `onboarding` skill
answers from the skills actually loaded.

**3. Write your third skill.** Ask the agent; `skill-authoring` exists for
exactly that.

## The two starter skills

| Skill | Purpose |
|---|---|
| `onboarding` | Answers "what can I do with this?" from the loaded set |
| `skill-authoring` | How to write the next skill |

Both are generic, and `gah update-skills` keeps them current. Everything else
here should be specific to you: a skill that would work unchanged at another
organization probably belongs in GAH instead.

## Prompt templates

`prompts/<name>.md` becomes `/name` in the editor. Typing it pastes the file's
text into your message, with `$1`, `$2` and `$@` replaced by what you typed
after it. No code runs and no tool is granted: a template is a button for a
request people make often, and the place for house rules (tone, format, "show
me the draft and stop"). A template can name a skill, so nobody has to learn
skill names.

Three starters ship here: `/summarize`, `/draft-email` and `/rrr` (try that one
first). Replace them with your routine, such as a `/morning` or a
`/brief <ticket>`. People can keep personal templates in
`~/.gah/agent/prompts/`.

Format and arguments: [upstream's reference](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/prompt-templates.md).

## Setup steps

Setup steps prepare the machine; skills do work. `setup/NN-*.sh` (and `.ps1` on
Windows) run in numeric order before the agent starts, on every launch, for
anything that must happen outside the model's context: collecting a credential,
writing a config file. Keep them next to `skills/`.

Make each one **idempotent**: it runs every time, so it should exit at once when
its work is done.

The one shipped here configures an OpenAI-compatible endpoint (base URL,
provider id, model ids, API key) and writes `~/.gah/agent/models.json`, readable
only by you. Delete it if your deployment gets its models another way.
