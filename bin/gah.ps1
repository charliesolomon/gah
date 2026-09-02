# gah — launch PI with GAH policy-pack loaded, ignoring any user-global
# extensions/skills/themes that PI would otherwise auto-discover.
#
# PowerShell equivalent of bin/gah. The wrapper exists so that the policy
# enforced in this repo is the policy the user actually gets, regardless of
# what's in the user-global agent config dir.

$ErrorActionPreference = "Stop"

$Here = Split-Path -Parent $PSScriptRoot
$PiCli = Join-Path $Here "vendor\pi\packages\coding-agent\dist\cli.js"
$PolicyDir = Join-Path $Here "packages\policy-pack\extensions"

# --- gah init --------------------------------------------------------------
# Handled before anything else: a new deployment scaffolds its skills repo
# first, and should not need a built PI to do it. Also breaks the circularity of
# a launcher that refuses to start without skills.
$TemplateDir = Join-Path $Here 'templates\skills-repo'
if ($args.Count -ge 1 -and $args[0] -eq 'init') {
    if ($args.Count -lt 2) { [Console]::Error.WriteLine('usage: gah.ps1 init <directory>'); exit 2 }
    $Target = $args[1]
    if (-not (Test-Path $TemplateDir)) { [Console]::Error.WriteLine("gah: template missing at $TemplateDir"); exit 1 }
    if ((Test-Path $Target) -and (Get-ChildItem -Force $Target | Measure-Object).Count -gt 0) {
        [Console]::Error.WriteLine("gah: $Target exists and is not empty - refusing to overwrite"); exit 1
    }
    New-Item -ItemType Directory -Force -Path $Target | Out-Null
    Copy-Item -Recurse -Force (Join-Path $TemplateDir '*') $Target
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
# --help and --version answer without a skills repo; they start nothing.
if (@('--help', '-h', '--version', '-v') | Where-Object { $args -contains $_ }) { $SkillsConfigured = $true }
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

if (-not (Test-Path $PiCli)) {
    [Console]::Error.WriteLine(@"
gah: PI build is missing at
  $PiCli

Run the build first:
  cd vendor\pi; npm install
  foreach (`$p in 'tui','ai','agent','coding-agent') { npm --workspace packages/`$p run build }
"@)
    exit 1
}

# Dev default: expose built-in Anthropic models (patch 0010 hides everything
# otherwise). Deployments override or unset this; published artifacts have no
# wrapper and default to deny-all.
if (-not (Test-Path Env:GAH_BUILTIN_MODELS)) {
    $env:GAH_BUILTIN_MODELS = "anthropic/*"
}

# Workstation default: read ~\.gah\agent\models.json. See bin/gah for why.
if (-not (Test-Path Env:GAH_ALLOW_MODELS_JSON)) {
    $env:GAH_ALLOW_MODELS_JSON = "1"
}

# Workstation default: no egress restriction (patch 0011 denies all when
# unset). See bin/gah for why, and docs/PROVIDERS.md to lock it down.
if (-not (Test-Path Env:GAH_ALLOWED_HOSTS)) {
    $env:GAH_ALLOWED_HOSTS = "*"
}

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
if ($env:GAH_SKILLS_DIR -and -not $env:GAH_SKIP_SETUP) {
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
& node $PiCli `
    --no-extensions `
    @SkillArgs `
    --extension (Join-Path $PolicyDir "policy.ts") `
    --extension (Join-Path $PolicyDir "branding.ts") `
    --extension (Join-Path $PolicyDir "providers.ts") `
    @args
exit $LASTEXITCODE
