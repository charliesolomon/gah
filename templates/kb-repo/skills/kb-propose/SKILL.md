---
name: kb-propose
description: Put a knowledge base change in front of the team - commit it on a branch, push it, return the link that opens the pull or merge request - and bring this copy up to date once something is merged. Use when someone asks to publish, submit or share a documentation change, immediately after an article has been written or updated, and when someone asks to pull, sync or refresh the knowledge base. Aliases - publish it, submit the article, open a PR for this, push the KB change, pull latest, sync the KB, update my copy
allowed-tools: Read, Bash(git:*), Bash(./bin/kb-propose.sh:*), Bash(bin/kb-propose.sh:*)
---

# Proposing a knowledge base change

This is the step that turns one person's knowledge into the team's. Everything
before it helps the person who was already in the conversation.

It is also the only skill here that touches git, so it owns both ends of that:
sending a change out, and bringing merged changes back in.

**This skill needs a shell.** It is the only one of the four that does, and a
deployment may deliberately not grant one — reading and drafting work without
it. If no shell tool is available in this session, say so and tell the person
exactly what to run themselves:

```
cd <knowledge base> && git add articles && git commit -m "<message>" && git push
```

That is not a failure. A deployment that lets people read and draft but not
publish is a normal stage, and the draft is on disk either way.

## The normal path

Run the wrapper — it stages only `articles/`, checks the git identity, commits,
pushes, and prints the link:

```bash
bin/kb-propose.sh --message "Document the gym switch exception"
```

```powershell
.\bin\kb-propose.ps1 -Message "Document the gym switch exception"
```

Then give the person the link it printed, and stop. Do not open the request
yourself, do not merge it, and do not keep working on the article afterwards
unless asked.

## What the message should say

One line, what changed and why it matters. It is the first thing a reviewer
reads, and later it is the git history that explains why an article says what it
says.

Good: `Document the gym AP firmware exception and its cause`
Weak: `Update article`, `changes`, `kb update`

Reference the ticket or the conversation that prompted it where there is one.
That is how a reviewer judges whether the facts came from somewhere real.

## Rules

**Only `articles/` is proposed.** The wrapper stages nothing else. If you
changed a script or a skill in this repository, that is a change to the tooling
and belongs in its own commit with its own review — never smuggled in alongside
an article.

**The commit is in the person's name**, using their own git identity. That is
deliberate: a documentation change should be attributable to whoever made it,
not to a shared robot account. If the identity is not set the wrapper stops and
says which two commands to run; relay them rather than working around it.

**One article, one proposal**, unless several genuinely belong together (a new
article plus the gap stub it answers, for instance).

**Check before pushing** that nothing secret is in the diff. Credentials in a
knowledge base article survive in git history even after the file is fixed, so
this is the last cheap moment to catch it. If you see one, stop and say so.

## Direct to main

Some teams set `KB_PUBLISH=direct` (or pass `--direct`), which commits to the
default branch and pushes immediately. Git history is then the audit trail and
`git revert` the rollback.

That is a legitimate choice, usually made after a review step has turned into a
rubber stamp and become pure friction. It is a decision for whoever owns the
knowledge base, **not** one for you to make in the moment. If review is
configured, do not offer to bypass it; if direct is configured, do not add a
branch.

## After it is pushed

Report back with: the article path, the branch, the link, and — if a gap was
answered — that the gap is closed. Then let it go. The loop is finished when the
change is in front of a person; it is not finished when the article is perfect.

## Bringing this copy up to date

Once someone merges the change, **this clone is behind** — including the copy
the author is still working in. Every search in this session and the next one
answers from the stale version until somebody pulls, which is a quiet way for
the loop to stop compounding. Nothing on a workstation does it automatically; a
shared host fast-forwards at launch, which is exactly why the workstation case
gets forgotten.

```bash
bin/kb-sync.sh
```

```powershell
.\bin\kb-sync.ps1
```

It fetches, fast-forwards the default branch, lists what arrived, and deletes
the local `kb/...` branch when its change is already merged — a clone left on a
merged branch is how the next article ends up written on top of the last one.

Run it when someone says the change is merged, when someone asks to pull or
sync, and at the start of a session that is going to rely on the knowledge base
being current. It refuses if there are uncommitted changes under `articles/`,
and says to propose them first; do that rather than working around it.
