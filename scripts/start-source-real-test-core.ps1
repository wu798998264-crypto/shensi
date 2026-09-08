$ErrorActionPreference = "Stop"

$repositoryRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))
$outputRoot = Join-Path $repositoryRoot "output\playwright"
$stdoutPath = Join-Path $outputRoot "source-real-core.out.log"
$stderrPath = Join-Path $outputRoot "source-real-core.err.log"

New-Item -ItemType Directory -Path $outputRoot -Force | Out-Null
$env:SHENSI_DATA_ROOT = "E:\ShensiUserData"
$env:SHENSI_MACHINE_DATA_ROOT = "E:\ShensiUserData"

$process = Start-Process `
  -FilePath "node.exe" `
  -ArgumentList @((Join-Path $repositoryRoot "server.mjs"), "--host", "127.0.0.1", "--port", "7867") `
  -WorkingDirectory $repositoryRoot `
  -RedirectStandardOutput $stdoutPath `
  -RedirectStandardError $stderrPath `
  -WindowStyle Hidden `
  -PassThru

Start-Sleep -Seconds 5
$health = Invoke-RestMethod "http://127.0.0.1:7867/api/health" -TimeoutSec 10
[pscustomobject]@{
  Pid = $process.Id
  Version = $health.version
  Ok = $health.ok
  BuildHash = $health.buildHash
  DataRoot = $env:SHENSI_DATA_ROOT
} | ConvertTo-Json
