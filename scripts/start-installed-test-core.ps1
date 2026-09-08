$ErrorActionPreference = "Stop"

$installRoot = "C:\Users\Administrator\AppData\Local\Programs\Shensi"
$nodeExecutable = Join-Path $installRoot "resources\node.exe"
$applicationRoot = Join-Path $installRoot "resources\app"
$outputRoot = Join-Path $PSScriptRoot "..\output\playwright"
$stdoutPath = Join-Path $outputRoot "installed-core.out.log"
$stderrPath = Join-Path $outputRoot "installed-core.err.log"

New-Item -ItemType Directory -Path $outputRoot -Force | Out-Null
$env:SHENSI_DATA_ROOT = "E:\ShensiUserData"
$env:SHENSI_MACHINE_DATA_ROOT = "E:\ShensiUserData"

$process = Start-Process `
  -FilePath $nodeExecutable `
  -ArgumentList @((Join-Path $applicationRoot "server.mjs"), "--host", "127.0.0.1", "--port", "7866") `
  -WorkingDirectory $applicationRoot `
  -RedirectStandardOutput $stdoutPath `
  -RedirectStandardError $stderrPath `
  -WindowStyle Hidden `
  -PassThru

Start-Sleep -Seconds 5
$health = Invoke-RestMethod "http://127.0.0.1:7866/api/health" -TimeoutSec 10
[pscustomobject]@{
  Pid = $process.Id
  Version = $health.version
  Ok = $health.ok
  BuildHash = $health.buildHash
  DataRoot = $env:SHENSI_DATA_ROOT
} | ConvertTo-Json
