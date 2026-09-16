# Knowledge base for GAH

Created by `gah init-kb`. This is the **context** half of a GAH deployment: what
your organization knows, written so an agent can answer from it — and improve it
while people work.

It is deliberately plain. Markdown files in git, four skills, five small
scripts. No site generator, no database, no accounts, no build step. A person
can read every file in it, and so can the agent.

```
articles/     the knowledge, one Markdown file per article
templates/    the article template new articles are written from
skills/       the four skills that make the loop work (loaded from here)
bin/          wrapper scripts (.sh and .ps1) the skills call:
              kb-search, kb-new, kb-gap, kb-status, kb-propose, kb-sync
prompts/      /kb — the question people type most
```

## The loop this exists for

1. Someone asks the agent about a site, a device, a convention.
2. The agent **answers from these articles**, and cites which ones.
3. When the answer is thin or missing, it says so and **records the gap** — a
   stub article with `status: gap`, so the gap is a named thing rather than a
   vague sense that the documentation is bad.
4. Whoever hit the gap **fills it from the agent**, in the moment, without
   leaving what they were doing.
5. Every later question, by anyone, is answered from the better version.

Gaps accumulate in demand order: ask for something twice and its `requests`
count goes up, which is a far better guide to what to write next than any
documentation plan drawn up in advance.

## Start here

**1. Put it under source control and push it.**

```bash
git init && git add . && git commit -m "Initial knowledge base"
```

A knowledge base on one laptop helps one person. Push it somewhere your team
can reach; the loop above only compounds if corrections reach everyone.

**2. Point a session at it.**

```powershell
$env:GAH_KB_DIR = 'C:\dev\my-org-kb'      # Windows
```

```bash
export GAH_KB_DIR=~/dev/my-org-kb          # Linux/macOS
```

The launcher loads `skills/` and `prompts/` from here when that is set. On a
shared host an administrator sets `KB_REPO` in the per-user manifest instead and
the launcher keeps the clone current — see [docs/KB.md](https://github.com/charliesolomon/gah/blob/main/docs/KB.md).

**3. Ask it something you already know the answer to.**

The reply should be "nothing here covers that yet" and an offer to record it.
That is the system working: an empty knowledge base is honest about being empty.
Say yes, and you have your first gap.

**4. Write the first article.**

Whatever you explain most often to a new colleague. Ask the agent — `kb-article`
walks it, and the one example article here shows the shape.

## What belongs here

The documented facts of your estate, and the reasoning behind them:

| | For example |
|---|---|
| **People and structure** | roles, who escalates to whom, which site someone works from |
| **Sites and networks** | locations, topology, addressing, naming conventions |
| **Equipment** | what is deployed, model by model — and the standing exceptions, with the reason each one exists |
| **Working conventions** | how your ticket system is actually used, priority definitions, escalation expectations |
| **Time-based facts** | the recurring annual calendar, baselines worth comparing against |

The exceptions matter more than the inventories. Anyone can look up what a
device is; nobody but your team knows why that one site is on the older firmware
and what breaks if someone "fixes" it.

## What does not belong here

- **Credentials.** Ever. This repository is readable by everyone the agent runs
  for, and articles are quoted back into conversations.
- **Anything that drifts and can be derived.** A count, a live inventory, a
  roster: prefer a script that regenerates it over a list maintained by hand.
  A stale list quoted confidently is worse than no list at all. If a fact has a
  system of record, the article should say which system and how to ask it.
- **Procedures your team follows.** Those are skills, in your skills
  repository. This is what is *true*; a skill is what your team *does*.

## Publishing model

By default a change is **proposed**: the agent commits it on a branch, pushes,
and hands back the URL to open the pull or merge request. Nothing reaches `main`
without a person.

Teams that find the review step is friction rather than safety can set
`KB_PUBLISH=direct` and land changes on `main` immediately — git history is then
the audit trail and `git revert` the rollback. That is a real choice made by a
real team after their review step turned into a rubber stamp; it is worth making
deliberately rather than drifting into. See `skills/kb-propose/SKILL.md`.

## The three stages of trust

The loop does not need write access to be useful, and the skills are split so a
deployment can grant capability in stages:

| Stage | Skills | Tools needed | What people get |
|---|---|---|---|
| **Read** | `kb-search`, `kb-curate` | none beyond the default allowlist | the estate becomes answerable |
| **Draft** | `+ kb-article` | still none — drafts are ordinary file writes | gaps get filled where they are found |
| **Publish** | `+ kb-propose` | a shell (`GAH_ALLOW_TOOLS=powershell` or `bash`) | corrections reach the team |

Running for a month at **Read** is a perfectly good deployment. Most of the
value in the concept paper's Stage 7 is available before anyone is trusted with
a `git push`.
