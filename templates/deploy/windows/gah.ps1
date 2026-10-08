# gah.ps1 - packaged GAH launcher for Windows. Lives inside the installed
# package directory next to deploy.json, and is started by the desktop shortcut
# through <root>\gah-launch.ps1 (which reads current.txt, so updates survive).
#
# On every launch: make sure Node is there; check the GitLab package registry
# for a newer package and switch to it; fetch the skills repository as an
# archive when its branch head moved; export the deployment's environment; make
# sure a model is reachable with a working key (preflight.mjs, which also finds
# the proxy); run the repository's setup\NN-*.ps1 steps; start the agent.
# Neither GitLab nor skills is required to start (#135): without them the
# session shows the /setup-skills nudge, and the gah_setup tool calls back into
# this script (--gah-internal <op>) to finish setup from inside the session. The launcher carries no policy of its own -- the
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
# first bare init/init-kb/update-kb/update-skills token instead, ignoring one
# that is the value of a
# preceding flag (`--skill init-kb` names a directory, not a subcommand).
#
# Recognised here only so they can be refused: the templates they copy are not
# shipped in a package. Deliberately NOT published as GAH_SCAFFOLD_COMMANDS --
# that variable tells --help what this launcher can do, and the honest answer
# here is nothing. Cleared rather than left alone, so a value inherited from a
# checkout in the same shell cannot make this package's help advertise commands
# it refuses. Keep this list in step with bin/gah; check-skills.sh asserts it.
$ScaffoldCommands = @('init', 'init-kb', 'update-kb', 'update-skills')
$env:GAH_SCAFFOLD_COMMANDS = ''

$SubCommand = ''
$SubTarget  = ''
for ($i = 0; $i -lt $GahArgs.Count; $i++) {
    $tok = [string]$GahArgs[$i]
    if ($ScaffoldCommands -notcontains $tok) { continue }
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
if ($GahArgs.Count -eq 1 -and $GahArgs[0] -is [string] -and $GahArgs[0] -match ('^(' + ($ScaffoldCommands -join '|') + ')\s+(\S+)$')) {
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
gah: '$SubCommand' creates or refreshes a repository and is only available in a
gah checkout, not in an installed package. From a checkout:

  .\bin\gah.ps1 $SubCommand <directory>

Your administrator normally does this once for the organisation and shares the
result; see docs/SKILLS.md and docs/KB.md in the gah repository.
"@)
    exit 2
}

$Deploy = Get-Content -LiteralPath (Join-Path $Here 'deploy.json') -Raw | ConvertFrom-Json
# `--gah-internal <op>`: the onboarding extension's gah_setup tool calling back
# (status, sync-skills, store, list-certs). Prints one JSON line; starts nothing.
$Internal = if ($GahArgs.Count -ge 2 -and [string]$GahArgs[0] -eq '--gah-internal') { [string]$GahArgs[1] } else { '' }
# Values the installer or gah_setup stored for this user. A window opened before
# they were stored does not have them yet, so read them from the user scope.
foreach ($name in @('GAH_GITLAB_TOKEN', 'GAH_GITLAB_CERT_THUMBPRINT')) {
    if (-not (Test-Path "Env:$name")) { $v = [Environment]::GetEnvironmentVariable($name, 'User'); if ($v) { Set-Item -Path "Env:$name" -Value $v } }
}
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
function Get-StatusCode($err) { $r = $err.Exception.Response; if ($r) { [int]$r.StatusCode } else { 0 } }
# The same request without the token. A public project answers anonymously, and
# an expired or mistyped token would otherwise turn that answer into a 401.
function Get-Anon { $a = $Req.Clone(); $a.Headers = @{}; $a }
function Get-Api($path) {
    try { Invoke-RestMethod -Uri "$GitLab/api/v4/$path" @Req -TimeoutSec 20 }
    catch {
        if ($Req.Headers.ContainsKey('PRIVATE-TOKEN') -and (Get-StatusCode $_) -eq 401) { $anon = Get-Anon; Invoke-RestMethod -Uri "$GitLab/api/v4/$path" @anon -TimeoutSec 20 }
        else { throw }
    }
}
function Get-File($url, $dest) {
    try { Invoke-WebRequest -Uri $url @Req -OutFile $dest -TimeoutSec 300 -UseBasicParsing }
    catch {
        if ($Req.Headers.ContainsKey('PRIVATE-TOKEN') -and (Get-StatusCode $_) -eq 401) { $anon = Get-Anon; Invoke-WebRequest -Uri $url @anon -OutFile $dest -TimeoutSec 300 -UseBasicParsing }
        else { throw }
    }
}
# HTTP status of one GitLab call, with or without the token; for gah_setup's status.
function Probe-Api($path, [bool]$withToken) {
    $p = if ($withToken) { $Req } else { Get-Anon }
    try { [int](Invoke-WebRequest -Uri "$GitLab/api/v4/$path" @p -TimeoutSec 15 -UseBasicParsing).StatusCode }
    catch { $c = Get-StatusCode $_; if ($c) { $c } else { "error: $($_.Exception.Message)" } }
}
function Expand-Zip($zip, $dest) {
    New-Item -ItemType Directory -Force -Path $dest | Out-Null
    try { Expand-Archive -LiteralPath $zip -DestinationPath $dest -Force }
    catch { & "$env:SystemRoot\System32\tar.exe" -xf $zip -C $dest; if ($LASTEXITCODE -ne 0) { throw "could not extract $zip" } }
}

# --- Skills: the repository as an archive at its branch head ----------------------
$SkillsRoot = Join-Path $Root 'skills'
$CurrentFile = Join-Path $SkillsRoot 'current.txt'
$Current = if (Test-Path $CurrentFile) { (Get-Content -LiteralPath $CurrentFile -Raw).Trim() } else { '' }
function Sync-Skills {
    $sproj  = Enc $Deploy.skills.project
    $branch = $Deploy.skills.branch
    $head   = (Get-Api "projects/$sproj/repository/branches/$(Enc $branch)").commit.id
    if ($head -and $head -ne $script:Current) {
        New-Item -ItemType Directory -Force -Path $SkillsRoot | Out-Null
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
        if ($script:Current -and (Test-Path (Join-Path $SkillsRoot $script:Current))) { Remove-Item -Recurse -Force (Join-Path $SkillsRoot $script:Current) -ErrorAction SilentlyContinue }
        $script:Current = $head
        if (-not $Internal) { Write-Host "gah: skills updated to $($head.Substring(0,8))" }
    }
}

# --- Internal operations for gah_setup (onboarding extension) ----------------------
function Out-Json($o) { Write-Output ($o | ConvertTo-Json -Compress -Depth 6); exit 0 }
if ($Internal -eq 'status') {
    $proj  = Enc $Deploy.gitlab.project
    $sproj = Enc $Deploy.skills.project
    $branchPath = "projects/$sproj/repository/branches/$(Enc $Deploy.skills.branch)"
    Out-Json ([ordered]@{
        ok = $true
        package = $Deploy.packageName
        version = $Deploy.version
        gitlab = [ordered]@{
            url = $GitLab; project = $Deploy.gitlab.project; package = $Deploy.gitlab.package
            skillsProject = $Deploy.skills.project; skillsBranch = $Deploy.skills.branch
            clientCertRequired = ($Deploy.gitlab.clientCert -eq 'user'); clientCertIssuer = $Deploy.gitlab.clientCertIssuer
            proxy = $(if ($ProxyUrl) { $ProxyUrl } else { 'system settings' })
            tokenConfigured = [bool]$env:GAH_GITLAB_TOKEN; certConfigured = [bool]$env:GAH_GITLAB_CERT_THUMBPRINT
        }
        probes = [ordered]@{
            packagesAnonymous = Probe-Api "projects/$proj/packages?package_name=$(Enc $Deploy.gitlab.package)&per_page=1" $false
            skillsAnonymous   = Probe-Api $branchPath $false
            skillsWithToken   = $(if ($env:GAH_GITLAB_TOKEN) { Probe-Api $branchPath $true } else { $null })
        }
        skills = [ordered]@{ current = $(if ($Current) { $Current } else { $null }) }
    })
}
if ($Internal -eq 'sync-skills') {
    try { Sync-Skills; Out-Json ([ordered]@{ ok = [bool]$Current; path = $(if ($Current) { Join-Path $SkillsRoot $Current } else { $null }); head = $Current }) }
    catch { Out-Json ([ordered]@{ ok = $false; error = $_.Exception.Message }) }
}
if ($Internal -eq 'store') {
    $name = if ($GahArgs.Count -ge 3) { [string]$GahArgs[2] } else { '' }
    if (@('GAH_GITLAB_TOKEN', 'GAH_GITLAB_CERT_THUMBPRINT') -notcontains $name) { Out-Json ([ordered]@{ ok = $false; error = "not a setting this launcher stores: $name" }) }
    $value = [Console]::In.ReadToEnd().Trim()
    if (-not $value) { Out-Json ([ordered]@{ ok = $false; error = 'empty value' }) }
    try { [Environment]::SetEnvironmentVariable($name, $value, 'User') }
    catch { Out-Json ([ordered]@{ ok = $false; error = "could not store ${name}: $($_.Exception.Message)" }) }
    Out-Json ([ordered]@{ ok = $true; stored = $name })
}
if ($Internal -eq 'list-certs') {
    # Same filter and order as Install-Gah.ps1: a private key, not expired, usable
    # for client authentication; git's own choice first, then the named issuer's.
    $gitThumb = ''
    try { $gc = (& git config --get-urlmatch http.sslcert $Deploy.gitlab.url 2>$null); if ($gc -match '([0-9A-Fa-f]{40})\s*$') { $gitThumb = $matches[1].ToUpper() } } catch {}
    $issuerHint = if ($Deploy.gitlab.clientCertIssuer) { [string]$Deploy.gitlab.clientCertIssuer } else { '' }
    $clientAuth = '1.3.6.1.5.5.7.3.2'
    $certs = @(Get-ChildItem Cert:\CurrentUser\My | Where-Object {
        $_.HasPrivateKey -and $_.NotAfter -gt (Get-Date) -and
        ((@($_.EnhancedKeyUsageList).Count -eq 0) -or (@($_.EnhancedKeyUsageList | ForEach-Object { $_.ObjectId }) -contains $clientAuth))
    })
    $rank = { param($c) if ($gitThumb -and $c.Thumbprint -eq $gitThumb) { 0 } elseif ($issuerHint -and $c.Issuer -like "*$issuerHint*") { 1 } elseif ($c.Subject -like "*$env:USERNAME*") { 2 } else { 3 } }
    $certs = @($certs | Sort-Object @{ Expression = { & $rank $_ } }, @{ Expression = 'NotAfter'; Descending = $true })
    $list = @($certs | ForEach-Object {
        $tag = if ($gitThumb -and $_.Thumbprint -eq $gitThumb) { ' - used by git for this GitLab' } elseif ($issuerHint -and $_.Issuer -like "*$issuerHint*") { " - issued by $issuerHint" } else { '' }
        [ordered]@{ thumbprint = $_.Thumbprint; label = ('{0} (issuer {1}, expires {2:yyyy-MM-dd}){3}' -f $_.Subject, ($_.Issuer -replace '^CN=', '' -replace ',.*$', ''), $_.NotAfter, $tag) }
    })
    Out-Json ([ordered]@{ ok = $true; certs = $list })
}
if ($Internal) { Out-Json ([ordered]@{ ok = $false; error = "unknown internal operation: $Internal" }) }

# --- Node: everything below needs it ------------------------------------------------
function Test-Node {
    try { $v = (& node --version 2>$null); if ("$v" -match '^v(\d+)\.') { return ([int]$Matches[1] -ge 22) } } catch {}
    return $false
}
if (-not (Test-Node)) {
    Warn "Node.js 22 or newer is needed to run gah, and was not found."
    $interactive = [Environment]::UserInteractive -and -not [Console]::IsInputRedirected
    if ($interactive -and (Get-Command winget -ErrorAction SilentlyContinue)) {
        $a = Read-Host "Install Node.js LTS now with winget? [Y/n]"
        if ($a -eq '' -or $a -match '^[yY]') {
            & winget install --id OpenJS.NodeJS.LTS -e --source winget --accept-package-agreements --accept-source-agreements
            # winget updates PATH for new windows; pick it up in this one.
            $env:PATH = [Environment]::GetEnvironmentVariable('PATH', 'Machine') + ';' + [Environment]::GetEnvironmentVariable('PATH', 'User')
        }
    }
    if (-not (Test-Node)) {
        Write-Host "Install Node.js LTS from https://nodejs.org (or ask your IT), open a new window, and start gah again."
        exit 1
    }
}

# --- 1. Self-update -----------------------------------------------------------
# Newest published version of this package; switch to it and re-launch from it.
# Any failure here is a warning: the installed version keeps working.
# GitLab problems are collected and reported as one line: without GitLab set up
# both steps fail for the same reason, and gah still starts.
$Problems = @()
if (-not $InfoOnly -and -not $env:GAH_NO_UPDATE) {
    try {
        $proj = Enc $Deploy.gitlab.project
        # Windows PowerShell 5.1's Invoke-RestMethod emits a JSON array as ONE
        # object rather than one per element; `ForEach-Object { $_ }` unrolls
        # it (PowerShell 7 already does). Without that, two or more published
        # versions made $p the whole list and $p.version an array.
        # The newest 100 by publication date, highest first by [version] -- the
        # order this launcher compares in -- rather than trusting the
        # registry's own version sort. Windows and Linux zips share one
        # registry package, so the update is the highest newer version that
        # holds this platform's zip: <name>-win11-<version>.zip.
        $pkgs = @(Get-Api "projects/$proj/packages?package_name=$(Enc $Deploy.gitlab.package)&order_by=created_at&sort=desc&per_page=100" | ForEach-Object { $_ })
        $slug = $Deploy.packageName -replace ("-" + [regex]::Escape($Deploy.version) + "$"), ''
        $newer = @(foreach ($p in $pkgs) {
            if ($p.name -ne $Deploy.gitlab.package) { continue }
            $v = $null
            if (-not [version]::TryParse([string]$p.version, [ref]$v)) { continue }
            if ($v -gt [version]$Deploy.version) { [pscustomobject]@{ v = $v; s = [string]$p.version; id = $p.id } }
        }) | Sort-Object v -Descending | Select-Object -First 10
        $latest = $null
        foreach ($c in $newer) {
            $files = @(Get-Api "projects/$proj/packages/$($c.id)/package_files?per_page=100" | ForEach-Object { $_ })
            if ($files | Where-Object { $_.file_name -eq "$slug-$($c.s).zip" }) { $latest = $c.s; break }
        }
        if ($latest) {
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
        $Problems += "update check: $($_.Exception.Message)"
    }
}

# --- 2. Skills --------------------------------------------------------------------
if (-not $InfoOnly) {
    try { Sync-Skills } catch { $Problems += "skills: $($_.Exception.Message)" }
}
$Skills = if ($Current -and (Test-Path (Join-Path (Join-Path $SkillsRoot $Current) 'skills'))) { Join-Path $SkillsRoot $Current } else { '' }
if ($Problems.Count -gt 0) {
    $what = if ($Skills) { "continuing with $($Deploy.version) and the local skills" } else { "continuing with $($Deploy.version), without shared skills" }
    Warn "GitLab not available ($($Problems[0])) - $what"
}

# --- 3. Environment: what the admin decided, nothing else ---------------------------
foreach ($prop in $Deploy.env.PSObject.Properties) { Set-Item -Path "Env:$($prop.Name)" -Value $prop.Value }
if (-not (Test-Path Env:GAH_BUILTIN_MODELS)) { $env:GAH_BUILTIN_MODELS = '' }
if (-not (Test-Path Env:GAH_ALLOWED_HOSTS))  { $env:GAH_ALLOWED_HOSTS  = '' }
$env:GAH_ALLOW_MODELS_JSON = ''                                   # the endpoint is baked; models.json would route around it
$env:GAH_PROVIDERS_FILE    = Join-Path $Here 'gah-policy\providers.json'
$env:PATH = (Join-Path $Here 'bin') + ';' + $env:PATH               # fd.exe, rg.exe
# For the onboarding extension: who started the session, and how to call back.
$env:GAH_LAUNCHER_KIND   = 'package'
$env:GAH_LAUNCHER_SCRIPT = $MyInvocation.MyCommand.Path

# --- 3b. Preflight: a model must be reachable, with a working key ---------------------
# preflight.mjs finds the route (direct, HTTPS_PROXY, the Windows system proxy,
# the deployment's suggestion, or asks) and makes sure at least one provider has
# a key it accepts, asking for one (masked) when none does. Node does not use
# the Windows proxy settings by itself: the route found is exported below.
if (-not $InfoOnly -and -not $env:GAH_SKIP_PREFLIGHT) {
    $pfArgs = @('--deploy', (Join-Path $Here 'deploy.json'), '--providers', $env:GAH_PROVIDERS_FILE,
                '--state', (Join-Path $Root 'preflight-state.json'), '--out', (Join-Path $Root 'preflight-out.json'))
    try {
        $first = [uri]((Get-Content -LiteralPath $env:GAH_PROVIDERS_FILE -Raw | ConvertFrom-Json).providers[0].baseUrl)
        $sys = [System.Net.WebRequest]::GetSystemWebProxy().GetProxy($first)
        if ($sys -and $sys.AbsoluteUri -ne $first.AbsoluteUri) { $pfArgs += @('--system-proxy', $sys.AbsoluteUri.TrimEnd('/')) }
    } catch {}
    Remove-Item -LiteralPath (Join-Path $Root 'preflight-out.json') -ErrorAction SilentlyContinue
    & node (Join-Path $Here 'preflight.mjs') @pfArgs
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
    $pf = Get-Content -LiteralPath (Join-Path $Root 'preflight-out.json') -Raw | ConvertFrom-Json
    if ($pf.proxy) { $env:HTTPS_PROXY = $pf.proxy; $env:HTTP_PROXY = $pf.proxy; $env:NODE_USE_ENV_PROXY = '1' }
    # A key preflight just stored is in the user scope, not in this window yet.
    foreach ($e in @($Deploy.providersEnv)) {
        if ($e -and -not (Test-Path "Env:$($e.variable)")) {
            $v = [Environment]::GetEnvironmentVariable($e.variable, 'User'); if ($v) { Set-Item -Path "Env:$($e.variable)" -Value $v }
        }
    }
}

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
# --no-skills always: the person's own folders are never searched for skills.
# The setup skills come from the policy (onboarding extension), not from here.
$SkillArgs = @('--no-skills')
if ($Skills) {
    $SkillArgs += @('--skill', (Join-Path $Skills 'skills'))
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
