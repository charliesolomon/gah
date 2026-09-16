---
name: kb-search
description: Answer a question from the organization's knowledge base, citing the articles used, and record a gap when nothing covers it. Use whenever someone asks what we know, how something here is set up, why something is the way it is, where a device or site is, or what our convention for something is. Aliases - what do we know about, look it up, is this documented, check the KB, kb
allowed-tools: Read, Grep, Glob, Write, Edit
---

# Answering from the knowledge base

The knowledge base is at `$GAH_KB_DIR` (or `$KB_DIR`), articles under
`articles/`. It holds what **this organization** knows: its sites, equipment,
conventions, and the exceptions that only its own staff can explain.

Your job is to answer from it, to be exact about what came from where, and —
when it cannot answer — to leave the question recorded so that the next person
is better off than you were.

## How to answer

**1. Search before you answer.** Always. Even when you think you know.

Use `grep` and `find` over `articles/`: the frontmatter `title`, `description`
and `tags` first, then the body. Search for the words the person used *and* the
obvious synonyms — someone asking about "wifi at the north campus" needs the
article titled "Wireless at the North site".

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

## When there is no answer — this is the important part

A missing answer is not a failure of the tool. It is the tool doing its most
valuable job: finding a documentation gap at the exact moment someone needed
that documentation, which is the only moment anyone is motivated to fix it.

**Say so plainly**, then do two things:

**Record the gap.** Write a stub under `articles/gaps/<slug>.md` with
`status: gap`, or increment `requests` and update `last_requested` if a stub for
that question already exists. Where a shell is available, the wrapper does both
and handles the slug and the counter:

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
`articles/README.md`.

Slug rule when you write it by hand: the question, lowercased, non-alphanumeric
runs replaced by hyphens, trimmed to 60 characters. Match it against existing
gap files before creating a new one, or the same question accumulates three
stubs and the count means nothing.

**Offer to close it now**, while the person still has the answer in their head:

> Nothing here covers the gym switch. I have recorded it as a gap — that is the
> third time someone has asked. If you know the answer, I can write the article
> now and put it up for review; it will take a minute.

If they say yes, hand over to `kb-article`. If they say no, that is fine — the
gap is recorded and the count still rose.

## When the answer is there but wrong

Someone will tell you an article is out of date. Treat that as the same event as
a gap: it is a correction offered at the moment it is cheapest to capture.
Confirm what is now true, then hand to `kb-article` to update the article and
bump `updated`. Do not quietly leave a known-wrong article in place.

## What not to do

- Do not answer estate questions from general knowledge and cite nothing.
- Do not paraphrase an article so loosely that the specifics change. Quote
  figures, names, addresses and versions exactly as written.
- Do not read every article to answer one question. Search, open two or three,
  answer.
- Do not record a gap for something the knowledge base is not for — a question
  about a public technology, or a task rather than a fact.
- Do not put credentials into a gap stub. The question, not the secret.
