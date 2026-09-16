# Web-address helpers for the kb-*.ps1 scripts. Dot-sourced by _kb-common.ps1.
#
# PowerShell twin of the kb_default_branch / kb_web_base / kb_article_url
# helpers in _kb-common.sh, and must agree with them: a knowledge base is read
# from a workstation and a shared host by turns, and a link that differs by
# platform is a link someone stops trusting.

# The branch a change is expected to land on. origin/HEAD when the remote says,
# init.defaultBranch when it does not, main as the last word.
function Get-KbDefaultBranch {
    $root = Get-KbRoot
    $b = ''
    try { $b = "$(& git -C $root symbolic-ref --quiet --short refs/remotes/origin/HEAD 2>$null | Select-Object -First 1)".Trim() } catch { }
    $b = $b -replace '^origin/', ''
    if (-not $b) {
        try { $b = "$(& git -C $root config init.defaultBranch 2>$null | Select-Object -First 1)".Trim() } catch { }
    }
    if (-not $b) { $b = 'main' }
    return $b
}

# The repository's web address, from the origin remote. Empty when there is no
# remote, which is the ordinary state of a knowledge base for its first hour.
# Handles the ssh forms as well as https, and drops any credentials or port so
# the result is something a person can paste into a browser.
function Get-KbWebBase {
    $root = Get-KbRoot
    $remote = ''
    try { $remote = "$(& git -C $root remote get-url origin 2>$null | Select-Object -First 1)".Trim() } catch { }
    if (-not $remote) { return '' }
    $u = $remote -replace '^ssh://', ''
    $u = $u -replace '^git@([^:/]+):[0-9]+/', 'https://$1/'
    $u = $u -replace '^git@([^:/]+)[:/]', 'https://$1/'
    $u = $u -replace '^(https?://)[^@/]+@', '$1'
    $u = $u -replace '^(https?://[^/]+):[0-9]+/', '$1/'
    $u = $u -replace '\.git$', ''
    return $u.TrimEnd('/')
}

# A link to one article's page in the forge, so a cited path can be opened
# rather than hunted for. -Path is relative to the knowledge base root; -Ref
# defaults to the branch the article will live on once merged.
#
# The two forges spell it differently and only the host says which is which.
# KB_WEB_STYLE=github|gitlab settles it for anything self-hosted under a name
# that gives nothing away; GitLab's form is the default because a knowledge base
# on a corporate forge is more often there than not.
function Get-KbArticleUrl([string]$Path, [string]$Ref = '') {
    $base = Get-KbWebBase
    if (-not $base) { return '' }
    if (-not $Ref) { $Ref = Get-KbDefaultBranch }
    $style = "$env:KB_WEB_STYLE".ToLowerInvariant()
    if ($style -ne 'github' -and $style -ne 'gitlab') {
        # Not $host: PowerShell reserves that for the host object and refuses
        # to assign it, which silently left the style unset and every GitHub
        # link in GitLab's spelling.
        $hostName = ($base -replace '^https?://', '') -replace '/.*$', ''
        $style = if ($hostName -like '*github*') { 'github' } else { 'gitlab' }
    }
    $rel = ($Path -replace '\\', '/').TrimStart('/')
    if ($style -eq 'github') { return "$base/blob/$Ref/$rel" }
    return "$base/-/blob/$Ref/$rel"
}
