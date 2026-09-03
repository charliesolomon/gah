# Uninstall-Gah.ps1 - remove a GAH deployment package installed by Install-Gah.ps1
# for the current Windows user.
#
#   .\Uninstall-Gah.ps1 [-Purge] [-KeepSecrets]
#
# Removes: every installed package under %LOCALAPPDATA%\gah (with the skills
# cache, downloads, current.txt and the launcher stub), the desktop shortcut,
# the `gg` alias line from the PowerShell profile, and the GitLab token and any
# API-key variables the installer stored (unless -KeepSecrets). Leaves the
# agent's own state in ~\.gah (auth.json with /login keys, audit log, sessions)
# unless -Purge. Idempotent: safe to run twice. Lives at %LOCALAPPDATA%\gah\
# after install so it survives package updates; also in every package.
param(
    [switch]$Purge,
    [switch]$KeepSecrets
)
$ErrorActionPreference = 'Stop'
$Root = Join-Path $env:LOCALAPPDATA 'gah'
function Ok($m) { Write-Host "  OK: $m" }

# Whatever deploy.json we can find tells us the shortcut name and the variables.
$deploys = @()
if (Test-Path $Root) {
    foreach ($f in (Get-ChildItem -LiteralPath $Root -Directory | ForEach-Object { Join-Path $_.FullName 'deploy.json' })) {
        if (Test-Path $f) { try { $deploys += (Get-Content -LiteralPath $f -Raw | ConvertFrom-Json) } catch {} }
    }
}
$here = Join-Path (Split-Path -Parent $MyInvocation.MyCommand.Path) 'deploy.json'
if ((Test-Path $here)) { try { $deploys += (Get-Content -LiteralPath $here -Raw | ConvertFrom-Json) } catch {} }

Write-Host ""
Write-Host "Uninstalling GAH for $env:USERNAME"
Write-Host ""

# --- Desktop shortcuts -------------------------------------------------------------
$desktop = [Environment]::GetFolderPath('Desktop')
foreach ($d in $deploys) {
    $lnk = Join-Path $desktop "$($d.shortcutName).lnk"
    if (Test-Path $lnk) { Remove-Item -LiteralPath $lnk -Force; Ok "removed shortcut $($d.shortcutName)" }
}

# --- Profile alias -------------------------------------------------------------------
$marker = '# gah deployment alias'
if (Test-Path $PROFILE) {
    $lines = Get-Content -LiteralPath $PROFILE
    $kept = @($lines | Where-Object { $_ -notmatch [regex]::Escape($marker) })
    if ($kept.Count -ne $lines.Count) { Set-Content -LiteralPath $PROFILE -Value $kept; Ok "removed the gg alias from $PROFILE" }
}

# --- Stored secrets ------------------------------------------------------------------
if (-not $KeepSecrets) {
    $vars = @('GAH_GITLAB_TOKEN')
    foreach ($d in $deploys) { foreach ($e in @($d.providersEnv)) { if ($e -and $e.variable) { $vars += $e.variable } } }
    foreach ($v in ($vars | Select-Object -Unique)) {
        if ([Environment]::GetEnvironmentVariable($v, 'User')) {
            [Environment]::SetEnvironmentVariable($v, $null, 'User'); Ok "cleared user environment variable $v"
        }
    }
} else { Ok "kept stored secrets (-KeepSecrets)" }

# --- The install root ------------------------------------------------------------------
if (Test-Path $Root) {
    Remove-Item -LiteralPath $Root -Recurse -Force
    Ok "removed $Root (packages, skills cache, downloads)"
} else { Ok "nothing installed at $Root" }

# --- Agent state -----------------------------------------------------------------------
$state = Join-Path $env:USERPROFILE '.gah'
if ($Purge) {
    if (Test-Path $state) { Remove-Item -LiteralPath $state -Recurse -Force; Ok "removed $state (auth.json, audit log, sessions)" }
} elseif (Test-Path $state) {
    Ok "kept $state (API keys from /login, audit log, sessions); rerun with -Purge to remove it"
}

Write-Host ""
Write-Host "Done. Open a new PowerShell window: the gg alias and the stored variables are gone from new sessions."
