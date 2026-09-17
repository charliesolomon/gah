# Organizational context

Markdown files describing your organization, written so an agent can use them:
people and roles, sites and networks, equipment inventories, working
conventions, escalation paths.

Skills reference these. A skill without context is a generic procedure; a skill
with context knows which queue you use, who escalates to whom, and why one site
is configured differently from the rest.

## This is the part that takes real time

The skills themselves are short. Writing down what your team already knows, in a
form something else can read, is the actual work — and it is worth being honest
about that at the start rather than discovering it in month two.

Start with whatever you find yourself explaining most often to a new colleague.

## Or a knowledge base, once there is enough of it

This folder is the small-deployment answer: a handful of Markdown files the
skills cite directly. When people start correcting these facts as they work —
and they will, at the moment a wrong one costs them something — a knowledge base
is the better home. Corrections there are a normal reviewed change that anyone
can make from inside a session, gaps are recorded and counted so the next
article written is the one people actually needed, and the skills consult it
rather than restating it.

`gah init-kb` scaffolds one; see `docs/KB.md` in the gah repository. Nothing has
to move on the day you create it: new facts go there, and what is already here
stays until it needs touching.

## Keep it derivable where you can

If a fact will drift — a count, an inventory, a roster — prefer something that
can be regenerated over something maintained by hand. Hand-maintained lists go
stale silently, and an agent quoting a stale list is more damaging than one that
says it does not know.
