# kb-propose.ps1 - put a knowledge base change in front of the team.
#
#   .\bin\kb-propose.ps1 -Message "Document the gym switch" [-Branch kb/gym-switch] [-Direct]
#
# Default is to PROPOSE: commit on a branch, push it, and hand back the URL that
# opens the pull or merge request. Nothing reaches main without a person.
#
# KB_PUBLISH=direct (or -Direct) commits to the default branch and pushes
# instead. That is a real choice some teams make once their review step has
# become a rubber stamp: git history is then the audit trail and `git revert`
# the rollback. Decide it deliberately rather than drifting into it.
#
# Only `articles/` is staged. Changes to the scripts or the skills are changes
# to the tooling and deserve their own review, not a ride along with an article.
#
# The commit is made with whatever git identity the person running the session
# has, so a change is attributable to them and not to a shared robot account.
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$Message,
    [string]$Branch = '',
    [switch]$Direct,
    [switch]$Propose
)
$ErrorActionPreference = 'Continue'
. (Join-Path $PSScriptRoot '_kb-common.ps1')

$root = Get-KbRoot
$goDirect = $Direct -or ($env:KB_PUBLISH -eq 'direct')
if ($Propose) { $goDirect = $false }

function Invoke-Git {
    # Captures stdout and stderr together: git says useful things on stderr,
    # including the merge-request URL a GitLab push prints.
    $output = & git -C $root @args 2>&1 | ForEach-Object { "$_" }
    return [pscustomobject]@{ Ok = ($LASTEXITCODE -eq 0); Text = ($output -join "`n") }
}

if (-not (Invoke-Git 'rev-parse' '--git-dir').Ok) {
    Stop-Kb "$root is not a git repository. Run: git -C `"$root`" init"
}
$userName = (Invoke-Git 'config' 'user.name').Text.Trim()
$userEmail = (Invoke-Git 'config' 'user.email').Text.Trim()
if (-not $userName -or -not $userEmail) {
    Stop-Kb @"
git identity is not set, so this change could not be attributed to you.
  git -C "$root" config user.name  "Your Name"
  git -C "$root" config user.email "you@example.com"
"@
}

if (-not (Invoke-Git 'add' '-A' '--' 'articles').Ok) { Stop-Kb 'could not stage articles/' }
if ((Invoke-Git 'diff' '--cached' '--quiet' '--' 'articles').Ok) {
    Write-Output 'Nothing to propose: no changes under articles/.'
    exit 1
}

Write-Output 'Staged:'
foreach ($line in ((Invoke-Git 'diff' '--cached' '--name-status' '--' 'articles').Text -split "`n")) {
    if ($line.Trim()) { Write-Output ("  " + $line) }
}

$defaultBranch = (Invoke-Git 'symbolic-ref' '--quiet' '--short' 'refs/remotes/origin/HEAD').Text.Trim() -replace '^origin/', ''
if (-not $defaultBranch) { $defaultBranch = (Invoke-Git 'config' 'init.defaultBranch').Text.Trim() }
if (-not $defaultBranch) { $defaultBranch = 'main' }
$hasRemote = (Invoke-Git 'remote' 'get-url' 'origin').Ok

if ($goDirect) {
    if (-not (Invoke-Git 'commit' '-q' '-m' $Message).Ok) { Stop-Kb 'commit failed' }
    Write-Output ''
    Write-Output ("Committed to " + (Invoke-Git 'rev-parse' '--abbrev-ref' 'HEAD').Text.Trim() + ".")
    if ($hasRemote) {
        $push = Invoke-Git 'push' 'origin' 'HEAD'
        if ($push.Ok) {
            Write-Output 'Pushed. The team has it.'
        } else {
            foreach ($line in ($push.Text -split "`n")) { Write-Output ("  " + $line) }
            Write-Output 'Committed locally but NOT pushed — resolve the above and push.'
            exit 4
        }
    } else {
        Write-Output 'No remote configured, so this is committed locally only.'
    }
    exit 0
}

if (-not $Branch) {
    $slug = Get-KbSlug $Message
    if ($slug) { $Branch = "kb/$slug" } else { $Branch = "kb/update-" + (Get-Date).ToString('yyyyMMdd-HHmmss') }
}
$current = (Invoke-Git 'rev-parse' '--abbrev-ref' 'HEAD').Text.Trim()
if ($current -ne $Branch) {
    # A staged change survives the switch, so the article can be written before
    # anyone thinks about branches -- which is the order people actually work in.
    if (-not (Invoke-Git 'checkout' '-q' '-b' $Branch).Ok) {
        if (-not (Invoke-Git 'checkout' '-q' $Branch).Ok) { Stop-Kb "could not switch to $Branch" }
    }
}
if (-not (Invoke-Git 'commit' '-q' '-m' $Message).Ok) { Stop-Kb 'commit failed' }
Write-Output ''
Write-Output "Committed on $Branch."

if (-not $hasRemote) {
    Write-Output 'No remote configured, so there is nothing to open a request against yet.'
    exit 0
}
$push = Invoke-Git 'push' '-u' 'origin' $Branch
if (-not $push.Ok) {
    foreach ($line in ($push.Text -split "`n")) { Write-Output ("  " + $line) }
    Write-Output "Committed on $Branch but NOT pushed — resolve the above and push."
    exit 4
}
# GitLab prints the merge-request URL in the push output; GitHub prints a
# compare link. Show it verbatim rather than guessing.
foreach ($line in ($push.Text -split "`n")) {
    if ($line -match 'https?://') { Write-Output ("  " + ($line -replace '^\s*remote:\s*', '')) }
}

$remote = (Invoke-Git 'remote' 'get-url' 'origin').Text.Trim()
$web = $remote -replace '^git@([^:]+):', 'https://$1/' -replace '\.git$', ''
if ($web -like 'https://github.com/*') {
    Write-Output ("  Open the pull request: {0}/compare/{1}...{2}?expand=1" -f $web, $defaultBranch, $Branch)
}
Write-Output 'Proposed. Someone reviews it, and every later question is answered from the better version.'
