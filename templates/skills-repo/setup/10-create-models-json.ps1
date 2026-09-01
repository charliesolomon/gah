# Configure an OpenAI-compatible inference endpoint for this deployment.
#
# PowerShell twin of 10-create-models-json.sh, for Windows deployments.
# Idempotent: exits once models.json exists.
#
# models.json bypasses the built-in-catalogue allowlist by design, so GAH
# refuses to read it unless GAH_ALLOW_MODELS_JSON=1. Set that in the environment
# or the deployment manifest, not here, so the decision stays visible.
$ErrorActionPreference = 'Stop'

$AgentDir  = if ($env:GAH_AGENT_DIR) { $env:GAH_AGENT_DIR } else { Join-Path $HOME '.gah\agent' }
$ModelsJson = Join-Path $AgentDir 'models.json'

if (Test-Path $ModelsJson) { exit 0 }
if (-not [Environment]::UserInteractive) { exit 0 }

Write-Host ""
Write-Host "No inference endpoint is configured yet."
Write-Host "Leave the URL blank to skip - rerun by deleting $ModelsJson."
Write-Host ""
$BaseUrl = Read-Host "  Base URL (e.g. https://api.example.com/openai/v1)"
if ([string]::IsNullOrWhiteSpace($BaseUrl)) { Write-Host "  skipped"; exit 0 }
$ProviderId = Read-Host "  Provider id [corp]"
if ([string]::IsNullOrWhiteSpace($ProviderId)) { $ProviderId = 'corp' }
$ModelIds = Read-Host "  Model ids, comma-separated (e.g. gpt-4.1,gpt-5)"

$models = @()
foreach ($id in ($ModelIds -split ',')) {
    $t = $id.Trim()
    if ($t) { $models += [ordered]@{ id = $t; input = @('text') } }
}

$config = [ordered]@{
    providers = [ordered]@{
        $ProviderId = [ordered]@{
            name    = $ProviderId
            api     = 'openai-completions'
            baseUrl = $BaseUrl
            models  = $models
        }
    }
}

New-Item -ItemType Directory -Force -Path $AgentDir | Out-Null
$config | ConvertTo-Json -Depth 6 | Set-Content -Path $ModelsJson -Encoding utf8

Write-Host ""
Write-Host "  wrote $ModelsJson"
Write-Host "  No API key is stored in it - the next step collects that separately."
Write-Host "  If your endpoint uses the Responses API, change api to openai-responses."
