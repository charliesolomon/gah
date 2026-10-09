# The knowledge base

The knowledge base is an optional git repository of what is **true** at your
organization: sites, equipment, conventions, and the reasons behind them.
Skills ([SKILLS.md](SKILLS.md)) are what your team **does**. This page is for
whoever sets the knowledge base up and decides what the agent may do with it.

**Setting one up takes 3 steps:** create it, push it where your team can reach
it, and point gah at it. You need a built gah checkout and git. Reading and
drafting work with gah's default tools; publishing changes also needs a shell
tool and git ([stages](#grant-capability-in-stages)).

A deployment without a knowledge base works exactly as before. Set one up when
people start asking the agent questions about your estate.

## Why: the loop

A wiki goes stale because fixing it means stopping work, opening another tool
and writing. Here the fix is the next sentence in the conversation the person is
already having:

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

- **Documentation becomes a by-product of support work**, not a project that
  competes with it.
- **Gaps are ordered by real demand:** each repeat question raises a gap's
  count, so the articles written first are the ones people needed.

## 1. Create it

```bash
./bin/gah init-kb ../my-org-kb          # PowerShell: .\bin\gah.ps1 init-kb ..\my-org-kb
```

Files only: no remote, no network.

```
articles/
  README.md              the frontmatter contract and how to write an article
  example-article.md     one worked example; delete it once you have your own
templates/article.md     what a new article starts from
skills/                  kb-search, kb-article, kb-propose, kb-curate
bin/                     kb-search, kb-new, kb-gap, kb-status, kb-propose, kb-sync (.sh and .ps1)
prompts/kb.md            /kb <question>
```

You can restructure it freely; the skills describe conventions rather than
depend on code. The one thing the tooling relies on is the frontmatter contract
in `articles/README.md`, because staleness and gap counts come from it.

Scaffolding needs a checkout: an installed package does not ship the templates,
and `gah init-kb` there says so.

## 2. Host it

`git init`, commit, and push it somewhere your team can reach. The loop only
pays off when corrections reach everyone.

Every way of running gah uses the knowledge base as a plain git clone, so it can
live on any git host. Links back to articles are built for GitHub and GitLab
([links](#links-back-to-the-articles)).

## 3. Point gah at it

| How gah runs | Setting | Value |
|---|---|---|
| gah checkout or per-person package | `GAH_KB_DIR` | a local git clone the person owns |
| Shared Linux host | `KB_REPO` in each user's manifest | a git URL; the launcher keeps the clone at `~/.gah/kb` current |

```powershell
$env:GAH_KB_DIR = 'C:\dev\my-org-kb'; .\bin\gah.ps1
```

```bash
GAH_KB_DIR=~/dev/my-org-kb ./bin/gah
```

Setting it is also what grants the four `kb-*` skills: a session without a
knowledge base has none. A shared or personal skill of the same name wins over
the scaffold's, so you can replace them with your own.

A package fetches the team's skills as an archive, but the knowledge base must
be a real clone: it is the one repository the agent writes to.

## Grant capability in stages

The skills are split so a deployment can let people read long before it lets
them publish. The policy's tool allowlist (`GAH_ALLOW_TOOLS`) is what enforces
this; a skill's `allowed-tools` header only documents intent.

| Stage | Skills that work | Needs | What people get |
|---|---|---|---|
| **Read** | `kb-search`, `kb-curate` | nothing: `read`, `grep`, `find`, `ls` are in the default allowlist | answers about your estate, and recorded gaps |
| **Draft** | `+ kb-article` | still nothing: `write` and `edit` are default too | gaps filled where they are found; a person commits |
| **Publish** | `+ kb-propose` | a shell (`GAH_ALLOW_TOOLS=powershell` or `bash`) for git | corrections reach the team directly |

A month at **Read** is a good first deployment. The gap counts still build up,
so a demand-ordered backlog is waiting when you open up publishing.

## Publishing model

By default `kb-propose` commits on a branch, pushes, and hands back the link to
open a pull or merge request. Nothing reaches the default branch without a
person, and the commit carries the git identity of whoever ran the session.

`KB_PUBLISH=direct` commits to the default branch and pushes at once, with git
history as the audit trail and `git revert` as the rollback. Choose it
deliberately, for a team whose review step has become a rubber stamp.

Only `articles/` is ever staged. Changes to the scripts or skills get their own
review.

## What goes in it

Facts about your estate, and the reasons behind them. Full guidance is in the
scaffold's `README.md` and `articles/README.md`. Three rules keep it
trustworthy:

1. **No credentials, ever.** Articles are quoted into conversations, and a
   secret stays in git history after the file is fixed.
2. **Nothing that drifts and can be derived.** Name the system of record instead
   of copying a live inventory, count or roster.
3. **Record the exception and its reason.** "The gym APs stay on 6.9 because the
   older PoE switch there drops the link at 2.5G" saves the next person an
   afternoon. A rule without its reason gets "fixed".

## Reference

### What counts as a knowledge base question

`kb-search` applies one test first:

> Would an equally competent engineer at a different organization give the same
> answer?

Yes means general knowledge: answer it, touch nothing. No means a fact about
this organization: search, cite, and record a gap if nothing covers it.

Searching and citing are cheap, so they happen whenever a question might touch
something documented. Recording a gap creates a permanent file, so it happens
only for organizational questions; general ones would drown the demand signal.
In the ambiguous middle, the skill answers from general knowledge and offers to
write down how your team does it differently. `kb-curate` reports gaps that look
like general questions.

To keep the knowledge base out of a session entirely (development work, say),
start it without `GAH_KB_DIR` or `KB_REPO`.

### Updating the scaffold

`init-kb` refuses a non-empty directory, so tooling fixes arrive with
`update-kb`:

```bash
./bin/gah update-kb ~/dev/my-org-kb          # PowerShell: .\bin\gah.ps1 update-kb ..\my-org-kb
```

- It rewrites `bin/`, `skills/`, `templates/` and `prompts/` with the shipped
  files, and **never touches `articles/`**. Files of your own there survive.
- It needs a clean tree: `git diff` is the review, `git checkout` the undo. A
  local edit to a shipped file is overwritten and shows in that diff; put
  customisations in your skills repository instead.
- A session started from a checkout says when the tooling is behind:

  ```
  gah: this knowledge base's scripts and skills are at 9f2ab31, behind the scaffold in this checkout (17dd00c5)
       refresh them with:  gah update-kb ~/dev/my-org-kb
  ```

  The marker in `.kb-scaffold` is git's tree hash for `templates/kb-repo`, so it
  changes only when the scaffold does.

### The one checkout the agent writes to

The shared host hard-resets the skills checkout on every launch. It cannot do
that to the knowledge base, where a draft article or an unpushed branch is work
in progress. So `gah-launch` fast-forwards the knowledge base only when it is
clean and on the default branch, and otherwise leaves it and says why:

```
gah: knowledge base has uncommitted changes — left as it is (propose them with kb-propose)
gah: knowledge base is on branch 'kb/gym-switch' — left as it is (finish or push it, then switch back to main)
```

Both are normal: someone is mid-article.

### Links back to the articles

Search hits, the backlog, new articles and proposals link to the article when
the knowledge base has an `origin` remote (ssh or https; credentials and port
are dropped). `kb-propose` links the pushed branch so a reviewer reads the
article, not a diff. No remote means no link.

GitHub and GitLab spell file URLs differently, and a self-hosted forge under an
uninformative name is assumed to be GitLab. Set `KB_WEB_STYLE=github` or
`gitlab` where that guess is wrong. The skills never build a link themselves: a
guessed URL that 404s is worse than a path.

### Dates

Staleness reporting rests on each article's `updated` field, so it must be the
real date. The policy pack states today's date in the system prompt, the
scripts fill the field from the system clock, and `kb-status` flags a future
date or one older than the file.

### Verifying it

```bash
make check-kb
```

Scaffolds a knowledge base in a temp directory and drives the whole loop against
a local bare repository: search, a miss, a recorded gap, the same question again
(the count rises), an article, a proposal on a branch, and direct publishing. It
also checks that the launcher passes the knowledge base's skills, and runs the
PowerShell versions when `pwsh` is present. No network, no keys.
