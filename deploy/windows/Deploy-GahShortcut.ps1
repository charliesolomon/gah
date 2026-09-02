<#
.SYNOPSIS
    Install (or remove) the GAH desktop shortcut and SSH key for ONE named
    Windows user. Designed to run from TacticalRMM, which executes as SYSTEM.

    This is one worked example for one endpoint-management tool, not the
    deployment path. The generic pattern (keypair, known_hosts, Terminal
    profile, shortcut, key hand-back) is described in README.md next to this
    file; the RMM-specific mechanics below are what TacticalRMM forces. An
    organisation's host name, shortcut name and RMM API calls belong in a
    wrapper in that organisation's own ops repository, which pushes this
    script and passes or bakes in those values.

.DESCRIPTION
    TacticalRMM runs agent scripts as SYSTEM and exposes no run-as-user option,
    so nothing here may rely on the ambient user context:

      * $env:USERPROFILE is C:\Windows\system32\config\systemprofile, not the
        target user's home.
      * Win32_ComputerSystem.UserName gives only the *console* session -- null
        when nobody is at the console, and wrong when several people are signed
        in via fast user switching or RDP.

    So the target is always an explicit -TargetUser, resolved to a SID and then
    to a profile path via the ProfileList registry key. That works whether or
    not the user is currently logged on, and never guesses.

    Everything is idempotent in both directions: install can be re-run safely,
    and -Uninstall reverses exactly what install did (restoring the Windows
    Terminal settings backup that install took before touching it).

.PARAMETER TargetUser
    The Windows account to install for, e.g. 'jsmith_example'. Accepts
    'DOMAIN\user' or a bare local name. Required unless -ListProfiles.

.PARAMETER GahUser
    The Unix account on the GAH host. Defaults to the local part of TargetUser
    (everything before the first underscore).

.PARAMETER JumpHost
    The GAH agent host, e.g. 'agent.example.org'. Required for install and
    uninstall.

.PARAMETER HostKey
    The host's public key line for known_hosts, WITHOUT the leading hostname
    (e.g. 'ssh-ed25519 AAAAC3...'). Pre-seeding this is what stops a
    non-terminal-native staffer being asked to verify a fingerprint on first
    launch. Skipped if empty.

.PARAMETER ListProfiles
    Enumerate every profile on this machine (SID, account, path, last use) and
    exit. Run this first to get the exact -TargetUser string.

.PARAMETER Uninstall
    Remove the shortcut, known_hosts entry and Terminal keybindings, and (unless
    -KeepKey) the keypair.

.PARAMETER KeepKey
    With -Uninstall, leave the keypair in place. Use this for the fast
    UX-iteration loop: the public key already registered on the host stays
    valid, so you skip the gah-adduser round trip on every cycle.

.EXAMPLE
    .\Deploy-GahShortcut.ps1 -ListProfiles
    .\Deploy-GahShortcut.ps1 -TargetUser jsmith_example -JumpHost agent.example.org
    .\Deploy-GahShortcut.ps1 -TargetUser jsmith_example -JumpHost agent.example.org -Uninstall -KeepKey
#>
[CmdletBinding(DefaultParameterSetName = 'Install')]
param(
    [Parameter(ParameterSetName = 'Install', Mandatory = $true)]
    [Parameter(ParameterSetName = 'Uninstall', Mandatory = $true)]
    [string]$TargetUser,

    [Parameter(ParameterSetName = 'Install')]
    [Parameter(ParameterSetName = 'Uninstall')]
    [string]$GahUser,

    [Parameter(ParameterSetName = 'Install', Mandatory = $true)]
    [Parameter(ParameterSetName = 'Uninstall', Mandatory = $true)]
    [string]$JumpHost,

    [Parameter(ParameterSetName = 'Install')]
    [string]$HostKey = '',

    [Parameter(ParameterSetName = 'Install')]
    [Parameter(ParameterSetName = 'Uninstall')]
    [string]$ShortcutName = 'GAH Assistant',

    [Parameter(ParameterSetName = 'List', Mandatory = $true)]
    [switch]$ListProfiles,

    [Parameter(ParameterSetName = 'Uninstall', Mandatory = $true)]
    [switch]$Uninstall,

    [Parameter(ParameterSetName = 'Uninstall')]
    [switch]$KeepKey
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$PROFILE_LIST = 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\ProfileList'
$script:LoadedHive = $null   # SID whose hive we loaded and must unload

# Matches a known_hosts line for one host. .NET regex has no \Q..\E, so the
# hostname must be escaped explicitly before interpolation.
function Get-KnownHostPattern {
    param([string]$HostName)
    '^\s*' + [regex]::Escape($HostName) + '[\s,]'
}

function Write-Step { param([string]$m) Write-Host "  $m" }
function Write-Ok   { param([string]$m) Write-Host "[ok]   $m" }
function Write-Warn { param([string]$m) Write-Host "[warn] $m" }
function Die        { param([string]$m) Write-Host "[FAIL] $m"; exit 1 }

# ---------------------------------------------------------------- profiles ---

function Get-AllProfiles {
    Get-ChildItem $PROFILE_LIST | ForEach-Object {
        $sid  = Split-Path $_.Name -Leaf
        $path = (Get-ItemProperty $_.PSPath -Name ProfileImagePath -ErrorAction SilentlyContinue).ProfileImagePath
        if (-not $path) { return }
        # Skip the machine accounts -- S-1-5-18/19/20 are SYSTEM and the two
        # service profiles; none of them is ever a shortcut target.
        if ($sid -match '^S-1-5-(18|19|20)$') { return }

        $account = '(unresolved)'
        try {
            $account = (New-Object System.Security.Principal.SecurityIdentifier($sid)).
                        Translate([System.Security.Principal.NTAccount]).Value
        } catch { }

        [pscustomobject]@{
            SID     = $sid
            Account = $account
            Path    = $path
            LastUse = if (Test-Path $path) { (Get-Item $path).LastWriteTime } else { $null }
        }
    }
}

function Resolve-TargetProfile {
    param([string]$User)

    # Name -> SID. Try as given, then as a local account, so both
    # 'DOMAIN\user' and a bare name work.
    $sid = $null
    foreach ($candidate in @($User, "$env:COMPUTERNAME\$User")) {
        try {
            $sid = (New-Object System.Security.Principal.NTAccount($candidate)).
                    Translate([System.Security.Principal.SecurityIdentifier]).Value
            break
        } catch { }
    }
    if (-not $sid) {
        Die "cannot resolve Windows account '$User' on $env:COMPUTERNAME. Run with -ListProfiles to see valid accounts."
    }

    $key = Join-Path $PROFILE_LIST $sid
    if (-not (Test-Path $key)) {
        Die "account '$User' resolves to $sid but has no profile on this machine (never signed in?). Run with -ListProfiles."
    }
    $path = (Get-ItemProperty $key -Name ProfileImagePath).ProfileImagePath
    if (-not (Test-Path $path)) {
        Die "profile path for '$User' is registered as '$path' but does not exist on disk."
    }

    [pscustomobject]@{ User = $User; SID = $sid; Path = $path }
}

# Load the target's NTUSER.DAT if their hive isn't already mounted, so we can
# read their shell folders while they're signed out. Remembered so we unload it.
function Mount-UserHive {
    param([string]$Sid, [string]$ProfilePath)

    if (Test-Path "Registry::HKEY_USERS\$Sid") { return $true }

    $dat = Join-Path $ProfilePath 'NTUSER.DAT'
    if (-not (Test-Path $dat)) { return $false }

    & reg.exe load "HKU\$Sid" $dat 2>&1 | Out-Null
    if ($LASTEXITCODE -ne 0) { return $false }
    $script:LoadedHive = $Sid
    return $true
}

function Dismount-UserHive {
    if (-not $script:LoadedHive) { return }
    [gc]::Collect()   # release any lingering handles or the unload fails
    & reg.exe unload "HKU\$($script:LoadedHive)" 2>&1 | Out-Null
    $script:LoadedHive = $null
}

# Desktop is NOT reliably <profile>\Desktop -- OneDrive Known Folder Move
# redirects it. Ask the user's own shell folders, fall back only if that fails.
function Get-UserDesktop {
    param([string]$Sid, [string]$ProfilePath)

    $fallback = Join-Path $ProfilePath 'Desktop'
    if (-not (Mount-UserHive -Sid $Sid -ProfilePath $ProfilePath)) { return $fallback }

    $key = "Registry::HKEY_USERS\$Sid\Software\Microsoft\Windows\CurrentVersion\Explorer\User Shell Folders"
    try {
        $raw = (Get-ItemProperty $key -Name Desktop -ErrorAction Stop).Desktop
    } catch { return $fallback }
    if (-not $raw) { return $fallback }

    # The value is a REG_EXPAND_SZ holding %USERPROFILE%\Desktop or a
    # OneDrive path. Expand it against the TARGET profile, not ours.
    $expanded = $raw -replace '%USERPROFILE%', $ProfilePath
    $expanded = [Environment]::ExpandEnvironmentVariables($expanded)
    if (Test-Path $expanded) { return $expanded }
    return $fallback
}

# ------------------------------------------------------------------- perms ---

# Files SYSTEM creates are owned by SYSTEM and inherit the parent ACL. Windows
# OpenSSH refuses a private key that other principals can read ("bad
# permissions", UNPROTECTED PRIVATE KEY FILE), so strip the inherited ACEs and
# grant only the owner -- plus SYSTEM.
#
# SYSTEM is deliberate, not a loosening. Windows OpenSSH's permission check
# explicitly tolerates the owner, SYSTEM and Administrators; and because
# TacticalRMM runs this script AS SYSTEM, omitting it locks the deploying
# account out of the files it just created -- it cannot read the public key
# back, and -Uninstall cannot delete them.
function Set-PrivateKeyAcl {
    param([string]$Path, [string]$Sid)

    $id     = New-Object System.Security.Principal.SecurityIdentifier($Sid)
    $system = New-Object System.Security.Principal.SecurityIdentifier('S-1-5-18')

    $acl = Get-Acl $Path
    $acl.SetAccessRuleProtection($true, $false)   # kill inheritance, drop inherited ACEs
    foreach ($rule in @($acl.Access)) { [void]$acl.RemoveAccessRule($rule) }
    $acl.SetOwner($id)
    foreach ($principal in @($id, $system)) {
        $acl.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule(
            $principal, 'FullControl', 'None', 'None', 'Allow')))
    }
    Set-Acl -Path $Path -AclObject $acl
}

# For the files that are NOT secrets -- the public key, known_hosts, the .lnk,
# Terminal settings. These only need to belong to the user and stay reachable
# by SYSTEM; stripping their inheritance the way we do for a private key is
# heavy-handed and leaves the profile in an odd state. This also REPAIRS files
# an earlier, over-strict version of this script locked SYSTEM out of.
function Grant-UserAccess {
    param([string]$Path, [string]$Sid)

    $id     = New-Object System.Security.Principal.SecurityIdentifier($Sid)
    $system = New-Object System.Security.Principal.SecurityIdentifier('S-1-5-18')

    try {
        $acl = Get-Acl $Path
        $acl.SetAccessRuleProtection($false, $true)   # restore normal inheritance
        $acl.SetOwner($id)
        foreach ($principal in @($id, $system)) {
            $acl.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule(
                $principal, 'FullControl', 'None', 'None', 'Allow')))
        }
        Set-Acl -Path $Path -AclObject $acl
    } catch {
        Write-Warn "could not adjust permissions on $Path : $($_.Exception.Message)"
    }
}

# Run before anything is read: a previous version of this script may have left
# these files unreadable by SYSTEM, which is the account we are running as.
function Repair-ManagedAcls {
    param([string]$Sid, [string[]]$Paths)
    foreach ($p in $Paths) {
        if ($p -and (Test-Path $p)) { Grant-UserAccess -Path $p -Sid $Sid }
    }
}

function Set-UserOwnedDir {
    param([string]$Path, [string]$Sid)

    $id  = New-Object System.Security.Principal.SecurityIdentifier($Sid)
    $acl = Get-Acl $Path
    $acl.SetOwner($id)
    $acl.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule(
        $id, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow')))
    Set-Acl -Path $Path -AclObject $acl
}

# ------------------------------------------------------------------- tools ---

function Find-Ssh {
    foreach ($p in @("$env:SystemRoot\System32\OpenSSH\ssh.exe",
                     "$env:SystemRoot\Sysnative\OpenSSH\ssh.exe")) {
        if (Test-Path $p) { return $p }
    }
    $c = Get-Command ssh.exe -ErrorAction SilentlyContinue
    if ($c) { return $c.Source }
    return $null
}

function Find-SshKeygen {
    $ssh = Find-Ssh
    if ($ssh) {
        $kg = Join-Path (Split-Path $ssh -Parent) 'ssh-keygen.exe'
        if (Test-Path $kg) { return $kg }
    }
    $c = Get-Command ssh-keygen.exe -ErrorAction SilentlyContinue
    if ($c) { return $c.Source }
    return $null
}

# wt.exe is a per-user WindowsApps execution alias -- it is NOT on SYSTEM's
# PATH, so look for it under the target's profile specifically.
function Find-WindowsTerminal {
    param([string]$ProfilePath)
    $p = Join-Path $ProfilePath 'AppData\Local\Microsoft\WindowsApps\wt.exe'
    if (Test-Path $p) { return $p }
    return $null
}

# ---------------------------------------------------------- terminal config ---

function Get-TerminalSettingsPath {
    param([string]$ProfilePath)
    Join-Path $ProfilePath 'AppData\Local\Packages\Microsoft.WindowsTerminal_8wekyb3d8bbwe\LocalState\settings.json'
}

# The PI TUI needs shift+enter and alt+enter delivered as CSI-u sequences;
# Windows Terminal otherwise swallows alt+enter as toggle-fullscreen.
# NOTE: `e is a PowerShell 6+ escape. TacticalRMM runs Windows PowerShell 5.1
# on these endpoints, so ESC must be built from its char code.
$ESC = [char]0x1B
$GAH_KEYS = @(
    @{ command = @{ action = 'sendInput'; input = "$ESC[13;2u" }; keys = 'shift+enter' },
    @{ command = @{ action = 'sendInput'; input = "$ESC[13;3u" }; keys = 'alt+enter'   }
)

function Add-TerminalKeybindings {
    param([string]$SettingsPath, [string]$Sid)

    if (-not (Test-Path $SettingsPath)) {
        Write-Warn "Windows Terminal settings not found -- skipping keybindings (shift+enter may not work)"
        Write-Step "expected: $SettingsPath"
        return
    }

    $backup = "$SettingsPath.gah-bak"
    if (-not (Test-Path $backup)) {
        Copy-Item $SettingsPath $backup -Force
        Grant-UserAccess -Path $backup -Sid $Sid
        Write-Step "backed up settings.json -> $(Split-Path $backup -Leaf)"
    }

    $raw = Get-Content $SettingsPath -Raw
    try { $json = $raw | ConvertFrom-Json } catch {
        Write-Warn "settings.json is not valid JSON -- leaving it alone"
        return
    }

    # Newer Terminal uses 'actions'; older used 'keybindings'. Extend whichever
    # this install has rather than introducing a second competing list.
    $prop = if ($json.PSObject.Properties.Name -contains 'actions') { 'actions' }
            elseif ($json.PSObject.Properties.Name -contains 'keybindings') { 'keybindings' }
            else { 'actions' }

    $existing = @()
    if ($json.PSObject.Properties.Name -contains $prop -and $json.$prop) { $existing = @($json.$prop) }

    $added = 0
    foreach ($kb in $GAH_KEYS) {
        if ($existing | Where-Object { $_.PSObject.Properties.Name -contains 'keys' -and $_.keys -eq $kb.keys }) {
            continue   # respect a binding the user already has
        }
        $existing += [pscustomobject]$kb
        $added++
    }

    if ($added -eq 0) { Write-Step 'terminal keybindings already present'; return }

    if ($json.PSObject.Properties.Name -contains $prop) { $json.$prop = $existing }
    else { $json | Add-Member -NotePropertyName $prop -NotePropertyValue $existing }

    $json | ConvertTo-Json -Depth 32 | Set-Content $SettingsPath -Encoding UTF8
    Grant-UserAccess -Path $SettingsPath -Sid $Sid
    Write-Ok "added $added terminal keybinding(s) to '$prop'"
}

function Remove-TerminalKeybindings {
    param([string]$SettingsPath, [string]$Sid)

    if (-not (Test-Path $SettingsPath)) { return }
    $backup = "$SettingsPath.gah-bak"

    if (Test-Path $backup) {
        Copy-Item $backup $SettingsPath -Force
        Remove-Item $backup -Force
        Grant-UserAccess -Path $SettingsPath -Sid $Sid
        Write-Ok 'restored settings.json from backup'
        return
    }

    # No backup: surgically drop only our two bindings rather than clobbering.
    try { $json = Get-Content $SettingsPath -Raw | ConvertFrom-Json } catch { return }
    foreach ($prop in @('actions', 'keybindings')) {
        if ($json.PSObject.Properties.Name -notcontains $prop -or -not $json.$prop) { continue }
        $ours = $GAH_KEYS.command.input
        $kept = @($json.$prop | Where-Object {
            -not ($_.PSObject.Properties.Name -contains 'command' -and
                  $_.command -and
                  $_.command.PSObject.Properties.Name -contains 'input' -and
                  $ours -contains $_.command.input)
        })
        $json.$prop = $kept
    }
    $json | ConvertTo-Json -Depth 32 | Set-Content $SettingsPath -Encoding UTF8
    Write-Ok 'removed GAH terminal keybindings (no backup found)'
}

# --------------------------------------------------------------- main verbs ---

function Invoke-Install {
    param($Target)

    $sshDir  = Join-Path $Target.Path '.ssh'
    $keyPath = Join-Path $sshDir 'gah'
    $pubPath = "$keyPath.pub"
    $known   = Join-Path $sshDir 'known_hosts'

    # Self-heal first: an earlier run of this script may have left these files
    # with an ACL that excludes SYSTEM, which is who we are.
    Repair-ManagedAcls -Sid $Target.SID -Paths @(
        $pubPath, $known,
        (Get-TerminalSettingsPath -ProfilePath $Target.Path),
        "$(Get-TerminalSettingsPath -ProfilePath $Target.Path).gah-bak")

    $keygen = Find-SshKeygen
    if (-not $keygen) { Die 'ssh-keygen.exe not found -- install the Windows OpenSSH client feature first.' }
    Write-Step "ssh-keygen: $keygen"

    if (-not (Test-Path $sshDir)) {
        New-Item -ItemType Directory -Path $sshDir -Force | Out-Null
        Write-Step "created $sshDir"
    }
    Set-UserOwnedDir -Path $sshDir -Sid $Target.SID

    # Reuse an existing key: regenerating would orphan the public key already
    # registered on the host and pile up dead authorized_keys entries.
    if (Test-Path $keyPath) {
        Write-Step 'keypair already present -- reusing'
    } else {
        & $keygen -t ed25519 -f $keyPath -N '""' -C "gah-$($env:COMPUTERNAME)-$($Target.User)" -q 2>&1 | Out-Null
        if (-not (Test-Path $keyPath)) { Die 'ssh-keygen did not produce a key' }
        Write-Ok 'generated ed25519 keypair'
    }
    # Apply the ACL FIRST: it is what grants SYSTEM (this process) access, and
    # it repairs a key left behind by an earlier run with a stricter ACL.
    # Reading before this point fails on exactly the files we need to fix.
    Set-PrivateKeyAcl -Path $keyPath -Sid $Target.SID
    if (Test-Path $pubPath) { Grant-UserAccess -Path $pubPath -Sid $Target.SID }

    $pubText = ''
    if (Test-Path $pubPath) {
        try { $pubText = (Get-Content $pubPath -Raw).Trim() }
        catch { Write-Warn "could not read $pubPath : $($_.Exception.Message)" }
    }

    # known_hosts: without this the first launch asks a non-technical user to
    # verify a fingerprint they have no way to check.
    if ($HostKey) {
        $line = "$JumpHost $HostKey"
        $have = (Test-Path $known) -and ((Get-Content $known) -contains $line)
        if ($have) {
            Write-Step 'known_hosts entry already present'
        } else {
            if (Test-Path $known) {
                # drop any stale entry for this host before adding the good one
                $pat  = Get-KnownHostPattern -HostName $JumpHost
                $kept = Get-Content $known | Where-Object { $_ -notmatch $pat }
                Set-Content $known -Value $kept -Encoding ASCII
            }
            Add-Content $known -Value $line -Encoding ASCII
            Grant-UserAccess -Path $known -Sid $Target.SID
            Write-Ok "pre-seeded known_hosts for $JumpHost"
        }
    } else {
        Write-Warn 'no -HostKey given -- user will be prompted to verify the host fingerprint on first launch'
    }

    # Shortcut. %USERPROFILE% is left UNEXPANDED on purpose: a .lnk expands env
    # vars in the launching user's context, so one string is correct per user.
    $wt      = Find-WindowsTerminal -ProfilePath $Target.Path
    $sshArgs = "ssh -i `"%USERPROFILE%\.ssh\gah`" $GahUser@$JumpHost"

    if ($wt) {
        $exe = $wt
        $arg = $sshArgs
        Write-Step "using Windows Terminal: $wt"
    } else {
        $ssh = Find-Ssh
        if (-not $ssh) { Die 'neither wt.exe nor ssh.exe found for this user' }
        $exe = $ssh
        $arg = "-i `"%USERPROFILE%\.ssh\gah`" $GahUser@$JumpHost"
        Write-Warn 'Windows Terminal not found for this user -- falling back to a plain console window'
    }

    $desktop = Get-UserDesktop -Sid $Target.SID -ProfilePath $Target.Path
    if (-not (Test-Path $desktop)) { Die "desktop folder not found: $desktop" }
    Write-Step "desktop: $desktop"

    $lnk = Join-Path $desktop "$ShortcutName.lnk"

    # An existing shortcut may carry a restrictive ACL from an earlier run;
    # WScript.Shell cannot overwrite what it cannot open for write.
    if (Test-Path $lnk) { Grant-UserAccess -Path $lnk -Sid $Target.SID }

    $sh  = New-Object -ComObject WScript.Shell
    $sc  = $sh.CreateShortcut($lnk)
    $sc.TargetPath       = $exe
    $sc.Arguments        = $arg
    $sc.Description      = "$ShortcutName on $JumpHost"
    $sc.WorkingDirectory = $Target.Path
    $sc.IconLocation     = "$env:SystemRoot\System32\SHELL32.dll,165"
    $sc.Save()
    Grant-UserAccess -Path $lnk -Sid $Target.SID
    Write-Ok "shortcut: $lnk"

    Add-TerminalKeybindings -SettingsPath (Get-TerminalSettingsPath -ProfilePath $Target.Path) -Sid $Target.SID

    # stdout is the only return path -- the RMM API wrapper has no file pull.
    if (-not $pubText -and (Test-Path $pubPath)) {
        try { $pubText = (Get-Content $pubPath -Raw).Trim() } catch { }
    }
    if ($pubText) {
        Write-Host ''
        Write-Host '-----BEGIN GAH PUBLIC KEY-----'
        Write-Host $pubText
        Write-Host '-----END GAH PUBLIC KEY-----'
    } else {
        Write-Warn "could not read $pubPath -- re-run to retrieve the public key"
    }
}

function Invoke-Uninstall {
    param($Target)

    $sshDir  = Join-Path $Target.Path '.ssh'
    $keyPath = Join-Path $sshDir 'gah'
    $known   = Join-Path $sshDir 'known_hosts'

    $desktop = Get-UserDesktop -Sid $Target.SID -ProfilePath $Target.Path
    $lnk     = Join-Path $desktop "$ShortcutName.lnk"

    Repair-ManagedAcls -Sid $Target.SID -Paths @(
        $lnk, $keyPath, "$keyPath.pub", $known,
        (Get-TerminalSettingsPath -ProfilePath $Target.Path),
        "$(Get-TerminalSettingsPath -ProfilePath $Target.Path).gah-bak")

    if (Test-Path $lnk) { Remove-Item $lnk -Force; Write-Ok "removed $lnk" }
    else { Write-Step 'shortcut not present' }

    if ($KeepKey) {
        Write-Step 'keeping keypair (-KeepKey) -- host-side authorized_keys stays valid'
    } else {
        foreach ($f in @($keyPath, "$keyPath.pub")) {
            if (Test-Path $f) { Remove-Item $f -Force; Write-Ok "removed $f" }
        }
    }

    # Only our host's line -- known_hosts holds unrelated entries.
    if (Test-Path $known) {
        $all  = Get-Content $known
        $pat  = Get-KnownHostPattern -HostName $JumpHost
        $kept = $all | Where-Object { $_ -notmatch $pat }
        if ($kept.Count -ne $all.Count) {
            Set-Content $known -Value $kept -Encoding ASCII
            Write-Ok "removed $JumpHost from known_hosts"
        }
    }

    Remove-TerminalKeybindings -SettingsPath (Get-TerminalSettingsPath -ProfilePath $Target.Path) -Sid $Target.SID
}

# ---------------------------------------------------------------------- run ---

try {
    if ($ListProfiles) {
        Write-Host "Profiles on $($env:COMPUTERNAME):"
        Write-Host ''
        Get-AllProfiles | Sort-Object LastUse -Descending |
            Format-Table -AutoSize @{L='Account';E={$_.Account}},
                                   @{L='Profile';E={$_.Path}},
                                   @{L='LastUse';E={if($_.LastUse){$_.LastUse.ToString('yyyy-MM-dd HH:mm')}else{'-'}}},
                                   @{L='SID';E={$_.SID}} |
            Out-String -Width 200 | Write-Host
        exit 0
    }

    if (-not $GahUser) { $GahUser = ($TargetUser -split '\\')[-1] -split '_' | Select-Object -First 1 }

    $target = Resolve-TargetProfile -User $TargetUser
    Write-Host "target user : $($target.User)"
    Write-Host "target SID  : $($target.SID)"
    Write-Host "profile     : $($target.Path)"
    Write-Host "gah account : $GahUser@$JumpHost"
    Write-Host ''

    if ($Uninstall) { Invoke-Uninstall -Target $target; Write-Host ''; Write-Host 'UNINSTALL COMPLETE' }
    else            { Invoke-Install   -Target $target; Write-Host ''; Write-Host 'INSTALL COMPLETE' }
}
finally {
    Dismount-UserHive
}
