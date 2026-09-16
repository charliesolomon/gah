# Shared helpers for the kb-*.ps1 scripts. Dot-sourced, never run directly.
#
# PowerShell twin of _kb-common.sh, for Windows workstations. Kept compatible
# with Windows PowerShell 5.1 (what ships on Win11) as well as PowerShell 7:
# no ternaries, no null-coalescing, no -AsHashtable.
#
# The knowledge base root is found from this script's own location (bin/ lives
# at the root), so a clone works wherever it sits. KB_DIR or GAH_KB_DIR
# overrides, for the case where the scripts are copied elsewhere.

function Get-KbRoot {
    if ($env:KB_DIR) { return $env:KB_DIR.TrimEnd('\', '/') }
    if ($env:GAH_KB_DIR) { return $env:GAH_KB_DIR.TrimEnd('\', '/') }
    return (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
}

function Get-KbArticlesDir { return (Join-Path (Get-KbRoot) 'articles') }

function Stop-Kb([string]$Message) {
    [Console]::Error.WriteLine("kb: $Message")
    exit 2
}

function Write-KbNote([string]$Message) { [Console]::Error.WriteLine($Message) }

# A file name (and gap identity) from a title or question: lowercase, words
# joined by hyphens, nothing else, capped so a long question stays a usable name.
function Get-KbSlug([string]$Text) {
    if (-not $Text) { return '' }
    $s = $Text.ToLowerInvariant()
    $s = [regex]::Replace($s, '[^a-z0-9]+', '-')
    $s = $s.Trim('-')
    if ($s.Length -gt 60) { $s = $s.Substring(0, 60) }
    return $s.Trim('-')
}

function Get-KbToday { return (Get-Date).ToString('yyyy-MM-dd') }

<#
Every kb-*.ps1 hands its arguments to this rather than to PowerShell's own
parameter binding, for two reasons that both bite in practice.

Windows PowerShell 5.1 and PowerShell 7 disagree about `--name`: 7 matches it to
-Name, 5.1 takes it as a positional value. The same call then writes an article
titled "--title" on one machine and the right thing on another, and the file is
wrong rather than the command failing.

And an agent reading the .sh twin's usage will type GNU style whichever shell it
is in. A tool that accepts only one convention produces a plausible-looking
article from a mistyped flag, which is worse than refusing.

Accepts `-Name value`, `--name value`, `--name=value` and bare positional words,
case-insensitively. Anything unrecognised lands in `_` so a typo is visible.
#>
function ConvertFrom-KbArgv {
    param([string[]]$Argv, [string[]]$Names, [string[]]$Switches = @())
    $out = @{ '_' = @() }
    foreach ($n in $Names) { $out[$n] = '' }
    foreach ($s in $Switches) { $out[$s] = $false }
    $i = 0
    while ($i -lt $Argv.Count) {
        $tok = [string]$Argv[$i]
        if ($tok -match '^--?([A-Za-z][A-Za-z0-9-]*)(=(.*))?$') {
            $name = $Matches[1].ToLowerInvariant()
            $hasInline = $Matches[2]
            $inline = $Matches[3]
            if ($Switches -contains $name) { $out[$name] = $true; $i++; continue }
            if ($Names -contains $name) {
                if ($hasInline) { $out[$name] = $inline; $i++ }
                elseif ($i + 1 -lt $Argv.Count) { $out[$name] = [string]$Argv[$i + 1]; $i += 2 }
                else { $i++ }
                continue
            }
            $out['_'] += $tok; $i++; continue
        }
        $out['_'] += $tok; $i++
    }
    return $out
}

# First non-empty of the given values; '' when all are empty.
function Get-KbFirst {
    foreach ($v in $args) { if ($v -is [array]) { $v = ($v -join ' ') }; if ("$v".Trim()) { return "$v".Trim() } }
    return ''
}

# A title, question or message that begins with a dash is a mistyped flag, not
# text. Refusing beats writing an article called "--title".
function Assert-KbText([string]$Value, [string]$What, [string]$Usage) {
    if ($Value -like '-*') {
        Stop-Kb "$What looks like a flag, not text: '$Value'`n  $Usage"
    }
}

# Frontmatter as a hashtable, plus the body. Values may be quoted or bare;
# lists are returned as written, because nothing here needs to parse them.
function Get-KbArticle([string]$Path) {
    $result = @{ Front = @{}; Body = '' }
    try { $text = [System.IO.File]::ReadAllText($Path) } catch { return $result }
    $text = $text -replace "`r`n", "`n"
    $m = [regex]::Match($text, '^---\n(.*?)\n---\n?', 'Singleline')
    if (-not $m.Success) { $result.Body = $text; return $result }
    foreach ($line in $m.Groups[1].Value -split "`n") {
        $pos = $line.IndexOf(':')
        if ($pos -lt 1) { continue }
        $k = $line.Substring(0, $pos).Trim()
        $v = $line.Substring($pos + 1).Trim().Trim('"').Trim("'")
        if ($k) { $result.Front[$k] = $v }
    }
    $result.Body = $text.Substring($m.Length)
    return $result
}

function Get-KbField([string]$Path, [string]$Name) {
    $a = Get-KbArticle $Path
    if ($a.Front.ContainsKey($Name)) { return [string]$a.Front[$Name] }
    return ''
}

# Every article, deterministic order. README.md is documentation, not knowledge.
function Get-KbFiles {
    $dir = Get-KbArticlesDir
    if (-not (Test-Path $dir)) { return @() }
    return Get-ChildItem -Path $dir -Filter '*.md' -Recurse -File |
        Where-Object { $_.Name -ne 'README.md' } |
        Sort-Object FullName
}

# Days between an ISO date and today; $null when the date is unusable.
function Get-KbAgeDays([string]$IsoDate) {
    $parsed = [datetime]::MinValue
    $styles = [System.Globalization.DateTimeStyles]::None
    $culture = [System.Globalization.CultureInfo]::InvariantCulture
    if (-not [datetime]::TryParseExact($IsoDate, 'yyyy-MM-dd', $culture, $styles, [ref]$parsed)) { return $null }
    return [int]((Get-Date).Date - $parsed.Date).TotalDays
}

# UTF-8 without a byte-order mark: a BOM in Markdown shows up as a stray
# character in every diff and in anything that reads the file as plain text.
function Write-KbFile([string]$Path, [string]$Text) {
    $dir = Split-Path -Parent $Path
    if ($dir -and -not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
    $utf8 = New-Object System.Text.UTF8Encoding($false)
    [System.IO.File]::WriteAllText($Path, $Text, $utf8)
}

# A path relative to the knowledge base root, in the forward-slash form the
# articles themselves use, so the agent cites the same path on either platform.
function Get-KbRelative([string]$Path) {
    $root = (Get-KbRoot).TrimEnd('\', '/')
    $full = $Path
    try { $full = (Resolve-Path $Path).Path } catch { }
    if ($full.StartsWith($root, [StringComparison]::OrdinalIgnoreCase)) {
        $full = $full.Substring($root.Length).TrimStart('\', '/')
    }
    return ($full -replace '\\', '/')
}

# Tag list as written into frontmatter: [a, b] or [].
function Format-KbTags([string]$Tags) {
    if (-not $Tags) { return '[]' }
    $clean = @()
    foreach ($t in ($Tags -split ',')) {
        $s = Get-KbSlug $t
        if ($s) { $clean += $s }
    }
    if ($clean.Count -eq 0) { return '[]' }
    return '[' + ($clean -join ', ') + ']'
}
