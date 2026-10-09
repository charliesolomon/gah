# Knowledge base for GAH

Created by `gah init-kb`. This repository holds what your organization knows,
written so an agent can answer from it, and improve it while people work. It is
plain Markdown in git, four skills and a few small scripts: no site generator,
no database, no build step.

```
articles/     the knowledge, one Markdown file per article
templates/    the template new articles start from
skills/       the four skills that make the loop work
bin/          scripts the skills call (.sh and .ps1):
              kb-search, kb-new, kb-gap, kb-status, kb-propose, kb-sync
prompts/      /kb, the question people type most
```

## The loop

1. Someone asks the agent about a site, a device, a convention.
2. The agent **answers from these articles** and cites them.
3. When the answer is thin or missing, it **records the gap**: a stub article
   with `status: gap`. Asking again raises its `requests` count, so gaps are
   ordered by real demand.
4. Whoever hit the gap **fills it with the agent**, without leaving their work.
5. Every later question is answered from the better version.

## Start here

There are 4 steps; you need git.

**1. Put it under source control and push it.**

```bash
git init && git add . && git commit -m "Initial knowledge base"
```

Push it somewhere your team can reach; any git host works. The loop only pays
off when corrections reach everyone.

**2. Point a session at it.**

```powershell
$env:GAH_KB_DIR = 'C:\dev\my-org-kb'      # Windows
```

```bash
export GAH_KB_DIR=~/dev/my-org-kb          # Linux/macOS
```

On a shared host, the administrator sets `KB_REPO` in your manifest instead. See
[docs/KB.md](https://github.com/charliesolomon/gah/blob/main/docs/KB.md).

**3. Ask it something you already know.** The reply should be "nothing here
covers that yet" and an offer to record it. Say yes: that is your first gap.

**4. Write the first article.** Pick whatever you explain most often to a new
colleague, and ask the agent; `kb-article` walks it, and the example article
shows the shape.

## What belongs here

Facts about your estate, and the reasons behind them:

| | For example |
|---|---|
| **People and structure** | roles, who escalates to whom, which site someone works from |
| **Sites and networks** | locations, topology, addressing, naming conventions |
| **Equipment** | what is deployed, and the standing exceptions with the reason for each |
| **Working conventions** | how your ticket system is really used, priority definitions |
| **Time-based facts** | the recurring annual calendar, baselines worth comparing against |

The exceptions matter more than the inventories: nobody but your team knows why
one site is on older firmware and what breaks if someone "fixes" it.

**What does not belong here:**

- **Credentials.** Ever. Articles are quoted back into conversations.
- **Anything that drifts and can be derived.** Name the system of record and
  how to ask it, rather than keeping a count, inventory or roster by hand.
- **Procedures.** Those are skills, in your skills repository. This is what is
  *true*; a skill is what your team *does*.

## Publishing and trust

The skills are split so a deployment can grant capability in stages:

| Stage | Skills | Tools needed | What people get |
|---|---|---|---|
| **Read** | `kb-search`, `kb-curate` | none beyond the defaults | answers about your estate |
| **Draft** | `+ kb-article` | still none: drafts are ordinary file writes | gaps filled where they are found |
| **Publish** | `+ kb-propose` | a shell (`GAH_ALLOW_TOOLS=powershell` or `bash`) | corrections reach the team |

By default a change is **proposed**: committed on a branch and pushed, with a
link to open the pull or merge request. `KB_PUBLISH=direct` lands changes on
`main` immediately instead, with git history as the audit trail. See
`skills/kb-propose/SKILL.md`.

## Keeping the tooling current

```bash
gah update-kb <this directory>
```

This refreshes the scripts, skills, templates and prompts, and never touches
`articles/`. Commit first: the update overwrites shipped files and leaves
`git diff` as the review. Put customisations in your skills repository instead;
a skill of the same name there wins over this one.
