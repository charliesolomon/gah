---
name: kb-article
description: Write a new knowledge base article or update an existing one, from what someone just told you or from what a session established. Use when someone wants to document something, answer a recorded gap, correct an article that is out of date, or write down what they just worked out. Aliases - document this, write it up, add to the KB, update the article, capture this
allowed-tools: Read, Write, Edit, Grep, Glob
---

# Writing a knowledge base article

The hard part of a knowledge base is never the writing. It is that the person
who knows the thing is busy, and writing it down competes with the work in front
of them. So the whole job of this skill is to make capturing a fact take a
minute rather than an afternoon.

You need no shell for any of this. Articles are ordinary Markdown files; create
and edit them directly.

## Before writing: look for the article that already exists

Search `articles/` first, every time. Three outcomes:

| What you find | What to do |
|---|---|
| An article on the subject | **Update it.** A second article on the same subject is how a knowledge base starts to contradict itself |
| A gap stub (`status: gap`) | **Answer it in place**, then move the file out of `articles/gaps/` into the area it belongs to — or write the article where it belongs and delete the stub. Either way the stub must not survive, or it keeps answering searches with "nobody has written this down" |
| Nothing | Create a new article |

## Creating one

Copy `templates/article.md`, or where a shell is available run the wrapper,
which writes the header for you and refuses to clobber an existing file:

```bash
bin/kb-new.sh --title "Wireless at the North site" --area network --tags network,wireless
```

```powershell
.\bin\kb-new.ps1 -Title "Wireless at the North site" -Area network -Tags network,wireless
```

Both flag spellings work in both wrappers; the title must be one quoted
argument.

The frontmatter contract, in full, is in `articles/README.md`. The three fields
that people get wrong:

- **`description`** — one sentence, and it is what search matches on. "Access
  points, firmware and the two standing exceptions" earns its place; "Wireless
  documentation" does not.
- **`status`** — `current` when the facts came from someone who knows and has
  just told you; `draft` when you assembled them yourself from a session, a
  ticket or an inference, and nobody has confirmed them. Be honest here: a
  `current` article that nobody checked is exactly the thing that poisons
  trust.
- **`updated`** — the date the *facts* were verified, not the date you typed.
  If you are writing from what someone just told you, that is today. If you are
  tidying the prose of a two-year-old article, it is not.

## What to write

**Lead with the answer.** The first two sentences should satisfy the person who
went looking. Everything else is elaboration.

**Chase the exception, and the reason for it.** This is the single most valuable
thing you can extract from a person, and they will not volunteer it. Ask:

> Is there anywhere this is not true? And do you know why it is like that?

"All the sites run 7.x except the North gym" is useful. "…because the gym's
older PoE switch drops the link at 2.5G, and it cost someone an afternoon before
anyone connected the two" is the sentence that saves the next person. A rule
without its reason gets "fixed" by someone helpful.

**Write what a competent newcomer would get wrong**, not what a manual would
say. Skip the general technology; keep the local specifics.

**Do not copy in anything that drifts.** Live inventories, counts, rosters: name
the system of record instead. "Current AP inventory: the controller. This
article covers only what is unusual." A stale list quoted confidently is worse
than no list.

**Record provenance.** End with how the facts were established and when:
`*Verified: against the controller, 2026-09-15*` or `*Verified: from Dana in the
North office, 2026-09-15*`. The next reader needs to know how much to trust it.

**Keep it short.** Two screens. If it is longer, it is two articles.

## Updating one

- Change the facts, and change `updated` to today.
- If it was `draft` and someone who knows has now confirmed it, set `current`.
- **Preserve the exceptions** unless you have been told they are gone. An
  exception that disappears from an article is a trap left for someone.
- Say in the commit message what changed and why — `kb-propose` will ask.

## Never write

- **Credentials, keys, tokens, or passwords.** Not even "temporarily". This
  repository is read by everyone the agent runs for, and articles are quoted
  back into conversations.
- Personal data beyond role and work contact details.
- Anything you were told in confidence without checking it may be written down.
- A procedure your team follows — that is a skill, in the skills repository.
  This is what is *true*; a skill is what your team *does*.

## Finishing

Show the person what you wrote — the whole article if it is short, the changed
sections if not. Two reasons: they are the one who knows whether it is right,
and seeing their knowledge come back as a clean article is what makes them do
it again next time.

Then offer to put it up: hand over to `kb-propose`. A written article that is
never proposed helps nobody but the person who wrote it.
