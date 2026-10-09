---
name: setup-skills
description: Connect this gah installation to the team's shared skills, working out what is missing first (GitLab access, a token, a client certificate) and doing only the next step. Use when the person types /setup-skills, asks how to get their team's skills, or asks why gah says it is better with skills.
disable-model-invocation: true
---

# Set up shared skills

The person wants their team's shared skills in gah. Your job is to find the one
thing standing in the way, fix that, and repeat until the skills are loaded.
Keep it short and concrete: one step at a time, in plain words, no jargon the
person did not use first.

## Rules

- **Never ask for a secret in the chat.** Tokens are typed into a dialog that
  `gah_setup` opens; you never see them. If the person pastes a token into the
  chat anyway, tell them to revoke it in GitLab and create a new one, because
  the chat is logged.
- **Facts before advice.** Start with `gah_setup` action `status`, and run it
  again after every change. Do not guess why something fails.
- **Do only what is needed.** If skills can be fetched as things stand, fetch
  them; never walk the person through GitLab setup they do not need.

## Steps

1. Run `gah_setup` with action `status`.

2. Look at `sharedSkillsLoaded`, `skillsUpdateFailed` and `probes`:
   - `sharedSkillsLoaded` above 0 and no `skillsUpdateFailed`: skills are
     already loaded and current. Say so, and suggest the knowledge base as a
     possible next step if `knowledgeBase` is not configured. Stop.
   - `skillsUpdateFailed` present: gah is using an older copy of the skills
     because the last update failed. Say so in one sentence, quoting the
     reason, then carry on below; the probes say whether access is the problem.
   - `skillsAnonymous` or `skillsWithToken` is 200: access works. Run
     `gah_setup` with action `fetch_skills`. When it reports `reloading`, tell
     the person their skills will be ready as soon as this answer ends, and
     suggest they ask "what can you do?" afterwards.
   - Anything else: GitLab access is the problem. Read the `setup-gitlab`
     file listed in `setupGuides` and follow it. When it is done, come back
     to step 1.

3. If `fetch_skills` fails, show the error in one sentence and run `status`
   again; the probes usually say why.

## When the person declines

Setup can wait. Say that gah works without shared skills, that the line above
the input box will stay until they are connected, and that /setup-skills picks
up where they left off.
