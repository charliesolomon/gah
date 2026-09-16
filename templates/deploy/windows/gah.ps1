# gah.ps1 - packaged GAH launcher for Windows. Lives inside the installed
# package directory next to deploy.json, and is started by the desktop shortcut
# through <root>\gah-launch.ps1 (which reads current.txt, so updates survive).
#
# On every launch: check the GitLab package registry for a newer package and
# switch to it; fetch the skills repository as an archive when its branch head
# moved; run the repository's setup\NN-*.ps1 steps; export the deployment's
# environment; start the agent. The launcher carries no policy of its own -- the
# policy pack baked into gah-policy\ is force-loaded by the binary (patch 0020)
# and the environment below only says what the admin decided in gah-deploy.json.
#
# Windows PowerShell 5.1 compatible. Needs node on PATH; nothing else.
$ErrorActionPreference = 'Stop'

$Here   = Split-Path -Parent $MyInvocation.MyCommand.Path      # <root>\<package>
$Root   = Split-Path -Parent $Here                              # %LOCALAPPDATA%\gah

# A wrapper or alias may hand the arguments over as one nested array (`$args`
# rather than `@args`); flatten so a subcommand is still seen as one.
$GahArgs = @()
foreach ($a in $args) {
    if ($null -ne $a -and $a -isnot [string] -and $a -is [System.Collections.IEnumerable]) { foreach ($b in $a) { $GahArgs += $b } }
    else { $GahArgs += $a }
}
# The subcommand is not necessarily the first argument. A wrapper commonly
# injects flags ahead of the person's own arguments --
#   function gah { & '<path>\bin\gah.ps1' --skill '<dir>' @args }
# -- so `gah init-kb <dir>` arrives as `--skill <dir> init-kb <dir>`. Find the
# first bare `init`/`init-kb` token instead, ignoring one that is the value of a
# preceding flag (`--skill init-kb` names a directory, not a subcommand).
$SubCommand = ''
$SubTarget  = ''
for ($i = 0; $i -lt $GahArgs.Count; $i++) {
    $tok = [string]$GahArgs[$i]
    if (@('init', 'init-kb') -notcontains $tok) { continue }
    if ($i -gt 0 -and ([string]$GahArgs[$i - 1]).StartsWith('-')) { continue }
    $SubCommand = $tok
    if ($i + 1 -lt $GahArgs.Count) { $SubTarget = [string]$GahArgs[$i + 1] }
    break
}

# One shape cannot be recovered: a wrapper that joins its arguments into a
# single string (`& gah.ps1 "$args"`), which arrives as "init-kb C:\path" in one
# argument. Detect the exact shape -- a subcommand word, then one token with no
# spaces -- and say what is wrong, rather than sending those words to the model
# as a question. A genuine prompt beginning with the word "init" has more than
# one word after it and is not caught.
if ($GahArgs.Count -eq 1 -and $GahArgs[0] -is [string] -and $GahArgs[0] -match '^(init|init-kb)\s+(\S+)$') {
    [Console]::Error.WriteLine(@"
gah: received '$($GahArgs[0])' as a single argument, so '$($Matches[1])' could not
be read as a subcommand. The wrapper or alias calling this script is joining its
arguments into one string. Use the splat form instead:

  function gah { & "<path>\bin\gah.ps1" @args }     # not: `$args, and not: "`$args"

Or call the script directly:  .\bin\gah.ps1 $($Matches[1]) $($Matches[2])
"@)
    exit 2
}

# Scaffolding subcommands belong to a gah checkout, not to an installed package:
# the templates they copy are not shipped here. Caught explicitly because the
# alternative is silent and baffling -- every argument this launcher does not
# recognise is passed to the agent, so `gah init-kb ..\kb` starts a session and
# sends "init-kb" to the model as a question.
if ($SubCommand) {
    [Console]::Error.WriteLine(@"
gah: '$SubCommand' scaffolds a repository and is only available in a gah checkout,
not in an installed package. From a checkout:

  .\bin\gah.ps1 $SubCommand <directory>

Your administrator normally does this once for the organisation and shares the
result; see docs/SKILLS.md and docs/KB.md in the gah repository.
"@)
    exit 2
}

$Deploy = Get-Content -LiteralPath (Join-Path $Here 'deploy.json') -Raw | ConvertFrom-Json
$InfoOnly = $false
foreach ($flag in @('--help', '-h', '--version', '-v')) { if ($GahArgs -contains $flag) { $InfoOnly = $true } }


$GitLab  = $Deploy.gitlab.url.TrimEnd('/')
# Every GitLab call carries the same extras: the token header, the deployment's
# proxy if it names one, and the user's client certificate when the front-end
# demands mutual TLS (thumbprint chosen at install time).
$Req = @{ Headers = @{} }
if ($env:GAH_GITLAB_TOKEN) { $Req.Headers['PRIVATE-TOKEN'] = $env:GAH_GITLAB_TOKEN }
# Proxy: gitlab.proxy in deploy.json forces a URL, "none" forces a direct
# connection, null uses this machine's proxy environment (HTTPS_PROXY, then
# HTTP_PROXY, honouring NO_PROXY) so different sites keep their own settings;
# with none of those set, Invoke-* falls back to the Windows proxy settings.
function Resolve-Proxy($hostName) {
    $cfg = $Deploy.gitlab.proxy
    if ($cfg -eq 'none') { return $null }
    if ($cfg) { return $cfg }
    $envProxy = if ($env:HTTPS_PROXY) { $env:HTTPS_PROXY } elseif ($env:HTTP_PROXY) { $env:HTTP_PROXY } else { $null }
    if (-not $envProxy) { return $null }
    foreach ($skip in (($env:NO_PROXY -split '[,; ]') | Where-Object { $_ })) {
        $s = $skip.Trim().TrimStart('.').TrimStart('*')
        if ($hostName -eq $s -or $hostName.EndsWith(".$s")) { return $null }
    }
    return $envProxy
}
$ProxyUrl = Resolve-Proxy ([uri]$GitLab).Host
if ($ProxyUrl) { $Req.Proxy = $ProxyUrl }
if ($env:GAH_GITLAB_CERT_THUMBPRINT) { $Req.CertificateThumbprint = $env:GAH_GITLAB_CERT_THUMBPRINT }
function Warn($m) { [Console]::Error.WriteLine("gah: $m") }
function Enc($s) { [uri]::EscapeDataString($s) }
function Get-Api($path) { Invoke-RestMethod -Uri "$GitLab/api/v4/$path" @Req -TimeoutSec 20 }
function Get-File($url, $dest) { Invoke-WebRequest -Uri $url @Req -OutFile $dest -TimeoutSec 300 -UseBasicParsing }
function Expand-Zip($zip, $dest) {
    New-Item -ItemType Directory -Force -Path $dest | Out-Null
    try { Expand-Archive -LiteralPath $zip -DestinationPath $dest -Force }
    catch { & "$env:SystemRoot\System32\tar.exe" -xf $zip -C $dest; if ($LASTEXITCODE -ne 0) { throw "could not extract $zip" } }
}

# --- 1. Self-update -----------------------------------------------------------
# Newest published version of this package; switch to it and re-launch from it.
# Any failure here is a warning: the installed version keeps working.
if (-not $InfoOnly -and -not $env:GAH_NO_UPDATE) {
    try {
        $proj = Enc $Deploy.gitlab.project
        $pkgs = @(Get-Api "projects/$proj/packages?package_name=$($Deploy.gitlab.package)&order_by=version&sort=desc&per_page=5")
        $latest = $null
        foreach ($p in $pkgs) { if ($p.name -eq $Deploy.gitlab.package) { $latest = $p.version; break } }
        if ($latest -and ([version]$latest -gt [version]$Deploy.version)) {
            $slug    = $Deploy.packageName -replace ("-" + [regex]::Escape($Deploy.version) + "$"), ''
            $newName = "$slug-$latest"
            $dl      = Join-Path $Root 'downloads'
            New-Item -ItemType Directory -Force -Path $dl | Out-Null
            $zip = Join-Path $dl "$newName.zip"
            $base = "$GitLab/api/v4/projects/$proj/packages/generic/$($Deploy.gitlab.package)/$latest"
            Write-Host "gah: updating to $latest ..."
            Get-File "$base/$newName.zip" $zip
            Get-File "$base/$newName.zip.sha256" "$zip.sha256"
            $want = ((Get-Content -LiteralPath "$zip.sha256" -Raw) -split '\s+')[0].ToLower()
            $got  = (Get-FileHash -LiteralPath $zip -Algorithm SHA256).Hash.ToLower()
            if ($want -ne $got) { throw "checksum mismatch for $newName.zip" }
            $stage = Join-Path $dl "stage-$latest"
            if (Test-Path $stage) { Remove-Item -Recurse -Force $stage }
            Expand-Zip $zip $stage
            if (-not (Test-Path (Join-Path $stage "$newName\gah.ps1"))) { throw "package $newName has no launcher" }
            if (Test-Path (Join-Path $Root $newName)) { Remove-Item -Recurse -Force (Join-Path $Root $newName) }
            Move-Item -LiteralPath (Join-Path $stage $newName) -Destination (Join-Path $Root $newName)
            Remove-Item -Recurse -Force $stage, $zip, "$zip.sha256" -ErrorAction SilentlyContinue
            # The new package's installer unpacks its own tools and rewrites current.txt.
            & powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File (Join-Path $Root "$newName\Install-Gah.ps1") -Update
            $env:GAH_NO_UPDATE = '1'
            & (Join-Path $Root "$newName\gah.ps1") @GahArgs
            exit $LASTEXITCODE
        }
    } catch {
        Warn "update check failed - continuing with $($Deploy.version) ($($_.Exception.Message))"
    }
}

# --- 2. Skills: the repository as an archive at its branch head -------------------
$SkillsRoot = Join-Path $Root 'skills'
$CurrentFile = Join-Path $SkillsRoot 'current.txt'
$Current = if (Test-Path $CurrentFile) { (Get-Content -LiteralPath $CurrentFile -Raw).Trim() } else { '' }
if (-not $InfoOnly) {
    try {
        $sproj  = Enc $Deploy.skills.project
        $branch = $Deploy.skills.branch
        $head   = (Get-Api "projects/$sproj/repository/branches/$(Enc $branch)").commit.id
        if ($head -and $head -ne $Current) {
            $tmp = Join-Path $SkillsRoot "tmp-$head"
            if (Test-Path $tmp) { Remove-Item -Recurse -Force $tmp }
            New-Item -ItemType Directory -Force -Path $tmp | Out-Null
            $zip = Join-Path $tmp 'repo.zip'
            Get-File "$GitLab/api/v4/projects/$sproj/repository/archive.zip?sha=$head" $zip
            Expand-Zip $zip (Join-Path $tmp 'x')
            $top = @(Get-ChildItem -LiteralPath (Join-Path $tmp 'x') -Directory)
            if ($top.Count -ne 1) { throw "unexpected archive layout" }
            $dest = Join-Path $SkillsRoot $head
            if (Test-Path $dest) { Remove-Item -Recurse -Force $dest }
            Move-Item -LiteralPath $top[0].FullName -Destination $dest
            Remove-Item -Recurse -Force $tmp
            Set-Content -LiteralPath $CurrentFile -Value $head -NoNewline
            if ($Current -and (Test-Path (Join-Path $SkillsRoot $Current))) { Remove-Item -Recurse -Force (Join-Path $SkillsRoot $Current) -ErrorAction SilentlyContinue }
            $Current = $head
            Write-Host "gah: skills updated to $($head.Substring(0,8))"
        }
    } catch {
        Warn "skills update failed - continuing with the local copy ($($_.Exception.Message))"
    }
}
$Skills = if ($Current) { Join-Path $SkillsRoot $Current } else { '' }
if (-not $InfoOnly -and -not ($Skills -and (Test-Path (Join-Path $Skills 'skills'))) -and -not $env:GAH_ALLOW_NO_SKILLS) {
    Warn "no skills available (repository $($Deploy.skills.project) could not be fetched). Check GAH_GITLAB_TOKEN and try again."
    exit 1
}

# --- 3. Environment: what the admin decided, nothing else ---------------------------
foreach ($prop in $Deploy.env.PSObject.Properties) { Set-Item -Path "Env:$($prop.Name)" -Value $prop.Value }
if (-not (Test-Path Env:GAH_BUILTIN_MODELS)) { $env:GAH_BUILTIN_MODELS = '' }
if (-not (Test-Path Env:GAH_ALLOWED_HOSTS))  { $env:GAH_ALLOWED_HOSTS  = '' }
$env:GAH_ALLOW_MODELS_JSON = ''                                   # the endpoint is baked; models.json would route around it
$env:GAH_PROVIDERS_FILE    = Join-Path $Here 'gah-policy\providers.json'
$env:PATH = (Join-Path $Here 'bin') + ';' + $env:PATH               # fd.exe, rg.exe

# --- 4. Setup steps from the skills repository ------------------------------------
if (-not $InfoOnly -and $Skills -and -not $env:GAH_SKIP_SETUP) {
    $setup = Join-Path $Skills 'setup'
    if (Test-Path $setup) {
        foreach ($step in (Get-ChildItem -LiteralPath $setup -Filter '[0-9]*.ps1' | Sort-Object Name)) {
            try { & $step.FullName } catch { Warn "setup step $($step.Name) failed - continuing" }
        }
    }
}

# --- 5. Start -------------------------------------------------------------------
$SkillArgs = @()
if ($Skills) {
    $SkillArgs += @('--no-skills', '--skill', (Join-Path $Skills 'skills'))
    if (Test-Path (Join-Path $Skills 'prompts')) { $SkillArgs += @('--prompt-template', (Join-Path $Skills 'prompts')) }
}

# The knowledge base (optional, docs/KB.md). Unlike the skills repository it is
# NOT fetched as an archive: it is the one thing the agent writes to, so it has
# to be a real git clone the person owns, named by GAH_KB_DIR. Reading and
# drafting work with what is in the package; proposing needs git on PATH.
# Loaded after the organisation's skills, so a shared skill of the same name wins.
if ($env:GAH_KB_DIR) {
    $KbSkills = Join-Path $env:GAH_KB_DIR 'skills'
    if (Test-Path $KbSkills) {
        $SkillArgs += @('--skill', $KbSkills)
        $KbPrompts = Join-Path $env:GAH_KB_DIR 'prompts'
        if (Test-Path $KbPrompts) { $SkillArgs += @('--prompt-template', $KbPrompts) }
    } elseif (-not $InfoOnly) {
        Warn "GAH_KB_DIR=$($env:GAH_KB_DIR) has no skills\ - knowledge base not loaded"
    }
}
& node (Join-Path $Here 'bundle\cli.js') --no-extensions @SkillArgs @GahArgs
exit $LASTEXITCODE
