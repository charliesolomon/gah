# kb-search.ps1 - find articles that bear on a question.
#
#   .\bin\kb-search.ps1 "north site wireless" [-Tag network] [-Status current] [-Limit 10]
#
# Prints one block per hit: path, title, status, when it was last verified, and
# the line that matched. Ranked, because the first three results are the only
# ones anyone reads: a word in the title or description outweighs the same word
# in the body, and an article matching every word outweighs one matching some.
#
# Exit 0 with matches, 1 with none (so a caller can branch on "nothing known").
[CmdletBinding()]
param(
    [Parameter(ValueFromRemainingArguments = $true)][string[]]$Query,
    [string]$Tag = '',
    [string]$Status = '',
    [int]$Limit = 10
)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot '_kb-common.ps1')

$queryText = ($Query -join ' ').Trim()
if (-not $queryText) { Stop-Kb 'nothing to search for. Usage: kb-search.ps1 "<question or keywords>"' }

# Words worth scoring. Two-letter words and the connectives people type into
# questions match everything and rank nothing.
$stop = @('the','a','an','and','or','of','for','at','in','on','to','is','are','was','were','how','what',
          'which','who','whom','where','when','why','do','does','did','with','from','by','our','we','us',
          'it','its','this','that')
$words = @()
foreach ($w in ([regex]::Split($queryText.ToLowerInvariant(), '[^a-z0-9]+'))) {
    if ($w.Length -ge 3 -and $stop -notcontains $w) { $words += $w }
}
if ($words.Count -eq 0) { $words = @($queryText.ToLowerInvariant()) }

$hits = @()
foreach ($file in Get-KbFiles) {
    $article = Get-KbArticle $file.FullName
    $front = $article.Front
    $fileStatus = [string]$front['status']
    if ($Status -and $fileStatus -ne $Status) { continue }
    $tags = [string]$front['tags']
    if ($Tag) {
        $tagWords = ($tags -replace '[\[\],"]', ' ') -split '\s+'
        if ($tagWords -notcontains $Tag) { continue }
    }

    $head = (@([string]$front['title'], [string]$front['description'], $tags, $file.BaseName) -join ' ').ToLowerInvariant()
    $body = $article.Body.ToLowerInvariant()

    $score = 0; $matched = 0
    foreach ($w in $words) {
        $inHead = $head.Contains($w)
        $inBody = $body.Contains($w)
        if ($inHead) { $score += 10 }
        if ($inBody) { $score += 2 }
        if ($inHead -or $inBody) { $matched++ }
    }
    if ($matched -eq 0) { continue }
    # Every word present beats a partial match on a longer article.
    if ($matched -eq $words.Count) { $score += 25 }
    # A recorded gap is a real answer to "what do we know" -- surface it, but
    # never above an article that actually answers.
    if ($fileStatus -eq 'gap') { $score -= 15 }

    $hits += [pscustomobject]@{ Score = $score; File = $file; Front = $front; Body = $article.Body }
}

if ($hits.Count -eq 0) {
    Write-Output 'No article covers that yet.'
    exit 1
}

foreach ($hit in ($hits | Sort-Object -Property @{Expression='Score';Descending=$true}, @{Expression={$_.File.FullName}} | Select-Object -First $Limit)) {
    $front = $hit.Front
    Write-Output (Get-KbRelative $hit.File.FullName)
    Write-Output ("  title:   " + [string]$front['title'])
    $line = "  status:  " + [string]$front['status'] + "   updated: " + [string]$front['updated']
    if ([string]$front['status'] -eq 'gap') { $line += "   requests: " + [string]$front['requests'] }
    Write-Output $line
    if ($front['description']) { Write-Output ("  " + [string]$front['description']) }

    # The first line of PROSE that mentions a query word, so a reader can judge
    # relevance without opening the file. Headings are navigation and usually
    # repeat the title, which is already on screen.
    $bodyLines = $hit.Body -split "`n"
    foreach ($w in $words) {
        $found = $null
        foreach ($bodyLine in $bodyLines) {
            $trimmed = $bodyLine.Trim()
            if (-not $trimmed) { continue }
            if ($trimmed.StartsWith('#') -or $trimmed.StartsWith('<!--') -or $trimmed.StartsWith('-->')) { continue }
            if ($trimmed.ToLowerInvariant().Contains($w)) { $found = $trimmed; break }
        }
        if ($found) {
            $found = $found.TrimStart('>', '|', '*', '-', ' ')
            if ($found.Length -gt 160) { $found = $found.Substring(0, 160) }
            Write-Output ("  > " + $found)
            break
        }
    }
    Write-Output ''
}
