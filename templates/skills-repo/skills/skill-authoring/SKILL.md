---
name: skill-authoring
description: Write a new skill for this deployment, or improve an existing one. Use when someone wants to add a skill, capture a repeated procedure, teach the agent something about how this organization works, or asks how skills work. Aliases - create skill, new skill, write a skill, how do skills work
allowed-tools: Read, Write, Edit, Glob, Grep
---

# Writing a skill

A skill is a procedure this organization actually follows, written down where an
agent can use it. The value is rarely the instructions — it is the context the
instructions carry: which system to use, what the fields mean, which mistakes
have already been made.

## Anatomy

A skill is one directory containing `SKILL.md`, with a small header:

```
---
name: ticket-triage
description: Analyze open support tickets and provide triage recommendations
allowed-tools: Bash(~/ops/bin/ticket-triage.sh:*)
---

Everything below the header is prose telling the agent how *this*
organization does the thing.
```

- **`name`** — how the skill is addressed. Directory name is the fallback.
- **`description`** — how the agent decides this skill is relevant. Write it as
  the *request someone would make*, not as a summary of the file. This is the
  single field that determines whether the skill ever gets used.
- **`allowed-tools`** — the hard boundary. The skill may use these and nothing
  else. Omit it and the skill inherits the session's allowlist.

## Getting the description right

This is where most skills fail. The agent matches a request against
descriptions, so a description written for a human index is invisible.

Weak: `Ticket utilities`
Better: `Answer questions about recently closed support tickets`
Best: add the phrasings people actually use — `Aliases - what closed, recent closures`

## Reach tools through a wrapper script

Do not put credentials, connection strings or long command lines in a skill.
Put them in a small script and grant the script:

```yaml
allowed-tools: Bash(~/ops/bin/my-tool.sh:*)
```

The skill then knows a script exists, not how it authenticates. One clear grant
per skill instead of a sprawl of patterns, and the credentials never appear in a
file the model reads aloud.

## Writing the body

**Write what a competent newcomer would get wrong.** If the procedure is obvious
from the tool's own help text, the skill adds nothing. The value is the local
knowledge: that a certain field is unreliable, that one queue is a view rather
than a bucket, that a report divides by business days and not calendar days.

**Prefer concrete examples over description.** One worked example, with real
values, teaches more than three paragraphs.

**Record why, not just what.** A rule without its reason gets "simplified" by
the next person, and then the bug comes back.

**Say what not to do.** Skills that only say what to do leave every wrong path
open. If something looks correct and is not, name it.

## Before you finish

- Does the description contain the words someone would actually type?
- Would this skill still be right if the person reading it had never met you?
- Is there a fact in here that will drift — a count, a list, a version? If so,
  can the skill *derive* it instead of stating it?

That last question matters more than it looks. Hand-maintained lists inside
skills go stale silently, and a confidently wrong answer is worse than no skill.

## Where it goes

Put the directory under `skills/` in this repository, commit it, and it reaches
everyone the next time they start a session. A skill that lives only on your
machine helps one person.
