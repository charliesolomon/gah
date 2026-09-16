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
param([Parameter(ValueFromRemainingArguments = $true)][string[]]$Argv)
$ErrorActionPreference = 'Continue'
. (Join-Path $PSScriptRoot '_kb-common.ps1')

$Opt = ConvertFrom-KbArgv $Argv @('message', 'm', 'branch', 'b') @('direct', 'propose')
$Message = Get-KbFirst $Opt['message'] $Opt['m'] $Opt['_']
$Branch = Get-KbFirst $Opt['branch'] $Opt['b']
$Usage = 'Usage: kb-propose.ps1 -Message "<what changed and why, in one line>"'
if (-not $Message) { Stop-Kb "a message is required: say what changed and why, in one line.`n  $Usage" }
Assert-KbText $Message 'the message' $Usage

$root = Get-KbRoot
$goDirect = $Opt['direct'] -or ($env:KB_PUBLISH -eq 'direct')
if ($Opt['propose']) { $goDirect = $false }

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
# A forge prints the link to open the request in the push banner. Pull the URLs
# out of the whole banner rather than echoing every line that contains one: the
# banner also carries the repository URL, and a server notice wrapped mid-
# sentence produced "certificate.](https://...)" in a real run.
$urls = @()
foreach ($m in [regex]::Matches($push.Text, 'https?://[^\s<>"]+')) {
    $u = $m.Value.TrimEnd('.', ',', ')')
    if ($urls -notcontains $u) { $urls += $u }
}
$request = $urls | Where-Object { $_ -match 'merge_request|pull/new|pull-requests|/compare/' } | Select-Object -First 1
if ($request) {
    Write-Output ("  Open the request: " + $request)
} else {
    $remote = (Invoke-Git 'remote' 'get-url' 'origin').Text.Trim()
    $web = $remote -replace '^git@([^:]+):', 'https://$1/' -replace '\.git$', ''
    if ($web -like 'https://github.com/*') {
        Write-Output ("  Open the pull request: {0}/compare/{1}...{2}?expand=1" -f $web, $defaultBranch, $Branch)
    } elseif ($urls.Count -gt 0) {
        foreach ($u in $urls) { Write-Output ("  " + $u) }
    }
}
# The articles as they now exist on the pushed branch. That link works before
# anyone has reviewed anything, which is the point: a reviewer can read the
# article rather than a diff.
foreach ($f in ((Invoke-Git 'show' '--name-only' '--format=' 'HEAD' '--' 'articles').Text -split "`n")) {
    $rel = $f.Trim()
    if (-not $rel) { continue }
    if (-not (Test-Path (Join-Path $root ($rel -replace '/', [System.IO.Path]::DirectorySeparatorChar)))) { continue }
    $url = Get-KbArticleUrl $rel $Branch
    if ($url) { Write-Output ("  " + $url) }
}
Write-Output 'Proposed. Someone reviews it, and every later question is answered from the better version.'
Write-Output 'When it is merged, run kb-sync to bring this copy up to date.'
