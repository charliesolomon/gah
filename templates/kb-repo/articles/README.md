# Articles

One Markdown file per article. Subdirectories group them by area — use whatever
areas match how your team thinks, not how your systems are organised:

```
articles/
  network/          topology, addressing, wireless, standing exceptions
  sites/            one per location
  equipment/        what is deployed, and why anything differs
  conventions/      how your team names, tickets, escalates
  people/           roles and escalation paths (no personal data)
```

None of those are required. Create a directory when you have two articles that
belong in it, not before.

File names are kebab-case and describe the subject, not the document:
`north-site-wireless.md`, not `wifi-doc-v2.md`.

## Frontmatter

Every article starts with a small YAML header. Five fields, three of them
required:

```yaml
---
title: Wireless at the North site          # required
description: Access points, firmware and the two standing exceptions   # required
status: current                            # required: current | draft | gap
updated: 2026-09-15                        # required: ISO date, the day the facts were last checked
tags: [network, wireless, north-site]      # optional, lowercase
---
```

| Field | Why it exists |
|---|---|
| `title` | what the agent cites, and what a person scans |
| `description` | one sentence; this is what search matches on and what the agent reads first when deciding whether to open the file |
| `status` | `current` = believed true. `draft` = written, not yet checked by anyone. `gap` = a question somebody asked that nothing here answers |
| `updated` | the day someone last *verified* the facts, not the day the file changed. Staleness reporting depends on this being honest |
| `tags` | optional grouping. Keep them few and reuse them |

Gap stubs carry two more, both maintained by the tooling:

```yaml
status: gap
requests: 3                                # how many times someone has asked
last_requested: 2026-09-15
```

## Writing the body

**Answer the question someone actually asked.** Lead with the fact. Background
goes underneath, if at all.

**Record the exceptions and their reasons.** "All sites run firmware 7.x except
the North site, which stays on 6.9 because the older controllers there lose
their uplink on 7.x" is worth ten paragraphs of inventory. The exception is the
part nobody can reconstruct.

**Say where a fact came from and when.** A line like `Verified against the
controller on 2026-09-15` tells the next reader how much to trust it. Facts with
a system of record should name it, so the article ages into a pointer rather
than into a lie.

**Prefer short.** Two screens is a good article. If it is longer, it is probably
two articles, or it contains an inventory that should be derived instead of
typed.

**Write for a competent colleague who is new here.** Not for yourself in a
year, and not for someone who needs the technology explained.
