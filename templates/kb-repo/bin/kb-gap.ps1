# kb-gap.ps1 - record that the knowledge base could not answer something.
#
#   .\bin\kb-gap.ps1 -Question "which switch serves the gym?" [-Tags network]
#
# Creates a stub article with `status: gap`, or -- if that question has been
# asked before -- bumps its `requests` count and the date. The count is the
# point: it turns "our documentation is patchy" into a list ordered by what
# people actually needed while working, which is a better guide to what to
# write next than any documentation plan drawn up in advance.
#
# A gap is an ordinary article, so the next person asking the same question
# finds it in search and learns that the team knows it is missing.
param([Parameter(ValueFromRemainingArguments = $true)][string[]]$Argv)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot '_kb-common.ps1')

$Opt = ConvertFrom-KbArgv $Argv @('question', 'q', 'tags')
$Question = Get-KbFirst $Opt['question'] $Opt['q'] $Opt['_']
$Tags = $Opt['tags']
$Usage = 'Usage: kb-gap.ps1 -Question "<the question nobody could answer>" [-Tags a,b]'
if (-not $Question) { Stop-Kb "a question is required.`n  $Usage" }
Assert-KbText $Question 'the question' $Usage

$root = Get-KbRoot
$slug = Get-KbSlug $Question
if (-not $slug) { Stop-Kb 'that question has no usable words for a file name' }
$relative = "articles/gaps/$slug.md"
$full = Join-Path $root ($relative -replace '/', [System.IO.Path]::DirectorySeparatorChar)
$today = Get-KbToday

if (Test-Path $full) {
    # Seen before: bump the count in place rather than writing a second stub.
    $count = 1
    $existing = Get-KbField $full 'requests'
    $parsed = 0
    if ([int]::TryParse($existing, [ref]$parsed) -and $parsed -gt 0) { $count = $parsed }
    $count++

    $text = ([System.IO.File]::ReadAllText($full)) -replace "`r`n", "`n"
    if ($text -match '(?m)^requests:.*$') {
        $text = [regex]::Replace($text, '(?m)^requests:.*$', "requests: $count")
    } else {
        $text = [regex]::Replace($text, '(?m)^status:(.*)$', "status:`$1`nrequests: $count")
    }
    if ($text -match '(?m)^last_requested:.*$') {
        $text = [regex]::Replace($text, '(?m)^last_requested:.*$', "last_requested: $today")
    } else {
        $text = [regex]::Replace($text, '(?m)^requests:.*$', "requests: $count`nlast_requested: $today")
    }
    Write-KbFile $full $text
    Write-Output $relative
    Write-KbNote "Asked $count times now. That makes it a strong candidate for the next article written."
    exit 0
}

$content = @(
    '---',
    "title: $Question",
    'description: Nobody has written this down yet.',
    'status: gap',
    "updated: $today",
    'requests: 1',
    "last_requested: $today",
    "tags: $(Format-KbTags $Tags)",
    '---',
    '',
    "# $Question",
    '',
    'Asked, and not answered by anything in this knowledge base.',
    '',
    '## What we would need to write',
    '',
    '- <the facts that would answer it>',
    '- <where those facts live, or who knows them>',
    '',
    'When someone answers this, replace the body with the article, set `status`',
    'to `current`, and move the file out of `articles/gaps/` into the area it',
    'belongs to. The gap becoming an article is the whole point.'
) -join "`n"

Write-KbFile $full ($content + "`n")
Write-Output $relative
Write-KbNote 'Gap recorded. It will show up in searches for this subject until someone answers it.'
