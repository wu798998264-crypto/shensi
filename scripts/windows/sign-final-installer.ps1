param([Parameter(Mandatory=$true)][string]$InstallerPath)
$ErrorActionPreference = 'Stop'
Import-Module (Join-Path $PSHOME 'Modules\Microsoft.PowerShell.Security\Microsoft.PowerShell.Security.psd1') -Force
$installer = (Resolve-Path -LiteralPath $InstallerPath).Path
$metadata = Get-Content -Raw -LiteralPath (Join-Path $PSScriptRoot '..\..\package.json') | ConvertFrom-Json
$signing = $metadata.build.win.signtoolOptions
$sdkRoot = Join-Path ${env:ProgramFiles(x86)} 'Windows Kits\10\bin'
$tool = Get-ChildItem -LiteralPath $sdkRoot -Directory | Sort-Object Name -Descending | ForEach-Object {
    $candidate = Join-Path $_.FullName 'x64\signtool.exe'
    if (Test-Path -LiteralPath $candidate) { $candidate }
} | Select-Object -First 1
if (-not $tool) { throw 'Windows SDK x64 signtool is required to finalize release signing' }
& $tool sign /sha1 $signing.certificateSha1 /s My /fd SHA256 /tr $signing.rfc3161TimeStampServer /td SHA256 $installer
if ($LASTEXITCODE -ne 0) { throw 'Final installer signing failed' }
$signature = Get-AuthenticodeSignature -LiteralPath $installer
if ($signature.Status -ne 'Valid' -or -not $signature.TimeStamperCertificate) { throw 'Final installer signature or trusted timestamp is invalid' }
Write-Output 'Final installer signature and trusted timestamp verified'
