# gah - launch PI with GAH policy-pack loaded, ignoring any user-global
# extensions/skills/themes that PI would otherwise auto-discover.
#
# PowerShell equivalent of bin/gah. The wrapper exists so that the policy
# enforced in this repo is the policy the user actually gets, regardless of
# what's in the user-global agent config dir.

$ErrorActionPreference = "Stop"

$Here = Split-Path -Parent $PSScriptRoot

# A wrapper or alias may hand the arguments over as one nested array -- that is
# what `& gah.ps1 $args` does, as against `@args` -- and then $args[0] is an
# array, not the subcommand. Flatten once, and use this everywhere below, so
# `gah init-kb <dir>` behaves the same however the person wired up their alias.
$GahArgs = @()
foreach ($a in $args) {
    if ($null -ne $a -and $a -isnot [string] -and $a -is [System.Collections.IEnumerable]) { foreach ($b in $a) { $GahArgs += $b } }
    else { $GahArgs += $a }
}
$PiCli = Join-Path $Here "vendor\pi\packages\coding-agent\dist\cli.js"
$PolicyDir = Join-Path $Here "packages\policy-pack\extensions"

# The subcommand is not necessarily the first argument. A wrapper commonly
# injects flags ahead of the person's own arguments --
#   function gah { & '<path>\bin\gah.ps1' --skill '<dir>' @args }
# -- so `gah init-kb <dir>` arrives as `--skill <dir> init-kb <dir>`. Find the
# first bare init/init-kb/update-kb/update-skills token instead, ignoring one
# that is the value of a preceding flag (`--skill init-kb` names a directory,
# not a subcommand).
$SubCommand = ''
$SubTarget  = ''
for ($i = 0; $i -lt $GahArgs.Count; $i++) {
    $tok = [string]$GahArgs[$i]
    if (@('init', 'init-kb', 'update-kb', 'update-skills') -notcontains $tok) { continue }
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
if ($GahArgs.Count -eq 1 -and $GahArgs[0] -is [string] -and $GahArgs[0] -match '^(init|init-kb|update-kb|update-skills)\s+(\S+)$') {
    [Console]::Error.WriteLine(@"
gah: received '$($GahArgs[0])' as a single argument, so '$($Matches[1])' could not
be read as a subcommand. The wrapper or alias calling this script is joining its
arguments into one string. Use the splat form instead:

  function gah { & "<path>\bin\gah.ps1" @args }     # not: `$args, and not: "`$args"

Or call the script directly:  .\bin\gah.ps1 $($Matches[1]) $($Matches[2])
"@)
    exit 2
}

# --- gah init --------------------------------------------------------------
# Handled before anything else: a new deployment scaffolds its skills repo
# first, and should not need a built PI to do it. Also breaks the circularity of
# a launcher that refuses to start without skills.
$TemplateDir = Join-Path $Here 'templates\skills-repo'

# The same, for the skills scaffold, plus the narrow set of files gah maintains
# inside a skills repository. Everything else there is the organisation's from
# the moment it runs `gah init`.
function Get-SkillsScaffoldId {
    try {
        $id = "$(& git -C $Here rev-parse --short 'HEAD:templates/skills-repo' 2>$null | Select-Object -First 1)".Trim()
        if ($id -match '^[0-9a-f]{4,}$') { return $id }
    } catch { }
    return ''
}
$SkillsManaged = @('skills/onboarding', 'skills/skill-authoring', 'setup')

# Reads a "scaffold <id>" marker, written by init/init-kb and updated by the
# update-* subcommands. Shared by the skills and knowledge-base scaffolds.
function Read-ScaffoldMarker([string]$Path) {
    if (-not (Test-Path $Path)) { return '' }
    $line = (Get-Content -Raw $Path).Trim()
    if ($line -match '^scaffold\s+(\S+)$') { return $Matches[1] }
    return ''
}
if ($SubCommand -eq 'init') {
    if (-not $SubTarget) { [Console]::Error.WriteLine('usage: gah.ps1 init <directory>'); exit 2 }
    $Target = $SubTarget
    if (-not (Test-Path $TemplateDir)) { [Console]::Error.WriteLine("gah: template missing at $TemplateDir"); exit 1 }
    if ((Test-Path $Target) -and (Get-ChildItem -Force $Target | Measure-Object).Count -gt 0) {
        [Console]::Error.WriteLine("gah: $Target exists and is not empty - refusing to overwrite"); exit 1
    }
    New-Item -ItemType Directory -Force -Path $Target | Out-Null
    Copy-Item -Recurse -Force (Join-Path $TemplateDir '*') $Target
    Set-Content -LiteralPath (Join-Path $Target '.skills-scaffold') -Value ("scaffold " + (Get-SkillsScaffoldId))
    $Full = (Resolve-Path $Target).Path
    Write-Host ""
    Write-Host "Created a skills repository in $Full"
    Write-Host ""
    Write-Host "  skills/     onboarding and skill-authoring, to start with"
    Write-Host "  setup/      steps that run before each session"
    Write-Host "  context/    what your organization knows"
    Write-Host ""
    Write-Host "Next:"
    Write-Host "  cd $Full; git init; git add .; git commit -m 'Initial skills repo'"
    Write-Host ""
    Write-Host "Then start a session with:"
    Write-Host "  `$env:GAH_SKILLS_DIR = '$Full\skills'; .\bin\gah.ps1"
    Write-Host ""
    exit 0
}

# --- gah update-skills -----------------------------------------------------
# A skills repository is the organisation's, not gah's -- with two exceptions.
# skill-authoring is gah's guidance on how to write the next skill, and
# onboarding answers "what can I do with this?" from the loaded set; both
# improve upstream, and until now an improvement reached only deployments
# created after it. The setup steps are mechanism and travel with them.
# Everything else is untouched: a tool that rewrites an organisation's own
# skills is a tool nobody runs twice.
if ($SubCommand -eq 'update-skills') {
    if (-not $SubTarget) { [Console]::Error.WriteLine('usage: gah.ps1 update-skills <directory>'); exit 2 }
    $Target = $SubTarget.TrimEnd('\', '/')
    if (-not (Test-Path $TemplateDir)) { [Console]::Error.WriteLine("gah: template missing at $TemplateDir"); exit 1 }
    # Accept either the repository or its skills\ directory, since
    # GAH_SKILLS_DIR points at the latter and that is what people have to hand.
    if ((Split-Path -Leaf $Target) -eq 'skills') { $Target = Split-Path -Parent $Target }
    if (-not (Test-Path (Join-Path $Target 'skills'))) {
        [Console]::Error.WriteLine("gah: $Target does not look like a skills repository (no skills\).")
        [Console]::Error.WriteLine("  To create one:  .\bin\gah.ps1 init $Target")
        exit 1
    }
    $Force = $GahArgs -contains '--force'
    $markerPath = Join-Path $Target '.skills-scaffold'
    $wantId = Get-SkillsScaffoldId
    $haveId = Read-ScaffoldMarker $markerPath
    if (-not $Force -and $wantId -and $haveId -eq $wantId) {
        Write-Host "The starter skills in $Target are already current ($wantId)."
        Write-Host "  To write the shipped files over local edits anyway:  .\bin\gah.ps1 update-skills $Target --force"
        exit 0
    }

    $IsGit = $false
    & git -C $Target rev-parse --git-dir *> $null
    if ($LASTEXITCODE -eq 0) { $IsGit = $true }
    if ($IsGit -and -not $Force) {
        $dirty = (& git -C $Target status --porcelain 2>$null | Out-String).Trim()
        if ($dirty) {
            [Console]::Error.WriteLine("gah: $Target has uncommitted changes.")
            [Console]::Error.WriteLine('  Commit or stash them first, so the update shows up cleanly in git diff.')
            [Console]::Error.WriteLine('  Or pass --force to write over them anyway.')
            exit 3
        }
    }
    if (-not $IsGit) { [Console]::Error.WriteLine("gah: $Target is not a git repository, so there is no undo. Continuing.") }

    $refreshed = @(); $skipped = @()
    foreach ($rel in $SkillsManaged) {
        $src = Join-Path $TemplateDir ($rel -replace '/', [System.IO.Path]::DirectorySeparatorChar)
        if (-not (Test-Path $src)) { continue }
        $dest = Join-Path $Target ($rel -replace '/', [System.IO.Path]::DirectorySeparatorChar)
        if (-not (Test-Path $dest) -and $IsGit) {
            $addedOnce = (& git -C $Target log --diff-filter=A --format=%H -1 -- $rel 2>$null | Out-String).Trim()
            if ($addedOnce) {
                # It was here and was deleted. Putting it back would undo a decision.
                $skipped += "  $rel (removed here - left out)"
                continue
            }
        }
        if (Test-Path $src -PathType Container) {
            New-Item -ItemType Directory -Force -Path $dest | Out-Null
            Copy-Item -Recurse -Force (Join-Path $src '*') $dest
        } else {
            New-Item -ItemType Directory -Force -Path (Split-Path -Parent $dest) | Out-Null
            Copy-Item -Force $src $dest
        }
        $refreshed += "  $rel"
    }
    Set-Content -LiteralPath $markerPath -Value ("scaffold " + $wantId)

    Write-Host ""
    Write-Host "Updated the starter skills in $Target"
    Write-Host ("  was: " + $(if ($haveId) { $haveId } else { 'unknown' }))
    Write-Host ("  now: " + $(if ($wantId) { $wantId } else { 'unknown' }))
    Write-Host ""
    if ($refreshed.Count) { Write-Host "Refreshed:"; foreach ($l in $refreshed) { Write-Host $l } }
    if ($skipped.Count) { Write-Host "Left alone:"; foreach ($l in $skipped) { Write-Host $l } }
    if ($IsGit) {
        $changed = (& git -C $Target status --porcelain 2>$null | Out-String).Trim()
        if ($changed) {
            Write-Host ""
            Write-Host "Changed:"
            foreach ($line in ($changed -split "`n")) { if ($line.Trim()) { Write-Host ("  " + $line.Trim()) } }
            Write-Host ""
            Write-Host "Review with:  git -C $Target diff"
        }
    }
    Write-Host ""
    Write-Host "Your own skills, prompts and context were not touched."
    Write-Host ""
    exit 0
}

# --- gah init-kb -----------------------------------------------------------
# The knowledge base is the other half of the context the concept rests on, and
# unlike skills it is optional: a deployment without one simply has no kb-*
# skills. Scaffolded separately for that reason, and because the two are
# different repositories with different review rules -- skills are procedure,
# the knowledge base is fact.
$KbTemplateDir = Join-Path $Here 'templates\kb-repo'

# Which scaffold a knowledge base carries. Written on init and on update, read
# at launch to say when the tooling in a knowledge base has fallen behind --
# otherwise nobody finds out, because the scripts keep working and simply lack
# the fix.
#
# It is git's tree hash for templates\kb-repo, not the gah version or commit:
# that changes exactly when the scaffold's own contents change, so an unrelated
# commit does not make every knowledge base look stale, and it is the same value
# computed from bash or PowerShell, so a knowledge base updated on a host and
# read on a workstation agrees with itself. Empty outside a git checkout, and
# nothing warns on an empty value.
function Get-KbScaffoldId {
    try {
        # Validate the value rather than $LASTEXITCODE, which is not set at all
        # until some native command has run in this scope -- and $null -eq 0 is
        # false, so checking it silently discarded a perfectly good hash.
        $id = "$(& git -C $Here rev-parse --short 'HEAD:templates/kb-repo' 2>$null | Select-Object -First 1)".Trim()
        if ($id -match '^[0-9a-f]{4,}$') { return $id }
    } catch { }
    return ''
}

if ($SubCommand -eq 'init-kb') {
    if (-not $SubTarget) { [Console]::Error.WriteLine('usage: gah.ps1 init-kb <directory>'); exit 2 }
    $Target = $SubTarget
    if (-not (Test-Path $KbTemplateDir)) { [Console]::Error.WriteLine("gah: template missing at $KbTemplateDir"); exit 1 }
    if ((Test-Path $Target) -and (Get-ChildItem -Force $Target | Measure-Object).Count -gt 0) {
        [Console]::Error.WriteLine("gah: $Target exists and is not empty - refusing to overwrite"); exit 1
    }
    New-Item -ItemType Directory -Force -Path $Target | Out-Null
    Copy-Item -Recurse -Force (Join-Path $KbTemplateDir '*') $Target
    Set-Content -LiteralPath (Join-Path $Target '.kb-scaffold') -Value ("scaffold " + (Get-KbScaffoldId))
    $Full = (Resolve-Path $Target).Path
    Write-Host ""
    Write-Host "Created a knowledge base in $Full"
    Write-Host ""
    Write-Host "  articles/   what your organization knows, one Markdown file each"
    Write-Host "  skills/     kb-search, kb-article, kb-propose, kb-curate"
    Write-Host "  bin/        the scripts those skills call (.ps1 and .sh)"
    Write-Host ""
    Write-Host "Next:"
    Write-Host "  cd $Full; git init; git add .; git commit -m 'Initial knowledge base'"
    Write-Host ""
    Write-Host "Then start a session with:"
    Write-Host "  `$env:GAH_KB_DIR = '$Full'; .\bin\gah.ps1"
    Write-Host ""
    Write-Host "Ask it something you already know the answer to. It should tell you that"
    Write-Host "nothing covers it yet, and offer to record the gap - that is the loop starting."
    Write-Host ""
    exit 0
}

# --- gah update-kb ---------------------------------------------------------
# The scaffold ships tooling -- the scripts and the four skills -- into a
# repository that then fills up with an organisation's own articles. When the
# tooling gains a fix, init-kb is no help: it refuses a directory that has
# anything in it, which by then is every real knowledge base. This refreshes the
# tooling in place and leaves articles\ alone. Nothing is merged: git is the
# review, which is why it insists on a clean tree.
if ($SubCommand -eq 'update-kb') {
    if (-not $SubTarget) { [Console]::Error.WriteLine('usage: gah.ps1 update-kb <directory>'); exit 2 }
    $Target = $SubTarget
    if (-not (Test-Path $KbTemplateDir)) { [Console]::Error.WriteLine("gah: template missing at $KbTemplateDir"); exit 1 }
    if (-not (Test-Path (Join-Path $Target 'articles')) -or -not (Test-Path (Join-Path $Target 'bin'))) {
        [Console]::Error.WriteLine("gah: $Target does not look like a knowledge base (no articles\ and bin\).")
        [Console]::Error.WriteLine("  To create one:  .\bin\gah.ps1 init-kb $Target")
        exit 1
    }
    $Force = $GahArgs -contains '--force'

    # Already current: say so and touch nothing. Checked before the clean-tree
    # rule below, because a no-op is harmless and refusing one is baffling when
    # the uncommitted changes in question are the ones a previous run just made.
    $wantId = Get-KbScaffoldId
    $haveId = Read-ScaffoldMarker (Join-Path $Target '.kb-scaffold')
    if (-not $Force -and $wantId -and $haveId -eq $wantId) {
        Write-Host "The knowledge base tooling in $Target is already current ($wantId)."
        Write-Host "  To write the shipped files over local edits anyway:  .\bin\gah.ps1 update-kb $Target --force"
        exit 0
    }

    $IsGit = $false
    & git -C $Target rev-parse --git-dir *> $null
    if ($LASTEXITCODE -eq 0) { $IsGit = $true }
    if ($IsGit -and -not $Force) {
        $dirty = (& git -C $Target status --porcelain 2>$null | Out-String).Trim()
        if ($dirty) {
            [Console]::Error.WriteLine("gah: $Target has uncommitted changes.")
            [Console]::Error.WriteLine('  Commit or stash them first, so the update shows up cleanly in git diff.')
            [Console]::Error.WriteLine('  Or pass --force to write over them anyway.')
            exit 3
        }
    }
    if (-not $IsGit) { [Console]::Error.WriteLine("gah: $Target is not a git repository, so there is no undo. Continuing.") }

    $markerPath = Join-Path $Target '.kb-scaffold'
    $was = Read-ScaffoldMarker $markerPath
    if (-not $was) { $was = 'unknown' }
    # Only the tooling. articles\ is the organisation's, and README.md and
    # .gitignore are theirs to have edited; extra files of their own in these
    # directories are left in place, since nothing is deleted.
    foreach ($d in @('bin', 'skills', 'templates', 'prompts')) {
        $src = Join-Path $KbTemplateDir $d
        if (-not (Test-Path $src)) { continue }
        $dest = Join-Path $Target $d
        New-Item -ItemType Directory -Force -Path $dest | Out-Null
        Copy-Item -Recurse -Force (Join-Path $src '*') $dest
    }
    $now = Get-KbScaffoldId
    Set-Content -LiteralPath $markerPath -Value ("scaffold " + $now)

    Write-Host ""
    Write-Host "Updated the knowledge base tooling in $Target"
    Write-Host "  was: $was"
    Write-Host "  now: $now"
    Write-Host ""
    if ($IsGit) {
        $changed = (& git -C $Target status --porcelain -- bin skills templates prompts .kb-scaffold 2>$null | Out-String).Trim()
        if ($changed) {
            Write-Host "Changed:"
            foreach ($line in ($changed -split "`n")) { if ($line.Trim()) { Write-Host ("  " + $line.Trim()) } }
            Write-Host ""
            Write-Host "Review with:  git -C $Target diff"
            Write-Host "Undo with:    git -C $Target checkout -- bin skills templates prompts .kb-scaffold"
        } else {
            Write-Host "Nothing changed - the tooling was already current."
        }
    }
    Write-Host ""
    Write-Host "articles\ was not touched."
    Write-Host ""
    exit 0
}

# --- skills are required ---------------------------------------------------
# GAH exists to run skills; a session with none is a misconfiguration, not a
# lighter mode. Without this the policy layer loads with nothing to govern and
# the agent declines ordinary work, because the system prompt is written around
# skills that are not there.
$SkillsConfigured = $false
# Only --skill counts. --no-skills means "do not auto-discover", not "I want
# none" - deploy/host/gah-launch passes it on every launch to pin the loaded
# set, so honouring it here would exempt the shared host from the check.
if ($args -contains '--skill') { $SkillsConfigured = $true }
# --help and --version answer without a skills repo and start nothing, so they
# also skip the setup steps below. Computed at script scope on purpose: inside
# a Where-Object scriptblock, $args is the scriptblock's own (empty) list.
$InfoOnly = $false
foreach ($flag in @('--help', '-h', '--version', '-v')) { if ($GahArgs -contains $flag) { $InfoOnly = $true } }
if ($InfoOnly) { $SkillsConfigured = $true }
if ($env:GAH_ALLOW_NO_SKILLS) { $SkillsConfigured = $true }
if ($env:GAH_SKILLS_DIR -and (Test-Path $env:GAH_SKILLS_DIR)) { $SkillsConfigured = $true }
if (-not $SkillsConfigured) {
    Write-Host "GAH works with your organization's shared agents and skills."
    Write-Host "Set them up using:"
    Write-Host ""
    Write-Host "  .\bin\gah.ps1 init <directory>"
    Write-Host ""
    Write-Host "Then start a session with:"
    Write-Host "  `$env:GAH_SKILLS_DIR = '<directory>\skills'; .\bin\gah.ps1"
    Write-Host ""
    Write-Host "A knowledge base is optional and scaffolded separately (docs/KB.md):"
    Write-Host "  .\bin\gah.ps1 init-kb <directory>   then   `$env:GAH_KB_DIR = '<directory>'"
    Write-Host ""
    Write-Host "Refresh an existing one's scripts and skills, leaving its articles alone:"
    Write-Host "  .\bin\gah.ps1 update-kb <directory>"
    Write-Host ""
    Write-Host "Refresh the starter skills gah maintains, leaving your own alone:"
    Write-Host "  .\bin\gah.ps1 update-skills <directory>"
    Write-Host ""
    Write-Host "Or pass one directly for a single run:  .\bin\gah.ps1 --skill <path>"
    Write-Host ""
    Write-Host "To start a deliberately empty session:"
    Write-Host "  `$env:GAH_ALLOW_NO_SKILLS = '1'; .\bin\gah.ps1"
    exit 1
}

$SkillArgs = @()
if ($env:GAH_SKILLS_DIR -and (Test-Path $env:GAH_SKILLS_DIR)) {
    $SkillArgs = @('--skill', $env:GAH_SKILLS_DIR)
    # Prompt templates: the repo's prompts\ (sibling of skills\). See bin/gah.
    $PromptsDir = Join-Path (Split-Path -Parent $env:GAH_SKILLS_DIR) 'prompts'
    if (Test-Path $PromptsDir) { $SkillArgs += @('--prompt-template', $PromptsDir) }
}

# Say when the starter skills gah maintains are older than this build. Silent
# when the repository has none of them (a deployment that removed both has
# decided) or when this is not a checkout.
if ($env:GAH_SKILLS_DIR -and -not $InfoOnly -and (Test-Path $TemplateDir)) {
    $skillsRoot = Split-Path -Parent $env:GAH_SKILLS_DIR
    $skWant = Get-SkillsScaffoldId
    $skHave = Read-ScaffoldMarker (Join-Path $skillsRoot '.skills-scaffold')
    $skPresent = $false
    foreach ($rel in $SkillsManaged) {
        if (Test-Path (Join-Path $skillsRoot ($rel -replace '/', [System.IO.Path]::DirectorySeparatorChar))) { $skPresent = $true }
    }
    if ($skWant -and $skPresent -and $skHave -ne $skWant) {
        $at = if ($skHave) { "at $skHave, " } else { '' }
        [Console]::Error.WriteLine("gah: the starter skills in $skillsRoot are ${at}behind this checkout ($skWant)")
        [Console]::Error.WriteLine("     refresh them with:  .\bin\gah.ps1 update-skills $skillsRoot")
    }
}

# The knowledge base (optional, docs/KB.md) carries its own skills and prompts,
# so a deployment that has one gets the kb-* skills and a deployment that does
# not is unaffected. Its skills load AFTER the organisation's: where both define
# a name, the organisation's wins, which is the right way round for a set that
# ships as a scaffold.
if ($env:GAH_KB_DIR) {
    $KbSkills = Join-Path $env:GAH_KB_DIR 'skills'
    if (Test-Path $KbSkills) {
        $SkillArgs += @('--skill', $KbSkills)
    } elseif (-not $InfoOnly) {
        [Console]::Error.WriteLine("gah: GAH_KB_DIR=$($env:GAH_KB_DIR) has no skills\ - knowledge base not loaded")
    }
    $KbPrompts = Join-Path $env:GAH_KB_DIR 'prompts'
    if (Test-Path $KbPrompts) { $SkillArgs += @('--prompt-template', $KbPrompts) }
    # Say when the tooling in the knowledge base is older than this build. The
    # scripts keep working when they fall behind; they simply lack the fix,
    # which is a failure nobody notices without being told.
    if (-not $InfoOnly -and (Test-Path $KbTemplateDir)) {
        $want = Get-KbScaffoldId
        $have = Read-ScaffoldMarker (Join-Path $env:GAH_KB_DIR '.kb-scaffold')
        # Silent when this is not a checkout (nothing to compare, and no way to
        # update from here anyway).
        if ($want -and $have -ne $want) {
            $at = if ($have) { "at $have, " } else { '' }
            [Console]::Error.WriteLine("gah: this knowledge base's scripts and skills are ${at}behind the scaffold in this checkout ($want)")
            [Console]::Error.WriteLine("     refresh them with:  .\bin\gah.ps1 update-kb $($env:GAH_KB_DIR)")
        }
    }
}

if (-not (Test-Path $PiCli)) {
    [Console]::Error.WriteLine(@"
gah: PI build is missing at
  $PiCli

Run the build first:
  cd vendor\pi; npm install --ignore-scripts
  foreach (`$p in 'tui','ai','agent','coding-agent') { npm --workspace packages/`$p run build }
"@)
    exit 1
}

# Environment variables are process-wide in PowerShell, so anything this script
# sets stays in the caller's session after it returns (#76: `gci env:` showed
# the launcher's defaults as if the user had set them). Everything set below is
# undone on exit; node gets the values while it runs.
$Restore = @{}
function Set-Default($name, $value) {
    if (Test-Path "Env:$name") { return }
    $Restore[$name] = $null
    Set-Item -Path "Env:$name" -Value $value
}

# Dev default: expose built-in Anthropic models (patch 0010 hides everything
# otherwise). Deployments override or unset this; published artifacts have no
# wrapper and default to deny-all.
#
# "none" means none. PowerShell removes a variable that is assigned an empty
# string, so `$env:GAH_BUILTIN_MODELS = ''` leaves it unset and the default
# above would apply (#76). Unset is exactly what patch 0010 treats as none, so
# the launcher drops the variable for the run and puts "none" back afterwards.
if ($env:GAH_BUILTIN_MODELS -eq 'none') {
    $Restore['GAH_BUILTIN_MODELS'] = 'none'
    Remove-Item Env:GAH_BUILTIN_MODELS
} else {
    Set-Default 'GAH_BUILTIN_MODELS' 'anthropic/*'
}

# Workstation default: read ~\.gah\agent\models.json. See bin/gah for why.
Set-Default 'GAH_ALLOW_MODELS_JSON' '1'

# Workstation default: no egress restriction (patch 0011 denies all when
# unset). See bin/gah for why, and docs/PROVIDERS.md to lock it down.
Set-Default 'GAH_ALLOWED_HOSTS' '*'

# --- Onboarding / setup steps ----------------------------------------------
# The skills repo may ship numbered, idempotent setup steps (setup\NN-*.ps1)
# that run in the terminal before the TUI, so secrets are collected without ever
# passing through the model. They live next to skills\ in the repo `gah init`
# scaffolds, so they are found relative to GAH_SKILLS_DIR's parent -- which also
# means a bare --skill run loads no setup steps, having no repo to find them in.
#
# Steps are agent-authored code, same trust level as the skills themselves;
# change control is the skills repo's review. Failure is non-fatal, matching
# deploy/host/gah-launch. GAH_SKIP_SETUP=1 skips them.
if ($env:GAH_SKILLS_DIR -and -not $env:GAH_SKIP_SETUP -and -not $InfoOnly) {
    $SetupDir = Join-Path (Split-Path -Parent $env:GAH_SKILLS_DIR) 'setup'
    if (Test-Path $SetupDir) {
        $steps = Get-ChildItem -Path $SetupDir -Filter '*.ps1' -File |
                 Where-Object { $_.Name -match '^[0-9]' } | Sort-Object Name
        foreach ($step in $steps) {
            # & runs the step in its own scope, so an `exit` inside it ends the
            # step rather than this launcher. ErrorActionPreference is Stop, so
            # a throwing step needs catching or it would take the session down.
            try { & $step.FullName }
            catch { [Console]::Error.WriteLine("gah: setup step $($step.Name) failed - continuing") }
        }
    }
}

# --no-extensions disables auto-discovery from the user-global and project
# config dirs; explicit --extension flags re-add exactly what GAH ships.
$ExitCode = 1
try {
    & node $PiCli `
        --no-extensions `
        @SkillArgs `
        --extension (Join-Path $PolicyDir "policy.ts") `
        --extension (Join-Path $PolicyDir "branding.ts") `
        --extension (Join-Path $PolicyDir "providers.ts") `
        --extension (Join-Path $PolicyDir "skills-freshness.ts") `
        @GahArgs
    $ExitCode = $LASTEXITCODE
} finally {
    foreach ($name in $Restore.Keys) {
        if ($null -eq $Restore[$name]) { Remove-Item "Env:$name" -ErrorAction SilentlyContinue }
        else { Set-Item -Path "Env:$name" -Value $Restore[$name] }
    }
}
exit $ExitCode
