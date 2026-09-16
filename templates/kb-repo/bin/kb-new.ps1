# kb-new.ps1 - start an article from the template, with the frontmatter filled in.
#
#   .\bin\kb-new.ps1 -Title "Wireless at the North site" [-Area network] [-Tags network,wireless]
#                    [-Path articles/network/north-wireless.md] [-Status draft] [-Force]
#
# Prints the path it created. Refuses to overwrite an existing article: an
# accidental clobber of documentation is the one failure this tool must not have
# (-Force is there for the deliberate case, and rewrites only the body).
#
# Writing the article itself is the agent's job, or yours. This only guarantees
# that every article starts with a valid header, because a missing `updated` is
# invisible until the staleness report quietly stops mentioning the file.
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$Title,
    [string]$Area = '',
    [string]$Tags = '',
    [string]$Path = '',
    [ValidateSet('current', 'draft', 'gap')][string]$Status = 'draft',
    [switch]$Force
)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot '_kb-common.ps1')

$root = Get-KbRoot
$relative = $Path
if (-not $relative) {
    $slug = Get-KbSlug $Title
    if (-not $slug) { Stop-Kb 'the title has no usable words for a file name; pass -Path' }
    if ($Area) { $relative = "articles/" + (Get-KbSlug $Area) + "/$slug.md" } else { $relative = "articles/$slug.md" }
}
$relative = $relative -replace '\\', '/'
if ($relative -match '^[A-Za-z]:/' -or $relative.StartsWith('/')) { Stop-Kb '-Path must be relative to the knowledge base root' }
if ($relative -like '*..*') { Stop-Kb '-Path may not contain ..' }
if (-not $relative.StartsWith('articles/')) { $relative = "articles/$relative" }
if (-not $relative.EndsWith('.md')) { $relative = "$relative.md" }

$full = Join-Path $root ($relative -replace '/', [System.IO.Path]::DirectorySeparatorChar)
if ((Test-Path $full) -and -not $Force) {
    [Console]::Error.WriteLine("kb: $relative already exists. Edit it, or pass -Force to replace the body.")
    exit 3
}

# The body comes from templates/article.md with its own frontmatter stripped:
# one template, and the header is written here where the values are known.
$templatePath = Join-Path $root 'templates/article.md'
if (Test-Path $templatePath) {
    $body = (Get-KbArticle $templatePath).Body
} else {
    $body = "`n# $Title`n`n<!-- Lead with the answer. -->`n"
}
$body = $body.Replace('<Title>', $Title)

$header = @(
    '---',
    "title: $Title",
    'description: ',
    "status: $Status",
    "updated: $(Get-KbToday)",
    "tags: $(Format-KbTags $Tags)",
    '---'
) -join "`n"

Write-KbFile $full ($header + "`n" + $body.TrimStart("`n") + "`n")

Write-Output $relative
Write-KbNote 'Created. Fill in `description` before proposing it: that one line is what search matches on.'
