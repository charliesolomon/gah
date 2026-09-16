# The knowledge base

GAH ships an agent, a deployment mechanism and policy controls. What makes it
useful to *your* organization is two bodies of material that only you can write:

| | Lives in | What it is |
|---|---|---|
| **Skills** | your skills repository ([SKILLS.md](SKILLS.md)) | what your team **does** — procedures |
| **Knowledge base** | your knowledge base repository, this document | what is **true** here — facts |

A skill without context is a generic procedure. Context without skills is a wiki
nobody opens. The pair is what turns a fluent general assistant into one that can
answer *"who owns this, where is it, and what did we decide about it last year?"*

**The knowledge base is optional.** A deployment without one works exactly as
before. Set it up when you have something to put in it, which in practice means
as soon as the first person asks the agent a question about your estate.

## Why this rather than a wiki

Most teams already have a wiki, and most of those wikis are in the condition
described in the concept paper: burned someone once, so it stopped being
consulted, so it stopped being corrected, so it stays wrong.

This design attacks that at one specific point. The moment a technician's
question goes unanswered is the moment they are most motivated to fix the
documentation — and it is also, normally, the moment fixing it is most expensive,
because it means stopping, opening another tool, and writing. Here it is the next
sentence in the conversation they are already having.

```
        someone asks  ──►  the agent answers from the articles, and cites them
                                        │
                     ┌──────────────────┴───────────────────┐
              answered fully                      thin, wrong, or missing
                     │                                      │
                  done                        the gap is recorded, with a count
                                                            │
                                            "I can write that now" ──► article
                                                            │
                                                proposed as a normal change
                                                            │
                     ◄──────────  every later question is answered from it
```

Two things fall out of that shape, and they are the whole argument:

- **Documentation becomes a by-product of support work** rather than a project
  that competes with it. Nobody schedules a documentation sprint that then gets
  cancelled when something breaks.
- **The gaps get prioritised by real demand.** The articles that get written are
  the ones people actually needed while solving actual tickets, which beats any
  roadmap drawn up in advance about what documentation *would* be valuable.

## Creating one

```bash
./bin/gah init-kb ../my-org-kb          # PowerShell: .\bin\gah.ps1 init-kb ..\my-org-kb
```

Files only — no remote, no network, nothing to configure first:

```
articles/
  README.md              the frontmatter contract and how to write one
  example-article.md     one worked example; delete it once you have your own
templates/article.md     what a new article starts from
skills/                  kb-search, kb-article, kb-propose, kb-curate
bin/                     kb-search, kb-new, kb-gap, kb-status, kb-propose (.sh and .ps1)
prompts/kb.md            /kb <question>
```

Then `git init`, commit, and push it somewhere your team can reach. The loop only
compounds if corrections reach everyone.

Nothing about the shape is enforced by GAH. Rename `articles/`, drop the scripts,
restructure it entirely — the skills describe the conventions rather than
depending on code that would break. What the tooling does assume is the
frontmatter contract in `articles/README.md`, because staleness and gap counting
are computed from it.

## Pointing GAH at it

| Variable | Value | Used by | Situation |
|---|---|---|---|
| `GAH_KB_DIR` | a **local directory** | `bin/gah`, `bin/gah.ps1`, the packaged Windows launcher | one person, one machine |
| `KB_REPO` | a **git URL** | `deploy/host/gah-launch` | shared host, many users |

On a workstation — the Windows case, which is where most of this gets used:

```powershell
$env:GAH_KB_DIR = 'C:\dev\my-org-kb'
$env:GAH_SKILLS_DIR = 'C:\dev\my-org-skills\skills'
.\bin\gah.ps1
```

```bash
GAH_KB_DIR=~/dev/my-org-kb GAH_SKILLS_DIR=~/dev/my-org-skills/skills ./bin/gah
```

On a shared host, set `KB_REPO` in the per-user manifest
(`deploy/host/users.d/<user>.conf`) and the launcher keeps the clone at
`~/.gah/kb` current.

**The knowledge base carries its own skills**, so setting one of those variables
is also what grants `kb-search`, `kb-article`, `kb-propose` and `kb-curate`. A
deployment without a knowledge base does not have skills that refer to one — and
a skill of the same name in the shared or personal set wins, so an organization
that outgrows the scaffolded versions can simply write its own.

### From an installed package

The packaged Windows launcher honours `GAH_KB_DIR` too, but only as a **local
git clone the person owns** — not as an archive the way it fetches skills. That
is deliberate: the knowledge base is the one thing the agent writes to, and an
archive cannot be committed from. Reading and drafting then work with what the
package already ships; proposing needs `git` on `PATH`.

Scaffolding is not available from an installed package, because the templates it
copies are not shipped there. `gah init-kb` typed at a packaged launcher says so
and stops, rather than passing the words to the model as a question. An
administrator creates the knowledge base once from a checkout, pushes it, and
people clone it — the same shape as the skills repository.

### The one checkout the agent writes to

The shared skills checkout is hard-reset on every launch: the repository is
authoritative and local edits never survive. **The knowledge base is not**, and
cannot be — a draft article or a branch waiting to be pushed is exactly the work
in progress a reset would destroy.

So `gah-launch` fast-forwards it only when the checkout is clean and on the
default branch, and otherwise leaves it alone and says why:

```
gah: knowledge base has uncommitted changes — left as it is (propose them with kb-propose)
gah: knowledge base is on branch 'kb/gym-switch' — left as it is (finish or push it, then switch back to main)
```

Both of those are normal, not errors. Someone is mid-article.

## What counts as a knowledge base question

A session is rarely only about the estate. Someone writing a script against a
server asks a general question about the technique and an organizational one
about the window, the mirror, the naming convention and the proxy — often in one
sentence. So `kb-search` applies one test before it does anything:

> Would an equally competent engineer at a different organization give the same
> answer?

Yes means general knowledge: answer it, touch nothing. No means a fact about
this organization: search, cite, and record a gap if nothing covers it.

The three actions have deliberately different thresholds, because their costs
differ by orders of magnitude. **Searching** costs a grep, so it happens
whenever a question might touch something documented. **Citing** costs nothing.
**Recording a gap** creates a permanent file that answers future searches and
takes a place in the backlog — so it happens only for organizational questions.
A backlog padded with general technology questions stops being a signal about
your documentation, and that signal is the whole reason to order by demand.

For the ambiguous middle — which is the common case in a working session — the
skill answers from general knowledge and then invites: *"that is the standard
answer; if your team does it differently, tell me and I will write it down."*
That captures the organizational fact at the moment it is cheapest without
creating a file on a guess. `kb-curate` reports any gap that looks like a
general technology question, so the backlog self-cleans when one leaks through.

If a session should not involve the knowledge base at all, do not give it one:
the skills load only when `GAH_KB_DIR` (or `KB_REPO`) is set, so a shortcut or
alias for development work that omits it gets no `kb-*` skills.

## Granting capability in stages

The skills are split along the line that matters, so a deployment can let people
read long before it lets them publish. **The enforcement is the policy pack's
tool allowlist** (`GAH_ALLOW_TOOLS`), not the `allowed-tools` header in a skill —
upstream reads only `name` and `description` from that header, so in GAH it
documents intent and travels with the skill, while the deployment decides.

| Stage | Skills that work | Needs | What people get |
|---|---|---|---|
| **Read** | `kb-search`, `kb-curate` | nothing — `read`, `grep`, `find`, `ls` are already in the default allowlist | the estate becomes answerable, and gaps get recorded |
| **Draft** | `+ kb-article` | still nothing — `write` and `edit` are in the default allowlist too | gaps get filled where they are found; a person commits |
| **Publish** | `+ kb-propose` | a shell: `GAH_ALLOW_TOOLS="powershell"` or `"bash"` (git) | corrections reach the team without a detour |

Running at **Read** for a month is a perfectly good deployment, and it matches
the rollout in the concept paper: prove it reads before trusting it to write. The
gap counter still accumulates, so when you do open up publishing there is already
a demand-ordered backlog waiting.

Note what the middle row means: **an agent can draft an article with no shell at
all**, because writing a Markdown file is an ordinary `write`. The only thing a
shell buys is `git`.

## Publishing model

Default is **propose**: `kb-propose` commits on a branch, pushes, and hands back
the URL that opens the pull or merge request. Nothing reaches the default branch
without a person, and the commit carries the git identity of whoever ran the
session, so a change is attributable to them rather than to a shared robot
account.

Set `KB_PUBLISH=direct` for the other model: commit to the default branch and
push immediately, with git history as the audit trail and `git revert` as the
rollback. That is a real choice made by a real team after their review step had
become a rubber stamp and was costing more than it caught. It is a decision for
whoever owns the knowledge base; the skill will not make it in the moment.

Only `articles/` is ever staged. A change to the scripts or the skills is a
change to the tooling and gets its own review rather than a ride along with an
article.

## What goes in it

The documented facts of your estate — and, more valuably, the reasoning behind
them. Sites and networks, equipment, conventions, people and roles, the recurring
calendar. Full guidance is in the scaffold's `README.md` and `articles/README.md`.

Three rules are worth repeating here, because they are the ones that decide
whether the thing stays trustworthy:

1. **No credentials, ever.** Articles are quoted back into conversations, and a
   secret committed once survives in git history after the file is fixed.
2. **Nothing that drifts and can be derived.** Live inventories, counts, rosters:
   name the system of record instead of copying it. A stale list quoted
   confidently is worse than no list.
3. **Record the exception and its reason.** "The gym APs stay on 6.9 because the
   older PoE switch there drops the link at 2.5G" is the sentence that saves the
   next person an afternoon. A rule without its reason gets "fixed" by someone
   helpful.

## Verifying it

```bash
make check-kb
```

Scaffolds a knowledge base into a temp directory and drives the whole loop
against a local bare repository: search, a miss, a recorded gap, the same
question again (the count rises rather than a second stub appearing), an article,
a proposal that lands on a branch with the default branch untouched, and the
direct-publish path. It also asserts that the launcher really passes the
knowledge base's skills to the harness, and runs the PowerShell twins when
`pwsh` is present. No network, no keys.
