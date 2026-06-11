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

if (-not (Test-Path $PiCli)) {
    Write-Error @"
gah: PI build is missing at
  $PiCli

Run the build first:
  cd vendor\pi; npm install
  foreach (`$p in 'tui','ai','agent','coding-agent') { npm --workspace packages/`$p run build }
"@
    exit 1
}

# --no-extensions disables auto-discovery from the user-global and project
# config dirs; explicit --extension flags re-add exactly what GAH ships.
& node $PiCli `
    --no-extensions `
    --extension (Join-Path $PolicyDir "policy.ts") `
    --extension (Join-Path $PolicyDir "branding.ts") `
    @args
exit $LASTEXITCODE
