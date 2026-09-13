param([Parameter(Mandatory=$true)][string]$InstallerPath)
$ErrorActionPreference = 'Stop'
Import-Module (Join-Path $PSHOME 'Modules\Microsoft.PowerShell.Security\Microsoft.PowerShell.Security.psd1') -Force
$installer = (Resolve-Path -LiteralPath $InstallerPath).Path
$metadata = Get-Content -Raw -Encoding UTF8 -LiteralPath (Join-Path $PSScriptRoot '..\..\package.json') | ConvertFrom-Json
$signing = $metadata.build.win.signtoolOptions
$sdkRoot = Join-Path ${env:ProgramFiles(x86)} 'Windows Kits\10\bin'
$tool = Get-ChildItem -LiteralPath $sdkRoot -Directory | Sort-Object Name -Descending | ForEach-Object {
    $candidate = Join-Path $_.FullName 'x64\signtool.exe'
    if (Test-Path -LiteralPath $candidate) { $candidate }
} | Select-Object -First 1
if (-not $tool) { throw 'Windows SDK x64 signtool is required to finalize release signing' }
$signingComplete = $false
for ($attempt = 1; $attempt -le 5; $attempt += 1) {
    $previousErrorActionPreference = $ErrorActionPreference
    try {
        # Windows PowerShell can promote native stderr to a terminating
        # NativeCommandError when the surrounding script uses Stop. Capture
        # the text and classify the real signtool exit code below instead.
        $ErrorActionPreference = 'Continue'
        $signOutput = & $tool sign /sha1 $signing.certificateSha1 /s My /fd SHA256 /tr $signing.rfc3161TimeStampServer /td SHA256 $installer 2>&1
        $signExitCode = $LASTEXITCODE
    } finally {
        $ErrorActionPreference = $previousErrorActionPreference
    }
    if ($signExitCode -eq 0) {
        $signingComplete = $true
        break
    }
    $signError = ($signOutput | Out-String).Trim()
    $sharingViolation = $signError -match 'being used by another process|sharing violation'
    if (-not $sharingViolation -or $attempt -eq 5) {
        throw "Final installer signing failed: $signError"
    }
    Start-Sleep -Seconds (2 * $attempt)
}
if (-not $signingComplete) { throw 'Final installer signing failed after file-lock retries' }
$signature = Get-AuthenticodeSignature -LiteralPath $installer
if ($signature.Status -ne 'Valid' -or -not $signature.TimeStamperCertificate) { throw 'Final installer signature or trusted timestamp is invalid' }
Write-Output 'Final installer signature and trusted timestamp verified'
