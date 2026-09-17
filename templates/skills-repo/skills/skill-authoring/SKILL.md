---
name: skill-authoring
description: Write a new skill for this deployment, improve an existing one, or review the skills already here and recommend changes. Use when someone wants to add a skill, capture a repeated procedure, teach the agent something about how this organization works, asks how skills work, or asks to review, assess or audit a skill or the whole skill set and say what is missing. Aliases - create skill, new skill, write a skill, how do skills work, review my skills, assess this skill, audit our skills, what is wrong with this skill, are our skills any good
allowed-tools: Read, Write, Edit, Glob, Grep
---

# Writing a skill

A skill is a procedure this organization actually follows, written down where an
agent can use it. The value is rarely the instructions — it is the context the
instructions carry: which system to use, what the fields mean, which mistakes
have already been made.

## First: is it a skill at all?

Three things can be written down here, and choosing wrong is invisible at the
time and expensive later.

| Write a… | When it holds | Where it lives |
|---|---|---|
| **Skill** | what the team *does* — a procedure, a judgement, a sequence | `skills/` in this repository |
| **Knowledge base article** | what is *true* here — a site, a device, a convention, an exception and its reason | the knowledge base (`kb-article`) |
| **Prompt template** | a phrasing someone types often, with no new capability | `prompts/<name>.md` → `/name` |

The commonest mistake is writing a skill that is really an article. If what you
have is mostly *facts* — a list of sites, who owns what, how the addressing
works — it belongs in the knowledge base, where anyone can correct it the moment
they find it wrong. Ask for `kb-article` instead and you are done in a minute.

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

- **`name`** — how the skill is addressed. Lowercase letters, digits and
  hyphens; the directory name is the fallback.
- **`description`** — how the agent decides this skill is relevant. Write it as
  the *request someone would make*, not as a summary of the file. This is the
  single field that determines whether the skill ever gets used.
- **`allowed-tools`** — **a statement of intent, not the fence.** Write it: it
  documents what the skill is supposed to need, it reviews well, and it is
  enforced verbatim by harnesses that read it. But in this deployment the thing
  that actually stops a tool call is the policy layer's allowlist, applied to
  every skill equally at the moment of the call. A skill cannot widen what the
  deployment granted, and naming a tool here does not grant it. If a skill needs
  a tool the deployment has not allowed, that is a conversation with whoever
  owns the deployment, not a line in this header.

## Getting the description right

This is where most skills fail. The agent matches a request against
descriptions, so a description written for a human index is invisible.

Weak: `Ticket utilities`
Better: `Answer questions about recently closed support tickets`
Best: add the phrasings people actually use — `Aliases - what closed, recent closures`

## Where the facts go

**The skill is the procedure. The knowledge base is the facts the procedure
needs.** Getting this wrong is the single thing that stops a deployment
improving, because a fact buried in a skill cannot be corrected by the person
who just discovered it was wrong.

When you are about to write a fact into a skill, work down this ladder:

1. **Derive it.** If a system knows the answer, have the skill ask that system
   at the moment it matters. A count, a roster, an inventory, a status: never
   type these into a skill.
2. **Look it up in the knowledge base.** For facts with no system of record —
   the conventions, the standing exceptions, the reasons — have the skill
   consult the knowledge base rather than restate it.
3. **State it in the skill.** Last resort, and only for something that genuinely
   cannot drift. Then say when it was true.

### Consult, do not embed

This is the pattern that makes a skill improve without being edited:

> **Instead of:** Escalate to the site lead. The leads are North — A, South — B,
> West — C. Out of hours, ring extension 4100.
>
> **Write:** Escalate to the site lead. Who that is, and the out-of-hours route,
> are in the knowledge base — look up the site before escalating rather than
> assuming the person you escalated to last time.

The second version is still correct after someone leaves. It also gets *better*
every time the article improves, while the skill file never changes.

### When the fact is not documented anywhere

Say so, and record it. A skill that hits an undocumented fact and records a gap
turns every run into a vote for what gets written next — which is how the
backlog comes to reflect what people actually needed rather than what someone
guessed in advance. Tell the skill to hand over to `kb-search`, which owns the
gap-recording, rather than inventing its own.

Never have a skill guess at an organizational fact. A confidently wrong answer
is worse than no skill: it is believed once, and then nothing here is trusted.

### `context/` and the knowledge base

`context/` in this repository is for small deployments and for material the
skills cite directly. Once a knowledge base exists it is the better home for
anything people will correct as they work, because corrections there are a
normal reviewed change rather than an edit to the skills repository. New facts
go to the knowledge base; leave what is already in `context/` until it needs
touching.

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

## Where a skill's findings go

A skill that establishes something durable — an audit result, a root cause, a
device that turned out not to match the documentation — should offer to record
it, not just report it into a conversation that ends. Say so in the skill:
*"if this turns up something the knowledge base does not have, offer to write
it up."* That is the same improvement loop, entered from the other end.

Not everything qualifies. One ticket's outcome is not an article; the fact it
revealed about the estate might be.

## Before you finish

- Does the description contain the words someone would actually type?
- Would this skill still be right if the person reading it had never met you?
- **Is any fact in here one the knowledge base should own?** Could the skill look
  it up instead of stating it?
- Is there a fact that will drift — a count, a list, a version? Can the skill
  *derive* it?
- Does the skill say what to do when a fact it needs is missing?
- Does it say where its own findings go?

## Where it goes

Put the directory under `skills/` in this repository, commit it, and it reaches
everyone the next time they start a session. A skill that lives only on your
machine helps one person.

If what you wrote turned out to be facts rather than a procedure, it belongs in
the knowledge base instead — hand over to `kb-article` rather than committing an
article-shaped skill.

---

# Reviewing skills that already exist

Use this half when someone asks to review, assess or audit a skill, or the whole
set, and say what should change. The aim is a short list of changes worth making,
not a report card.

## How to review

**Read the whole set first, not one file.** Half of what is wrong with a skill is
only visible next to its neighbours: two skills that would match the same
request, a fact repeated in three places, a gap where everyone assumed someone
else had written it.

**Then read each skill fully** — the header and the body. A skill cannot be
judged from its name.

**Then check the deployment it runs in**, if you can see it: which tools are
allowed, and whether a knowledge base is loaded. A skill that depends on a tool
the deployment does not grant is broken in a way that never shows up as an error.

## What to check

A working order, not a severity order. The early checks need only the skill's
own text, so they cost nothing and clear the ground; the late ones need the
whole set and the deployment, which you will not have until you have read both.
Rank what you find afterwards — see the reporting rules below.

1. **Would it ever be chosen?** Read the description as the agent sees it: as a
   request someone might make. If it reads like a file summary, or names the
   skill rather than the need, it is invisible however good the body is. Nothing
   else about the skill matters if the answer is no. It is also the check most
   likely to pass on a set written by someone who read the first half of this
   file, so do not read an easy pass here as a healthy set.
2. **Is it a skill at all?** Mostly facts means it wants to be a knowledge base
   article. Mostly a phrasing means it wants to be a prompt template.
3. **Facts that will drift.** Counts, rosters, inventories, versions, names,
   contact routes. For each: can it be derived, or looked up in the knowledge
   base? Name the specific line. In a set that is already careful you will find
   few *wrong* facts and several **right ones living in two places**, one of
   them code — a threshold, a naming rule, a field list restated from a README.
   Those are the finding: they agree today and diverge silently.
4. **Does it consult the knowledge base where it should?** A skill that needs
   organizational context and states it inline will be wrong within months.
5. **Does it say what happens when a fact is missing?** Guessing is the failure
   mode; recording a gap is the fix.
6. **Is `allowed-tools` honest?** It should describe what the skill actually
   uses. Flag a skill that names tools it never touches, or touches tools it
   never names — and remember it documents intent rather than enforcing it, so
   never report it as the reason a skill is "safe". This check finds the most
   and usually matters the least: it is documentation debt unless the skill
   ships somewhere that enforces the header. Do not let the count carry it to
   the top of your report.
7. **Anything secret or machine-specific in the body.** Credentials, tokens, a
   path under one person's home directory. Grep for it before you start rather
   than weighing it here: it almost never fires, and it is the one you would
   most regret missing.
8. **Collisions, and handovers.** Two skills whose descriptions would match the
   same request: neither gets chosen reliably. Say which should win and what the
   other's description should say instead. Then follow every skill a skill names:
   does it exist, does it accept the handover, and is there a door it should
   offer and does not? A skill that sends people to exactly one place sends them
   to the wrong one whenever the other place was right.
9. **Does it record why, and what not to do?** A procedure with no reasons gets
   "simplified" back into a bug.
10. **Altitude.** A skill that restates a tool's help text adds nothing; a skill
    that runs to many screens is usually two skills, or one skill and an article.
11. **Does it work where it actually runs?** Two questions the rest of this list
    misses, and the source of the worst bugs, because both fail silently.
    **Anchoring:** does the skill name the thing it operates on, and is every
    path in the body anchored to it? A bare `data/` resolves against whatever
    directory the person launched from, which is rarely the one meant, and a
    search of a directory that is not there returns nothing rather than an
    error — so the skill reports "nothing found" for something that is
    documented. **The degraded path:** where a skill splits into "if a shell is
    available" and "otherwise", check that the fallback does the same job. A
    wrapper script usually resolves its own location; the hand-written fallback
    has nothing to resolve it. If the deployment's default stage is the one
    without a shell, the fallback *is* the main path, and it is the half nobody
    tests.

## How to report it

**Lead with the single change that would make the most difference**, and say
why. A list of twelve findings gets skimmed; one change gets made.

**A check's position is not a finding's severity.** The list above is the order
to *look*, not the order to report. Rank what you found: first anything that
makes a skill give a confidently wrong answer, then anything that blocks work,
then documentation debt. The cheap checks fire most often, so counting findings
will always point you at the wrong headline.

**One finding may span the whole set.** If the same defect sits in four skills it
is one finding about the set, not four-twelfths of your budget — state it once,
above the per-skill groups, and list where it lands.

**Group by skill, and quote the line you mean.** "The description is weak" is
not actionable. "`description: Ticket utilities` would not match *what closed
last week* — try …" is.

**Say what to do, not just what is wrong.** For each finding, the fix in one
sentence: the replacement description, the article to write, the line to delete.

**Three findings per skill at most**, and say how many you left out. Aim the
list at an hour of work, not a project.

**Offer to make the changes**, and make only the ones agreed. Do not rewrite
somebody's skill because you would have written it differently — the test is
whether it will be chosen, whether it will still be right in six months, and
whether it puts its facts where they can be corrected.
