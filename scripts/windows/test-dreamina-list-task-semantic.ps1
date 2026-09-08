$runner = Join-Path $PSScriptRoot 'dreamina-profile-runner.ps1'
$temporaryRoot = Join-Path ([System.IO.Path]::GetTempPath()) ('shensi-dreamina-semantic-test-' + [guid]::NewGuid().ToString('N'))
$fakeCli = Join-Path $temporaryRoot 'fake-dreamina.cmd'
$profileRoot = Join-Path $temporaryRoot 'profile'
$profileAuth = Join-Path $profileRoot 'auth.reg'

New-Item -ItemType Directory -Force -Path $temporaryRoot, $profileRoot | Out-Null
try {
  Set-Content -LiteralPath $profileAuth -Encoding Unicode -Value @'
Windows Registry Editor Version 5.00

[HKEY_CURRENT_USER\Software\BytedAuthClient\keychain\dreamina]
"semantic-test"="test-only"
'@
  Set-Content -LiteralPath $fakeCli -Encoding ASCII -Value @'
@echo off
if "%1"=="list_task" (
  echo [{"submit_id":"historical-task-1","gen_status":"fail","fail_reason":"resource store: authsdk: not logged in"}]
  exit /b 0
)
echo authsdk: not logged in
exit /b 0
'@
  $previousHome = $env:SHENSI_DREAMINA_PROFILE_HOME
  $env:SHENSI_DREAMINA_PROFILE_HOME = $profileRoot
  try {
    & powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File $runner -ProfileId semantic-test -Executable $fakeCli list_task '--limit=1'
    if ($LASTEXITCODE -ne 0) { throw "historical list_task was rejected with exit $LASTEXITCODE" }

    & powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File $runner -ProfileId semantic-test -Executable $fakeCli user_credit
    if ($LASTEXITCODE -ne 78) { throw "command-level auth failure returned exit $LASTEXITCODE instead of 78" }
  } finally {
    if ($null -eq $previousHome) { Remove-Item Env:SHENSI_DREAMINA_PROFILE_HOME -ErrorAction SilentlyContinue }
    else { $env:SHENSI_DREAMINA_PROFILE_HOME = $previousHome }
  }
  [Console]::Out.WriteLine('Dreamina list_task semantic authentication regression checks passed')
} finally {
  Remove-Item -LiteralPath $temporaryRoot -Recurse -Force -ErrorAction SilentlyContinue
}
