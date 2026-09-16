---
name: kb-curate
description: Report what the knowledge base holds and what it owes - the questions people asked that nothing answers, ordered by how often they were asked, and the articles nobody has verified in a long time. Use when someone asks what to document next, how the KB is doing, what is missing, what is stale, or for a documentation backlog. Aliases - what should I write, KB status, what is missing, documentation backlog, kb gaps
allowed-tools: Read, Grep, Glob
---

# What to write next

A knowledge base fails in two directions: it misses what people need, and it
keeps saying things that stopped being true. This skill reports both, so the
next hour spent on documentation is spent on the thing that costs the team most.

No shell is needed. Where one is available,
`bin/kb-status.sh` (or `bin\kb-status.ps1`) produces all of this in one pass;
otherwise read the frontmatter of the files under `articles/` and work it out —
there will not be many.

## The backlog is the gap list

Every question the knowledge base could not answer is recorded as a stub under
`articles/gaps/` with `status: gap` and a `requests` count. **Order by
`requests`, descending.** That count is the number of times a real person needed
the thing while doing real work, which is a better guide to what to write than
any documentation plan drawn up in advance. A gap asked four times beats a
tidy-looking hole in the structure that nobody has ever hit.

Report it as work, not as a table dump:

> Three things are worth writing this week. "Which switch serves the gym" has
> been asked four times — that is the one. Then the guest wireless exception
> (twice), and the printer VLAN (twice, both by Sam, which probably means one
> conversation).

**Name who would know**, where it is obvious from the gap or the articles
around it. The obstacle is rarely the writing; it is finding the person.

**Give the link alongside the path** for anything you name — `kb-status` prints
the forge page under each gap and each stale article. Someone reading a backlog
is deciding what to pick up, and a link is the difference between deciding now
and deciding later. Pass on what the wrapper printed; never construct one.

## Gaps that should not be there

Some gaps will be recorded that are not gaps at all: a general technology
question that happened to be asked here. `kb-search` is told not to record
those, but judgement in the moment is imperfect and the cost is silent — a
backlog padded with Linux questions stops being a signal about *your*
documentation, which is the one property that makes it worth ordering by
demand.

Apply the same test the question should have faced:

> Would an equally competent engineer at a different organization give the same
> answer?

If yes, the stub does not belong. Two tells: it names a public technology and
nothing of yours, or the answer would be identical at any other organization.
*"How do I use systemd timers"* is not a gap. *"Which of our hosts use the
overnight patch window"* is.

**Report those separately from the backlog, and offer to delete them.** Do not
delete silently — someone recorded it for a reason, and the phrasing may hide an
organizational question inside a general one ("how do I use systemd timers"
might mean "what is our convention for scheduled jobs"). Ask which it was; if it
is the organizational one, the fix is to reword the stub rather than remove it.

## Stale articles

An article whose `updated` is more than about six months old is a fact that
nobody has checked since. That is not automatically wrong, and the report
should not treat it as such — but it is where a confident wrong answer will come
from, and a five-minute verification is cheap.

Prioritise stale articles that describe things that **change**: firmware,
inventories, people, addressing. A stale article about a naming convention is
probably still fine.

## Is this copy even current?

Everything above is computed from the clone on this machine. If someone merged
an article an hour ago and nobody has pulled, the report is honest about a
knowledge base that no longer exists. When the answer matters — before telling
someone what is missing, or before starting on the top gap — bring the copy up
to date first (`kb-propose` owns that: `bin/kb-sync.sh`, `.\bin\kb-sync.ps1`).

## Health problems worth raising

- Articles with no `description` — they will not be found by search, so they
  might as well not exist.
- Articles with no `updated`, or a malformed one — they can never be reported as
  stale, so they rot invisibly.
- `status: draft` articles that have been drafts for months — either somebody
  should confirm them or they should be deleted.
- The example article that shipped with the scaffold, if it is still there. It
  is invented, and it will eventually be quoted to someone as though it were
  true.
- Gap stubs that survived the article answering them. A stub left behind keeps
  telling searchers that nobody has written this down, while the article sits
  two directories away.

## How to report

**Lead with the single most useful next action**, not with statistics.
If the top item is a gap that does not belong, say that first — clearing it
costs a second and the backlog reads honestly afterwards. "Four
articles, two gaps" tells nobody what to do.

**Three items, not fifteen.** A backlog nobody can finish is a backlog nobody
starts. Say how many remain after the three.

**Offer to start.** The gap at the top of the list is one handover away from
being an article: `kb-article` writes it, `kb-propose` puts it up. If the person
has ten minutes and knows the answer, that is the whole loop closed in one
conversation.

## What not to do

- Do not invent gaps. The list comes from questions people actually asked.
- Do not nag about volume. A knowledge base with nine good articles is healthy;
  one with ninety unverified ones is not.
- Do not propose a documentation project. The entire point of this design is
  that documentation happens as a by-product of support work, not as a sprint
  that competes with it.
