# kb-status.ps1 - what this knowledge base holds, and what it owes.
#
#   .\bin\kb-status.ps1 [-StaleDays 180] [-Quiet]
#
# Four questions, in the order they matter:
#   what is here, what was asked and never answered (most-asked first),
#   what has not been verified in a long time, and what is malformed.
#
# The gap list is the backlog. It is ordered by how often people actually
# needed the thing, which is the only prioritisation that has ever survived
# contact with a support queue.
param([Parameter(ValueFromRemainingArguments = $true)][string[]]$Argv)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot '_kb-common.ps1')

$Opt = ConvertFrom-KbArgv $Argv @('stale-days', 'staledays') @('quiet', 'q')
$StaleDays = 180
$staleRaw = Get-KbFirst $Opt['stale-days'] $Opt['staledays']
if ($staleRaw) { $parsedStale = 0; if ([int]::TryParse($staleRaw, [ref]$parsedStale) -and $parsedStale -ge 0) { $StaleDays = $parsedStale } }
$Quiet = $Opt['quiet'] -or $Opt['q']

$root = Get-KbRoot
$counts = @{ current = 0; draft = 0; gap = 0; other = 0 }
$gaps = @(); $stale = @(); $problems = @(); $examplePresent = $false

foreach ($file in Get-KbFiles) {
    $front = (Get-KbArticle $file.FullName).Front
    $rel = Get-KbRelative $file.FullName
    $title = [string]$front['title']
    $status = [string]$front['status']
    $updated = [string]$front['updated']
    $description = [string]$front['description']

    if (-not $title) { $problems += "  ${rel}: no title" }
    if (-not $description -and $status -ne 'gap') { $problems += "  ${rel}: no description (search matches on it)" }

    switch ($status) {
        'current' { $counts.current++ }
        'draft'   { $counts.draft++ }
        'gap'     { $counts.gap++ }
        ''        { $counts.other++; $problems += "  ${rel}: no status" }
        default   { $counts.other++; $problems += "  ${rel}: status '$status' is not current, draft or gap" }
    }

    if (-not $updated) {
        $problems += "  ${rel}: no updated date"
    } elseif ($updated -notmatch '^\d{4}-\d{2}-\d{2}$') {
        $problems += "  ${rel}: updated '$updated' is not YYYY-MM-DD"
    } else {
        $age = Get-KbAgeDays $updated
        if ($null -ne $age -and $age -lt 0) {
            $problems += "  ${rel}: updated '$updated' is in the future"
        } elseif ($null -ne $age) {
            # A date long before the file existed was not verified then -- it was
            # guessed, which is what a model does when nothing tells it today's
            # date. The article then reports as stale the day it is written.
            # Verified-then-written is days, so allow a season.
            # The shipped example carries an invented date on purpose and is
            # already reported separately; it would trip this on every fresh
            # knowledge base.
            $added = ''
            if ([string]$front['tags'] -notmatch 'example') {
                $added = (& git -C $root log --diff-filter=A --format=%ad --date=short -1 -- $rel 2>$null | Select-Object -Last 1)
            }
            if ($added) {
                $addedAge = Get-KbAgeDays ("$added".Trim())
                if ($null -ne $addedAge -and ($age - $addedAge) -gt 90) {
                    $problems += "  ${rel}: updated '$updated' predates the file by $($age - $addedAge) days — was the date guessed rather than taken from the system?"
                }
            }
        }
    }

    if ($status -eq 'gap') {
        $n = 1; $parsed = 0
        if ([int]::TryParse([string]$front['requests'], [ref]$parsed) -and $parsed -gt 0) { $n = $parsed }
        $gaps += [pscustomobject]@{ Requests = $n; Path = $rel; Title = $title }
    } elseif ($updated) {
        $age = Get-KbAgeDays $updated
        if ($null -ne $age -and $age -gt $StaleDays) {
            $stale += [pscustomobject]@{ Age = $age; Path = $rel; Title = $title }
        }
    }
    if ([string]$front['tags'] -match 'example') { $examplePresent = $true }
}

$total = $counts.current + $counts.draft + $counts.gap + $counts.other
Write-Output "Knowledge base: $root"
Write-Output ("  {0} articles — {1} current, {2} draft, {3} recorded gaps" -f $total, $counts.current, $counts.draft, $counts.gap)

if ($gaps.Count -gt 0) {
    Write-Output ''
    Write-Output 'Asked and unanswered (most-asked first — this is the backlog):'
    foreach ($g in ($gaps | Sort-Object -Property Requests -Descending | Select-Object -First 15)) {
        Write-Output ("  {0}x  {1}" -f $g.Requests, $g.Title)
        Write-Output ("      {0}" -f $g.Path)
        $url = Get-KbArticleUrl $g.Path
        if ($url) { Write-Output ("      {0}" -f $url) }
    }
}

if ($stale.Count -gt 0) {
    Write-Output ''
    Write-Output "Not verified in over $StaleDays days:"
    foreach ($s in ($stale | Sort-Object -Property Age -Descending | Select-Object -First 15)) {
        Write-Output ("  {0} days  {1}" -f $s.Age, $s.Title)
        Write-Output ("           {0}" -f $s.Path)
        $url = Get-KbArticleUrl $s.Path
        if ($url) { Write-Output ("           {0}" -f $url) }
    }
}

if ($problems.Count -gt 0) {
    Write-Output ''
    Write-Output 'Header problems (these articles will not be found or aged correctly):'
    foreach ($p in $problems) { Write-Output $p }
}

if ($examplePresent -and -not $Quiet) {
    Write-Output ''
    Write-Output 'The example article that shipped with the scaffold is still here.'
    Write-Output 'Delete it once you have written one of your own — it is invented, and it'
    Write-Output 'will otherwise be quoted back to someone as though it were true.'
}

if ($total -eq 0) {
    Write-Output ''
    Write-Output 'Nothing here yet. That is the normal starting state: ask the agent something,'
    Write-Output 'let it record the gap, and write that article first.'
}
