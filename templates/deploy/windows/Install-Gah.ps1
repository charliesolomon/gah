# Install-Gah.ps1 - install (or update) a GAH deployment package for the current
# Windows user. Run it from inside the unpacked package folder:
#
#   .\Install-Gah.ps1 [-GitLabToken <token>] [-NoPrompt]
#
# What it does: copies the package to %LOCALAPPDATA%\gah\<package>, verifies and
# unpacks the pinned fd/ripgrep archives, stores the GitLab token and any API
# keys the deployment collects as user environment variables, writes
# current.txt, creates the desktop shortcut and a `gg` alias in the PowerShell
# profile. Idempotent: rerun to repair. -Update is what the launcher passes
# when it has already placed a newer package and only needs it finalised.
#
# Needs: Windows PowerShell 5.1+, node 22+ on PATH.
param(
    [string]$GitLabToken = '',
    [switch]$NoPrompt,
    [switch]$Update
)
$ErrorActionPreference = 'Stop'

$Src    = Split-Path -Parent $MyInvocation.MyCommand.Path
$Deploy = Get-Content -LiteralPath (Join-Path $Src 'deploy.json') -Raw | ConvertFrom-Json
$Root   = Join-Path $env:LOCALAPPDATA 'gah'
$Dest   = Join-Path $Root $Deploy.packageName
function Ok($m) { Write-Host "  OK: $m" }
function Warn($m) { [Console]::Error.WriteLine("  ! $m") }
function Expand-Zip($zip, $dest) {
    New-Item -ItemType Directory -Force -Path $dest | Out-Null
    try { Expand-Archive -LiteralPath $zip -DestinationPath $dest -Force }
    catch { & "$env:SystemRoot\System32\tar.exe" -xf $zip -C $dest; if ($LASTEXITCODE -ne 0) { throw "could not extract $zip" } }
}

Write-Host ""
Write-Host "$($Deploy.shortcutName) ($($Deploy.packageName), gah $($Deploy.gahVersion))"
Write-Host ""

# --- Node ---------------------------------------------------------------------
$nodeVersion = ''
try { $nodeVersion = (& node --version 2>$null) } catch {}
if (-not $nodeVersion -or [int]($nodeVersion.TrimStart('v').Split('.')[0]) -lt 22) {
    Write-Host "Node.js 22 or newer is required and was not found on PATH (got '$nodeVersion')."
    Write-Host "Install Node.js LTS, open a new PowerShell window, and run this installer again."
    exit 1
}
Ok "node $nodeVersion"

# --- Copy the package --------------------------------------------------------------
if ((Resolve-Path $Src).Path -ne (Resolve-Path -LiteralPath $Dest -ErrorAction SilentlyContinue).Path) {
    New-Item -ItemType Directory -Force -Path $Root | Out-Null
    if (Test-Path $Dest) { Remove-Item -Recurse -Force $Dest }
    Copy-Item -LiteralPath $Src -Destination $Dest -Recurse
}
Ok "installed to $Dest"

# --- Tools: verify against the pinned checksums, then unpack -----------------------------
$bin = Join-Path $Dest 'bin'
New-Item -ItemType Directory -Force -Path $bin | Out-Null
$arch = if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64') { 'aarch64' } else { 'x86_64' }
foreach ($line in (Get-Content -LiteralPath (Join-Path $Dest 'tools\SHA256SUMS'))) {
    if (-not $line.Trim()) { continue }
    $want, $asset = ($line -split '\s+', 2)
    if ($asset -notmatch $arch) { continue }
    $zip = Join-Path $Dest "tools\$asset"
    $got = (Get-FileHash -LiteralPath $zip -Algorithm SHA256).Hash.ToLower()
    if ($got -ne $want.ToLower()) { Write-Host "checksum mismatch for $asset - refusing to install it"; exit 1 }
    $tmp = Join-Path $Dest "tools\x-$([guid]::NewGuid().ToString('N'))"
    Expand-Zip $zip $tmp
    foreach ($exe in @('fd.exe', 'rg.exe')) {
        $found = Get-ChildItem -LiteralPath $tmp -Recurse -Filter $exe | Select-Object -First 1
        if ($found) { Copy-Item -LiteralPath $found.FullName -Destination (Join-Path $bin $exe) -Force; Ok "$exe ($asset)" }
    }
    Remove-Item -Recurse -Force $tmp
}

# --- GitLab token (skippable: an internal-visible project needs none) -----------------------
if (-not $Update) {
    if (-not $GitLabToken -and -not $NoPrompt) {
        $secure = Read-Host "  GitLab token for $($Deploy.gitlab.url) (read_api; Enter to skip)" -AsSecureString
        $GitLabToken = [Runtime.InteropServices.Marshal]::PtrToStringAuto([Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure))
    }
    if ($GitLabToken) {
        [Environment]::SetEnvironmentVariable('GAH_GITLAB_TOKEN', $GitLabToken, 'User'); $env:GAH_GITLAB_TOKEN = $GitLabToken
        Ok "GitLab token stored for this user"
    } else { Ok "no GitLab token (the project must be visible without one)" }

    # --- API keys the deployment collects via environment variables ------------------------
    foreach ($e in @($Deploy.providersEnv)) {
        if (-not $e) { continue }
        if ([Environment]::GetEnvironmentVariable($e.variable, 'User')) { Ok "$($e.provider): key already set ($($e.variable))"; continue }
        if ($NoPrompt) { Warn "$($e.provider): set $($e.variable) as a user environment variable before launching"; continue }
        $secure = Read-Host "  API key for $($e.provider)" -AsSecureString
        $key = [Runtime.InteropServices.Marshal]::PtrToStringAuto([Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure))
        if ($key) { [Environment]::SetEnvironmentVariable($e.variable, $key, 'User'); Ok "$($e.provider): key stored ($($e.variable))" }
        else { Warn "$($e.provider): no key given; set $($e.variable) later" }
    }
    foreach ($p in @($Deploy.providersLogin)) { if ($p) { Ok "$($p): run /login in the agent on first start and paste your API key" } }
}

# --- Make this the current package -------------------------------------------------------
Set-Content -LiteralPath (Join-Path $Root 'current.txt') -Value $Deploy.packageName -NoNewline
$stub = Join-Path $Root 'gah-launch.ps1'
@'
# gah-launch.ps1 - stable entry point: runs the launcher of whichever package current.txt names.
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$Current = (Get-Content -LiteralPath (Join-Path $Root 'current.txt') -Raw).Trim()
& (Join-Path $Root "$Current\gah.ps1") @args
$rc = $LASTEXITCODE
# From the desktop shortcut the window would close before an error could be read.
if ($rc -ne 0 -and $env:GAH_FROM_SHORTCUT) { Write-Host ""; Read-Host "gah exited with code $rc. Press Enter to close" | Out-Null }
exit $rc
'@ | Set-Content -LiteralPath $stub
Ok "current package: $($Deploy.packageName)"

if (-not $Update) {
    # --- Desktop shortcut --------------------------------------------------------------------
    $desktop = [Environment]::GetFolderPath('Desktop')
    $lnk = Join-Path $desktop "$($Deploy.shortcutName).lnk"
    $sh = New-Object -ComObject WScript.Shell
    $sc = $sh.CreateShortcut($lnk)
    $sc.TargetPath = "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe"
    $sc.Arguments = "-NoLogo -ExecutionPolicy Bypass -Command `"`$env:GAH_FROM_SHORTCUT='1'; & '$stub'`""
    $sc.WorkingDirectory = $env:USERPROFILE
    $sc.Description = "$($Deploy.shortcutName) (gah)"
    $sc.IconLocation = "$env:SystemRoot\System32\SHELL32.dll,165"
    $sc.Save()
    Ok "desktop shortcut: $($Deploy.shortcutName)"

    # --- gg alias in the profile ---------------------------------------------------------------
    $marker = '# gah deployment alias'
    $line = "function gg { & `"$stub`" @args }  $marker"
    if (-not (Test-Path $PROFILE)) { New-Item -ItemType File -Force -Path $PROFILE | Out-Null }
    $profileText = Get-Content -LiteralPath $PROFILE -Raw
    if ($null -eq $profileText) { $profileText = '' }
    if ($profileText -notmatch [regex]::Escape($marker)) {
        # Append on a line of its own: a profile that does not end in a newline
        # would otherwise absorb the function into its last statement.
        $prefix = if ($profileText.Length -gt 0 -and -not $profileText.EndsWith("`n")) { "`r`n" } else { '' }
        Add-Content -LiteralPath $PROFILE -Value ($prefix + $line)
        Ok "'gg' alias added to $PROFILE"
    } else { Ok "'gg' alias already in profile" }

    Write-Host ""
    Write-Host "Done. Double-click '$($Deploy.shortcutName)' on the desktop, or open a new PowerShell window and type gg."
    Write-Host "The first launch fetches your organisation's skills from $($Deploy.gitlab.url)."
}
