# kb-sync.ps1 - bring this copy of the knowledge base up to date.
#
#   .\bin\kb-sync.ps1 [-Branch main]
#
# The last mile of the loop. A change is proposed, someone merges it, and until
# somebody pulls, the person who wrote it is still searching their own stale
# copy -- and so is every session on that machine. On a shared host the launcher
# fast-forwards at every start; on a workstation nothing does, which is where
# this is for.
#
# Refuses to touch uncommitted work, says what arrived, and clears away a
# branch whose change is already merged, because a knowledge base clone left on
# a merged branch is how the next article gets written on top of the last one.
param([Parameter(ValueFromRemainingArguments = $true)][string[]]$Argv)
$ErrorActionPreference = 'Continue'
. (Join-Path $PSScriptRoot '_kb-common.ps1')

$Opt = ConvertFrom-KbArgv $Argv @('branch', 'b')
$Branch = Get-KbFirst $Opt['branch'] $Opt['b']

$root = Get-KbRoot

function Invoke-Git {
    $output = & git -C $root @args 2>&1 | ForEach-Object { "$_" }
    return [pscustomobject]@{ Ok = ($LASTEXITCODE -eq 0); Text = ($output -join "`n") }
}

if (-not (Invoke-Git 'rev-parse' '--git-dir').Ok) { Stop-Kb "$root is not a git repository" }
if (-not (Invoke-Git 'remote' 'get-url' 'origin').Ok) {
    Write-Output 'No remote configured, so there is nothing to sync from.'
    exit 0
}

$defaultBranch = $Branch
if (-not $defaultBranch) {
    $defaultBranch = (Invoke-Git 'symbolic-ref' '--quiet' '--short' 'refs/remotes/origin/HEAD').Text.Trim() -replace '^origin/', ''
}
if (-not $defaultBranch) { $defaultBranch = 'main' }

if ((Invoke-Git 'status' '--porcelain' '--' 'articles').Text.Trim()) {
    Write-Output 'You have uncommitted changes under articles/. Propose them first:'
    Write-Output '  .\bin\kb-propose.ps1 -Message "<what changed and why>"'
    exit 3
}

$current = (Invoke-Git 'rev-parse' '--abbrev-ref' 'HEAD').Text.Trim()
$beforeResult = Invoke-Git 'rev-parse' $defaultBranch
$before = if ($beforeResult.Ok) { $beforeResult.Text.Trim() } else { '' }

if (-not (Invoke-Git 'fetch' '--quiet' '--prune' 'origin' $defaultBranch).Ok) {
    Stop-Kb 'could not reach the remote. Check the network, then try again.'
}

if ($current -ne $defaultBranch) {
    if (-not (Invoke-Git 'checkout' '--quiet' $defaultBranch).Ok) {
        Stop-Kb "could not switch to $defaultBranch (finish what is on $current first)"
    }
}
if (-not (Invoke-Git 'merge' '--ff-only' '--quiet' "origin/$defaultBranch").Ok) {
    Stop-Kb "$defaultBranch could not fast-forward. Someone has rewritten history, or this copy has local commits."
}

$afterResult = Invoke-Git 'rev-parse' $defaultBranch
$after = if ($afterResult.Ok) { $afterResult.Text.Trim() } else { '' }

if ($before -and $before -eq $after) {
    Write-Output 'Already up to date.'
} else {
    $range = if ($before) { "$before..$after" } else { $after }
    $arrived = (Invoke-Git 'log' '--no-merges' '--format=%s' $range '--' 'articles').Text.Trim()
    if ($arrived) {
        Write-Output 'Up to date. New since your last sync:'
        foreach ($line in (($arrived -split "`n") | Select-Object -First 10)) {
            if ($line.Trim()) { Write-Output ("  - " + $line.Trim()) }
        }
    } else {
        Write-Output 'Up to date.'
    }
}

# A branch whose change is already on the default branch is finished. Leaving it
# behind is how the next article ends up written on top of the last one.
if ($current -ne $defaultBranch) {
    if ($current -like 'kb/*') {
        $merged = (Invoke-Git 'branch' '--merged' $defaultBranch).Text -split "`n" | ForEach-Object { $_.TrimStart('*', ' ').Trim() }
        if ($merged -contains $current) {
            if ((Invoke-Git 'branch' '-q' '-d' $current).Ok) { Write-Output "Cleared the merged branch $current." }
        } else {
            Write-Output "Left $current alone: it is not merged yet."
        }
    } else {
        Write-Output "Switched from $current to $defaultBranch."
    }
}
