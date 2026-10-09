# Deploying gah to a team

Start here if you are setting gah up for other people. This page gives the
overall plan and helps you choose how people will run gah; each step links to
the detailed guide.

**You will need:**

- a computer with Node 22+ and a built gah checkout ([README](../README.md#quick-start));
- an inference endpoint your organisation approves, and a way to give people keys for it;
- a git host for the team's skills. For the per-person packages, that has to be
  GitLab ([The team forge](#the-team-forge)).

**The four steps:**

1. **Choose the models.** Decide which models people may use and register
   any approved endpoint. See [PROVIDERS.md](PROVIDERS.md).
2. **Create the team's skills repository.** `gah init` writes a starter
   repository. Put it on your git host and share it with the team. See
   [SKILLS.md](SKILLS.md). A knowledge base is optional and can come later
   ([KB.md](KB.md)).
3. **Choose a shape and deploy.** See [Choose a shape](#choose-a-shape) below.
4. **Hand it over.** People start gah. If something is missing, such as their
   team's skills or a key, gah tells them and helps them finish setup.

## Choose a shape

| Shape | Who it suits | What people need | Skills come from | Guide |
|---|---|---|---|---|
| **Per-person package** | people on their own Windows 11 or RHEL 9 machine | Node 22+; the zip you publish | your GitLab, fetched on every launch | [DEPLOY-WINDOWS.md](DEPLOY-WINDOWS.md), [DEPLOY-LINUX.md](DEPLOY-LINUX.md) |
| **Shared Linux host** | a small team you manage centrally; nothing to install on laptops | an SSH client | any git host, cloned with a deploy key | [deploy/host/README.md](../deploy/host/README.md) |
| **gah checkout** | you, other admins, and people who write skills | a clone of this repository, built | any local clone (`GAH_SKILLS_DIR`) | [README](../README.md#quick-start), [WINDOWS.md](WINDOWS.md) |

Shapes can be mixed: the same skills repository works in all three.

- **Per-person packages** update themselves and keep the team's skills
  current. People can finish setup from inside gah, for example by entering a
  GitLab token.
- **On the shared host,** you set up each account; people never see setup.
- **A checkout** is where you build packages and try skill changes before
  the team gets them.

## The team forge

The *forge* is where the team's work lives: the skills repository, and, for
packages, the published packages. **gah supports one team forge today:
GitLab.**

| Shape | What it needs from the forge |
|---|---|
| Per-person package | **GitLab only.** Updates come from a GitLab package registry, the skills come from a GitLab project, and the in-session setup (`/setup-skills`) asks for a GitLab token or client certificate. See [GITLAB.md](GITLAB.md). |
| Shared Linux host | Plain git over SSH, so any git host works (GitHub, Bitbucket, GitLab, your own server). |
| gah checkout | Any local clone. |

So a team whose skills live on GitHub or Bitbucket can use gah today on a
shared host or from checkouts. It can't use the per-person packages yet.

**Adding a forge.** Support for a forge is one integration in gah, so others
can be added when a team needs one. An integration provides:

- **updates:** where a package finds and downloads newer versions;
- **skills:** how the launcher fetches the team's skills repository;
- **access setup:** the token or certificate it needs, collected in a masked
  dialog, plus a built-in setup skill (like `setup-gitlab`) that a deployment
  can replace with its own wording;
- **publishing:** the admin's publish script and its section in
  `gah-deploy.json`.

Skills are the easy part, since every forge can serve a git repository.
Updates are the harder part: not every forge has a package registry. The
maintainer's checklist of files to change is in
[WORKFLOW.md](WORKFLOW.md).
