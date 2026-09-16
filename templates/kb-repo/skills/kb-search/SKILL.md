---
name: kb-search
description: Answer a question from the organization's knowledge base, citing the articles used, and record a gap when nothing covers it. Use whenever someone asks what WE know or how something HERE is set up - our sites, equipment, naming, people, the standing exceptions and why they exist. NOT for general technology questions, which you answer yourself without touching the knowledge base. Aliases - what do we know about, look it up, is this documented, check the KB, kb
allowed-tools: Read, Grep, Glob, Write, Edit
---

# Answering from the knowledge base

The knowledge base is at `$GAH_KB_DIR` (or `$KB_DIR`), articles under
`articles/`. It holds what **this organization** knows: its sites, equipment,
conventions, and the exceptions that only its own staff can explain.

## First: is this a question for the knowledge base at all?

One test, before anything else:

> **Would an equally competent engineer at a different organization give the
> same answer?**

| | |
|---|---|
| **Yes** | General knowledge. Answer it yourself. Do not search, do not record anything. *"How do I make a systemd timer fire weekly"* has the same answer everywhere |
| **No** | A fact about this organization. This skill applies. *"Which of our hosts still run the old image"* has no answer outside here |

Most sessions contain both kinds, often in one sentence. Someone writing a
patching script asks a general question about the technique and an
organizational one about the window, the mirror, the naming convention and the
proxy. **Search for the organizational part; answer the rest yourself.** Do not
treat the whole request as a knowledge base matter, and do not treat none of it
as one — a script that quietly ignores a documented convention is the failure
that being too shy produces.

The three things this skill does have different costs, so they get different
thresholds:

- **Searching** costs a grep. Do it whenever a question *might* touch something
  documented here.
- **Citing** costs nothing. Do it whenever an article contributed to the answer.
- **Recording a gap** creates a permanent file that will answer future searches
  and take a place in the backlog. Do it only when the test above says the
  question is organizational *and* nothing here answers it.

## How to answer

**1. Search.** Use `grep` and `find` over `articles/`: the frontmatter `title`,
`description` and `tags` first, then the body. Search for the words the person
used *and* the obvious synonyms — someone asking about "wifi at the north
campus" needs the article titled "Wireless at the North site".

Where a shell is available, the wrapper does the same thing with ranking, and
exits 1 when nothing matches:

```bash
bin/kb-search.sh "north site wireless"
```

```powershell
.\bin\kb-search.ps1 "north site wireless"
```

Where a shell is not available, grep is entirely sufficient; this skill does not
need one.

**2. Read the articles you will rely on.** Do not answer from the search
snippet. The snippet is a reason to open the file, not evidence.

**3. Answer the question that was asked**, leading with the fact. Then cite:

> The two gym access points are deliberately on 6.9 — upgrading them takes the
> gym offline because of the older PoE switch there.
> — `articles/network/north-wireless.md`, verified 2026-09-15

**Always give the article path.** A cited answer can be checked and corrected;
an uncited one has to be trusted or ignored.

**Say how old it is** when the article's `updated` date is more than a few
months back, and when it matters. "That was last verified in March" is the
difference between a fact and a guess.

**4. Separate what you know from what they know.** If part of your answer comes
from general knowledge rather than from an article, say which part, plainly:

> The knowledge base does not say which VLAN the printers use. Generally they
> would be on the device VLAN, but nothing here confirms that for this site.

Never present general knowledge as organizational fact. That is the one failure
that makes the whole system untrustworthy: a person who is burned once by a
confident wrong answer stops asking, and the loop dies.

## When nothing here answers it

An organizational question with no answer is not a failure of the tool. It is
the tool doing its most valuable job: finding a documentation gap at the exact
moment someone needed that documentation, which is the only moment anyone is
motivated to fix it.

**Say so plainly**, then judge which of three cases you are in.

### It is clearly organizational — record the gap

Write a stub under `articles/gaps/<slug>.md` with `status: gap`, or increment
`requests` and update `last_requested` if a stub for that question already
exists. Where a shell is available, the wrapper does both and handles the slug
and the counter:

```bash
bin/kb-gap.sh --question "which switch serves the gym?"
```

```powershell
.\bin\kb-gap.ps1 -Question "which switch serves the gym?"
```

**Pass the question as one quoted argument.** Both flag spellings are accepted
by both wrappers, but the question itself must be a single argument — a bare
`--question` with the text elsewhere records a gap called "--question".

Where there is no shell, write or edit the file directly; the format is in
`articles/README.md`. Set `updated` and `last_requested` to **today's date as
the session gives it to you**, never from memory — a stub dated a year early is
how the backlog starts lying about when a question was last asked.

Slug rule when you write it by hand: the question, lowercased, non-alphanumeric
runs replaced by hyphens, trimmed to 60 characters. Match it against existing gap
files first, or the same question accumulates three stubs and the count means
nothing.

Then **offer to close it now**, while the person still has the answer in their
head:

> Nothing here covers the gym switch. I have recorded it as a gap — that is the
> third time someone has asked. If you know the answer, I can write the article
> now and put it up for review; it will take a minute.

If they say yes, hand over to `kb-article`. If they say no, that is fine — the
gap is recorded and the count still rose.

### It is general technology — answer, record nothing

No stub, no counter, no mention of the knowledge base. A gap that reads *"how do
I use systemd timers"* makes the knowledge base look like it owes an answer to
every Linux question, and it takes a place in a backlog that is only useful
while it reflects real demand for **your** documentation.

### It could be either — answer, then invite

This is the common case in a working session, and it deserves its own move.
Answer from general knowledge, then ask whether it is different here:

> On RHEL 9 that runs through `systemctl edit`, which is the standard answer.
> If your team does it differently — a wrapper script, a config-management
> class, a change window — tell me and I will write that down.

That captures the organizational fact at the moment it is cheapest, and creates
a file only when there really is something worth recording. When in doubt, this
is the move: it never pollutes and it never misses.

## When the answer is there but wrong

Someone will tell you an article is out of date. Treat that as the same event as
a gap: a correction offered at the moment it is cheapest to capture. Confirm
what is now true, then hand to `kb-article` to update the article and bump
`updated`. Do not quietly leave a known-wrong article in place.

## What not to do

- Do not answer estate questions from general knowledge and cite nothing.
- Do not paraphrase an article so loosely that the specifics change. Quote
  figures, names, addresses and versions exactly as written.
- Do not read every article to answer one question. Search, open two or three,
  answer.
- Do not announce that you searched when the question was never organizational.
  In a working session that is noise on every turn.
- Do not put credentials into a gap stub. The question, not the secret.
