# Laptop-side shortcut installer

Staff reach the [shared agent host](../host/README.md) through a desktop
shortcut that opens `wt.exe ssh <user>@<host>`. Getting that shortcut, and the
SSH key behind it, onto a laptop is the one part of the deployment that
depends on tools GAH does not own.

## The pattern

For one named Windows user, whether or not they are logged on:

1. generate an ed25519 keypair in their profile;
2. pre-seed the agent host's key in their `known_hosts`, so nobody who has
   never used a terminal is asked to verify a fingerprint on first launch;
3. add a Windows Terminal profile and a desktop shortcut running
   `wt.exe ssh <user>@<host>`;
4. return the public key so it can be registered on the host with
   `gah-adduser`;
5. make every step idempotent, and make `-Uninstall` reverse exactly what
   install did.

## What is here

`Deploy-GahShortcut.ps1` does all of that, written for **TacticalRMM**, which
runs scripts as SYSTEM with no run-as-user option and only Windows
PowerShell 5.1. Those constraints shape the script (SID → ProfileList
resolution instead of `$env:USERPROFILE`, no PowerShell 6 escapes, stdout as
the only return channel). An organisation on Intune, Group Policy or another
RMM needs a different script for the same five steps, not different
parameters — treat this one as a worked example.

Everything organisation-specific is a parameter: `-JumpHost` (required),
`-ShortcutName` (default `GAH Assistant`), `-HostKey`. Some RMM API wrappers
split arguments on spaces; if yours does, bake such values into the script
body at upload time instead of passing them.

## Where the wrapper goes

The script that pushes this file into an RMM library and runs it against an
endpoint — with the organisation's host name, shortcut name and API
credentials — belongs in that organisation's own ops repository, not here.
GAH stays organisation-neutral; the wrapper is where the organisation lives.
