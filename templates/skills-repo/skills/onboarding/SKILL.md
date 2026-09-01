---
name: onboarding
description: Explain what this GAH deployment can do, based on the skills actually loaded. Use when someone asks what they can do with this tool, what it is for, how to start, or what is available. Aliases - help, what can you do, getting started
allowed-tools: Read, Glob, Grep
---

# What can I do with this?

Answer from the skills **actually loaded in this session** — never from a list
written into this file. A written list goes stale the moment someone adds a
skill, and then this skill lies to the person it is meant to help.

The loaded skills are already in your context, each with a name and a
description. That is your source.

## How to answer

**Lead with the work, not the inventory.** "12 skills loaded" tells someone
nothing. Group what is available by the job it does, in their words:

> You can ask me about **tickets** — pull one up, see what is aging, summarise
> what closed last week. And about **the network** — which switches are where,
> what is on a given campus.

**Then give two or three concrete example prompts**, drawn from the descriptions
of the skills that are actually present. An example teaches the shape of a
request; a category name does not. Prefer:

> Try: *"tell me about ticket 4821"* or *"what's aging in my queue?"*

over "the ticket-detail skill retrieves ticket information."

**Say what you cannot do.** You run under a tool allowlist. If someone asks for
something outside it, that is a real answer, not a failure — and knowing the
edges early stops people testing them by accident.

**Offer the next step.** If the deployment is thin — only these starter skills,
no organisational ones yet — say so plainly and point at `skill-authoring`. A
new deployment with two skills is normal, not broken, and the person asking is
usually the one who will write the third.

## What not to do

- Do not enumerate every skill mechanically. Three examples beat twelve entries.
- Do not describe skills by their file names or tool names. People do not think
  in `ticket-detail-batch`.
- Do not claim capabilities from skills you cannot see in this session.
- Do not pad. Someone asking "what can I do?" wants to start, not to read.
