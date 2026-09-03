# Configure the inference endpoint for this deployment.
#
# PowerShell twin of 10-configure-inference.sh, for Windows deployments.
# Idempotent: exits once models.json exists. To reconfigure or rotate the key,
# delete the file and relaunch.
#
# The key is collected here, in the terminal, so it is never part of a prompt, a
# transcript, or anything the model can read back -- and it is written straight
# into models.json, because a key stored anywhere else is a second step the user
# has to discover on their own, after launch, from an error that does not name
# it. One prompt, one file, models work on the first run.
$ErrorActionPreference = 'Stop'

$AgentDir   = if ($env:GAH_CODING_AGENT_DIR) { $env:GAH_CODING_AGENT_DIR } else { Join-Path $HOME '.gah\agent' }
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
# Two wire protocols speak "OpenAI". Chat Completions is what most gateways,
# vLLM and Ollama serve; the Responses API is what gpt-5-class models are
# served through on OpenAI-compatible corporate gateways, and a gateway that
# only half-implements streaming tool calls on Chat Completions shows up as
# nameless tool calls in the agent. Default from the model ids; overridable.
$ApiDefault = if ($ModelIds -match '(^|,)\s*(gpt-5|o\d)') { 'openai-responses' } else { 'openai-completions' }
$ApiKind = Read-Host "  API (openai-completions or openai-responses) [$ApiDefault]"
if ([string]::IsNullOrWhiteSpace($ApiKind)) { $ApiKind = $ApiDefault }
if ($ApiKind -notin @('openai-completions', 'openai-responses')) {
    Write-Host "  unknown API '$ApiKind', using $ApiDefault"; $ApiKind = $ApiDefault
}
$Secure   = Read-Host "  API key" -AsSecureString
$ApiKey   = [Runtime.InteropServices.Marshal]::PtrToStringAuto(
    [Runtime.InteropServices.Marshal]::SecureStringToBSTR($Secure))

$models = @()
foreach ($id in ($ModelIds -split ',')) {
    $t = $id.Trim()
    if ($t) { $models += [ordered]@{ id = $t; input = @('text') } }
}

$provider = [ordered]@{
    name    = $ProviderId
    api     = $ApiKind
    baseUrl = $BaseUrl
}
# ConvertTo-Json escapes the key for us; no hand-rolled quoting.
if (-not [string]::IsNullOrWhiteSpace($ApiKey)) { $provider.apiKey = $ApiKey }
$provider.models = $models

$config = [ordered]@{ providers = [ordered]@{ $ProviderId = $provider } }

New-Item -ItemType Directory -Force -Path $AgentDir | Out-Null
$config | ConvertTo-Json -Depth 6 | Set-Content -Path $ModelsJson -Encoding utf8

# Windows has no umask: the file inherits the parent ACL, so restrict it to this
# user explicitly or the key is readable by anyone with access to the profile.
$acl = Get-Acl $ModelsJson
$acl.SetAccessRuleProtection($true, $false)
$acl.SetAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule(
    $env:USERNAME, 'FullControl', 'Allow')))
Set-Acl -Path $ModelsJson -AclObject $acl

$hadKey = -not [string]::IsNullOrWhiteSpace($ApiKey)
$ApiKey = $null

Write-Host ""
Write-Host "  wrote $ModelsJson (owner-only ACL)"
if (-not $hadKey) {
    Write-Host "  No key stored - add `"apiKey`" to that file, or run /login in the agent."
}
Write-Host "  To switch protocols later, edit `"api`" in that file (openai-completions / openai-responses)."
