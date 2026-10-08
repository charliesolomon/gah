---
name: setup-gitlab
description: Give this gah installation read access to the organisation's GitLab, so it can fetch the shared skills, choosing the steps that fit this machine (Windows or Linux, client certificate or not). Use when the setup-skills skill finds that GitLab access is missing or refused. A deployment may replace this skill with its own.
---

# Set up GitLab access

Generic steps. A deployment can ship its own `setup-gitlab` skill with
details only its people know (who issues certificates, internal links); when it
does, that one is loaded instead of this one.

Work from `gah_setup` action `status`. The fields that matter:

- `gitlab.url`, `gitlab.skillsProject`: where the skills live.
- `gitlab.clientCertRequired`: the GitLab front end wants a client certificate.
- `gitlab.clientCertIssuer`: the certificate authority to look for, if known.
- `gitlab.tokenConfigured`, `gitlab.certConfigured`: what is already stored.
- `probes.skillsAnonymous`, `probes.skillsWithToken`: the HTTP status of reading
  the skills project without and with the token. 200 means it works.
  Other values:
  - **401**: no token, or GitLab does not accept the one stored.
  - **403**: the token is accepted, but its scope or the person's access to the
    project is too narrow.
  - **404**: the project does not exist, or this person cannot see it. Same fix
    as 403, plus checking the project path with the administrator.
  - **an error that mentions a certificate, SSL or TLS**: the client
    certificate is missing or wrong (when one is required), or the
    organisation's CA is not trusted on this machine.
  - **unreachable, timed out, could not connect**: a network or proxy problem.

Never ask for the token in the chat. Never print it.

## 1. Client certificate, only if `clientCertRequired` is true

Do this first: without the certificate, GitLab rejects everything, token or not.

- If `certConfigured` is false, or the probes show a certificate error, run
  `gah_setup` action `choose_gitlab_certificate`.
  - **On Windows** the person picks from their certificate list. Tell them which
    to choose: the one issued to them by the organisation, usually with their
    name as the subject, and issued by `clientCertIssuer` when the status names
    it.
  - **On Linux** they type the path of the certificate file (PEM), and of the
    key file if it is separate. Git already uses them if git works with this
    GitLab: `git config --get-urlmatch http.sslcert <gitlab.url>` names the
    file. The key must not have a passphrase.
- If they have no certificate at all, they need one from the organisation's IT
  before anything else works. Say so and stop.

## 2. Token

Needed unless `skillsAnonymous` is already 200.

1. Walk the person through creating one, in their browser:
   1. Open `<gitlab.url>`, sign in.
   2. Avatar (top left or right) → **Edit profile** → **Access tokens** → **Add new token**.
   3. Name it `gah`, set an expiry date, tick only **read_api**.
   4. **Create token**, then copy it. GitLab shows it once.
2. Run `gah_setup` action `enter_gitlab_token`. A dialog opens; the person
   pastes the token there, not in the chat.
3. Read the result's `probes.skillsWithToken`:
   - **200**: done. Return to the setup-skills skill.
   - **401**: the token was mistyped, expired, or revoked. Offer to enter it again.
   - **403 or 404**: the token works but this person cannot read the skills
     project. They need the administrator to add them (Reporter role is
     enough), or the project path is wrong. Stop here.

## 3. Network problems

If the probes say GitLab is unreachable, this is not a token problem.

- **On a corporate network that needs a proxy for GitLab**, the deployment's
  `gitlab.proxy` setting, or the machine's `HTTPS_PROXY`, decides it. That is
  for the administrator or the person's IT. Report the exact error.
- **Off the corporate network**, GitLab may only be reachable on it, or over VPN.
  Ask whether they are connected.

Stop after reporting; there is nothing more to try from inside gah.
