# Collect the inference API key.
#
# Runs in the terminal before the agent starts, so the key is never part of a
# prompt, a transcript, or anything the model can read back. Idempotent.
$ErrorActionPreference = 'Stop'

$AgentDir   = if ($env:GAH_AGENT_DIR) { $env:GAH_AGENT_DIR } else { Join-Path $HOME '.gah\agent' }
$ModelsJson = Join-Path $AgentDir 'models.json'
$KeyFile    = Join-Path $AgentDir 'provider-key'

if (-not (Test-Path $ModelsJson)) { exit 0 }
if (Test-Path $KeyFile) { exit 0 }
if (-not [Environment]::UserInteractive) { exit 0 }

Write-Host ""
$Secure = Read-Host "  API key for your inference endpoint (blank to skip)" -AsSecureString
$Plain  = [Runtime.InteropServices.Marshal]::PtrToStringAuto(
            [Runtime.InteropServices.Marshal]::SecureStringToBSTR($Secure))
if ([string]::IsNullOrWhiteSpace($Plain)) { Write-Host "  skipped"; exit 0 }

Set-Content -Path $KeyFile -Value $Plain -NoNewline -Encoding ascii

# Windows has no umask: restrict the ACL to this user explicitly, or the key
# inherits whatever the parent directory allows.
$acl = Get-Acl $KeyFile
$acl.SetAccessRuleProtection($true, $false)
$acl.SetAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule(
    $env:USERNAME, 'FullControl', 'Allow')))
Set-Acl -Path $KeyFile -AclObject $acl

Remove-Variable Plain

Write-Host "  stored in $KeyFile (owner-only ACL)"
Write-Host ""
Write-Host "  Reference it from models.json as the provider's apiKey, or set it"
Write-Host "  in your environment. Storing it outside models.json keeps the key"
Write-Host "  out of any config you might copy, paste, or attach to an issue."
