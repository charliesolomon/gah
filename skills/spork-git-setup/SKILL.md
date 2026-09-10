---
name: spork-git-setup
description: Walk a user through setting up or configuring Git on their machine for Spork, the corporate GitLab, including Git Credential Manager, the corporate proxy, and mutual-TLS certificate/private-key setup. Use when someone says help me set up git, configure git, install git, connect git to Spork, or make Git work with Spork.
---

# Set up Git for Spork

Help a Windows/PowerShell user set up or reconfigure Git on their machine so it works with Spork (`spork.fusion.navy.mil`). This is an interactive setup: discover what is already installed, never overwrite a working credential or certificate setup without confirmation, and validate the connection without printing secrets.

Use this skill only when the user wants to install, set up, configure, or repair Git/Spork connectivity. Do **not** use it for ordinary Git operations such as cloning, pulling, pushing, merging, branching, or viewing repository status when Git is already configured and working. If an ordinary-operation request reports that the existing Git setup cannot authenticate or connect to Spork, use this skill for that configuration repair.

## Safety rules

- Never ask the user to paste a password, personal access token, private-key contents, cookie contents, or certificate private material into chat.
- Never put a Spork password or token in `.gitconfig`, a script, or a repository. Git Credential Manager (`manager`) stores credentials outside the config.
- Do not print `git config --list` unredacted: this host's configuration can contain passwords and private-key/cookie paths.
- Treat the client certificate and private key as existing prerequisites. Do not generate, copy, or export private keys through the agent.
- If the user has a different proxy, certificate, key path, or approved Spork hostname, ask before using it. The known Windows proxy for this organization is `http://172.17.1.19:8080`, but do not assume it is reachable from every network.

## 1. Discover the machine

Use PowerShell to check Git, Git LFS, and the relevant config without exposing values:

```powershell
$git = Get-Command git -ErrorAction SilentlyContinue
if ($git) { git --version } else { 'Git is not installed' }

$lfs = Get-Command git-lfs -ErrorAction SilentlyContinue
if ($lfs) { git lfs version } else { 'Git LFS is not installed' }

if ($git) {
  git config --global --get credential.helper
  git config --global --get http.proxy
  git config --global --get https.proxy
  git config --global --get-regexp '^http\.https://spork\.fusion\.navy\.mil/' |
    ForEach-Object { $_ -replace '(?i)(password|sslkey|cookiefile)(\s+).*', '$1 <redacted>' }
}
```

If Git is present, retain it unless the version is clearly obsolete or the user asks to upgrade. If `git-lfs` is absent, install it as part of Git for Windows or separately; it is required for repositories that use LFS.

## 2. Install Git when necessary

For a Windows user without Git, recommend the approved software source first. If they can use `winget`, offer:

```powershell
winget install --id Git.Git -e --source winget
```

Alternatively, have them install the current Git for Windows package from the organization's approved software portal. Do not download an installer from an arbitrary URL. Close and reopen PowerShell after installation, then verify:

```powershell
git --version
git lfs version
```

Git for Windows supplies Git Credential Manager and the standard CA bundle. Installing Git LFS separately is acceptable if the organization's package omits it:

```powershell
winget install --id GitHub.GitLFS -e --source winget
git lfs install
```

## 3. Configure identity and common behavior

Ask for the user's corporate display name and email if they are not already configured. Set them globally, not in one repository:

```powershell
git config --global user.name "Full Name"
git config --global user.email "corporate.address@example.mil"
git config --global init.defaultBranch main
git config --global core.autocrlf true
git config --global core.fscache true
git config --global core.symlinks false
```

If existing identity values are present, show them and ask before replacing them. Do not guess the user's email.

## 4. Configure the corporate proxy and credential helper

Git Credential Manager is the required credential helper:

```powershell
git config --global credential.helper manager
```

If the corporate proxy applies on this network, configure it:

```powershell
git config --global http.proxy  "http://172.17.1.19:8080"
git config --global https.proxy "http://172.17.1.19:8080"
```

Do not configure a proxy when the user is on a network where it is not required. If a proxy is already configured, preserve it unless the user confirms it is wrong.

For Spork's GitLab credential interpretation, configure:

```powershell
git config --global credential.https://spork.fusion.navy.mil/.provider gitlab
git config --global credential.spork.fusion.navy.mil.provider gitlab
```

If the user does not yet have a Spork account, direct them to the Spork site first:

```text
https://spork.fusion.navy.mil/
```

They must complete the organization's account-registration or access-request process before creating credentials. If the site does not offer self-service registration, tell them to use the normal corporate access-support channel.

If the user needs a token instead of interactive GitLab authentication, they can create a Spork personal access token here:

```text
https://spork.fusion.navy.mil/-/user_settings/personal_access_tokens
```

They should grant only the scopes required for the repositories they need, following the organization's GitLab guidance. The token should be entered into Git Credential Manager when prompted; it must not be placed in `.gitconfig`, command history, a script, or chat.

Never use `git config ... password ...`. When the first authenticated operation occurs, Git Credential Manager should prompt/sign in and store the credential securely. If it does not, stop and troubleshoot the helper rather than requesting a password or token in chat.

## 5. Configure mutual TLS

Users can obtain their Spork-issued certificate/private-key pair from the corporate certificate portal:

```text
https://spork.fusion.navy.mil/ca/
```

They should use the portal only through the approved corporate network and follow its instructions for installing the certificate and saving the private key locally. Never ask the user to upload, paste, or disclose the private key.

Confirm that the user has:

1. The organization-issued client certificate installed in the **Current User** certificate store (`certmgr.msc`, usually under `Personal > Certificates`), and
2. The matching private-key file at a local path readable by Git.

Ask the user for the certificate-store reference and private-key path, but not the certificate's private material. On this organization's Windows setup, the reference has the form `CurrentUser\MY\<certificate-thumbprint>` and the key is commonly a Unix-style Git path such as `/c/Users/<user>/.git/<key-file>`.

Set only the values supplied by the user:

```powershell
git config --global 'http.https://spork.fusion.navy.mil/.sslbackend' schannel
git config --global 'http.https://spork.fusion.navy.mil/.sslcert' 'CurrentUser\MY\<thumbprint>'
git config --global 'http.https://spork.fusion.navy.mil/.sslkey' '/c/Users/<user>/.git/<private-key-file>'
```

Check that the key file exists without reading it:

```powershell
Test-Path -LiteralPath 'C:\Users\<user>\.git\<private-key-file>'
```

Do not export a certificate with its private key, loosen its permissions, or commit the key to a repository. Do not configure `http.sslVerify=false`.

A cookie-file setting is not part of the normal setup. Do not add one unless the organization's administrator explicitly supplies and documents a valid path.

## 6. Configure the Spork URL rewrite

Spork historically uses a `git://` form in some references. Preserve compatibility by adding:

```powershell
git config --global 'url.https://spork.fusion.navy.mil/.insteadof' 'git://spork.fusion.navy.mil/'
```

## 7. Validate without leaking credentials

Use a harmless authenticated operation against a repository the user is authorized to access. Prefer cloning a known small project into a temporary directory, or test an existing authorized remote:

```powershell
git ls-remote https://spork.fusion.navy.mil/<group>/<project>.git
```

Do not add `--verbose` unless needed, because transport diagnostics can expose paths or headers. If prompted, the user completes authentication locally. A successful result prints refs; it should not print a password.

For a repository already cloned from Spork, verify the remote and effective non-secret settings:

```powershell
git remote -v
git config --get credential.helper
git config --get http.proxy
git config --get http.https://spork.fusion.navy.mil/.sslbackend
git config --get http.https://spork.fusion.navy.mil/.sslcert
```

If validation fails, classify the error:

- **Could not resolve/connect/timeout:** check network and proxy choice.
- **407 Proxy Authentication Required:** the proxy requires separate approved authentication; do not put proxy credentials in Git config.
- **SSL certificate/private key error:** confirm the certificate is in Current User's store, matches the key, and the configured thumbprint/path is correct.
- **401/403:** verify the user's Spork account/project authorization through the normal corporate channel; do not ask for or handle a token in chat.
- **Git Credential Manager not prompting:** confirm `credential.helper` is `manager`, then retry after checking the user's approved Windows sign-in state.

## What a successful setup contains

The effective configuration should include:

- Git for Windows and Git LFS installed
- The user's global name and corporate email
- `credential.helper=manager`
- The Spork GitLab credential provider
- The applicable corporate proxy
- Spork's `schannel` backend, certificate-store reference, and matching private-key path
- The Spork `git://` to `https://` URL rewrite

Report the result and any missing prerequisite, but redact passwords, tokens, cookie contents, and private-key material from the final response.
