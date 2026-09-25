param(
  [Parameter(Mandatory = $true)][string]$ProfileId,
  [Parameter(Mandatory = $true)][string]$Executable,
  [switch]$FreshLogin,
  [switch]$ProbeOnly,
  [Parameter(ValueFromRemainingArguments = $true)][string[]]$CliArgs
)

$ErrorActionPreference = 'Stop'
# The official CLI writes UTF-8 JSON. Windows PowerShell 5.1 otherwise uses the
# active OEM/ANSI code page for native-process pipes, which corrupts Chinese
# prompts in list_task and makes valid JSON look like an unavailable task
# resource session. Keep both native input and redirected output on UTF-8.
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
try { [Console]::InputEncoding = $utf8NoBom } catch {}
try { [Console]::OutputEncoding = $utf8NoBom } catch {}
$OutputEncoding = $utf8NoBom
$registryPath = 'HKCU\Software\BytedAuthClient\keychain\dreamina'
$profileRoot = if ($env:SHENSI_DREAMINA_PROFILE_HOME) {
  [System.IO.Path]::GetFullPath($env:SHENSI_DREAMINA_PROFILE_HOME)
} else {
  Join-Path $env:USERPROFILE ".dreamina_profiles\$ProfileId"
}
$profileAuth = Join-Path $profileRoot 'auth.reg'
$mutex = [System.Threading.Mutex]::new($false, 'Global\ShensiDreaminaCredentialSwitchV1')
$lockTaken = $false
$temporaryRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("shensi-dreamina-" + [guid]::NewGuid().ToString('N'))
$currentAuth = Join-Path $temporaryRoot 'current.reg'
$commandStderr = Join-Path $temporaryRoot 'command.stderr.log'
$recoveryRoot = Join-Path ([System.IO.Path]::GetTempPath()) 'shensi-dreamina-broker-recovery-v1'
$recoveryAuth = Join-Path $recoveryRoot 'current.reg'
$recoveryEmpty = Join-Path $recoveryRoot 'current.empty'
$hadCurrentAuth = $false
$exitCode = 1
$brokerLeasePath = [string]$env:SHENSI_DREAMINA_BROKER_LEASE_PATH
$brokerLeaseToken = [guid]::NewGuid().ToString('N')

function Write-DreaminaBrokerLease([string]$Command) {
  if ([string]::IsNullOrWhiteSpace($brokerLeasePath)) { return }
  $leaseDirectory = [System.IO.Path]::GetDirectoryName($brokerLeasePath)
  if (-not [string]::IsNullOrWhiteSpace($leaseDirectory)) {
    [System.IO.Directory]::CreateDirectory($leaseDirectory) | Out-Null
  }
  $lease = [ordered]@{
    profileId = $ProfileId
    token = $brokerLeaseToken
    pid = $PID
    jobId = [string]$env:SHENSI_DREAMINA_JOB_ID
    channel = [string]$env:SHENSI_DREAMINA_CHANNEL
    command = [string]$Command
    acquiredAt = [DateTime]::UtcNow.ToString('o')
  }
  $temporary = "$brokerLeasePath.$PID.$brokerLeaseToken.tmp"
  [System.IO.File]::WriteAllText($temporary, ($lease | ConvertTo-Json -Compress), $utf8NoBom)
  try {
    if ([System.IO.File]::Exists($brokerLeasePath)) {
      [System.IO.File]::Replace($temporary, $brokerLeasePath, $null)
    } else {
      [System.IO.File]::Move($temporary, $brokerLeasePath)
    }
  } finally {
    if ([System.IO.File]::Exists($temporary)) { Remove-Item -LiteralPath $temporary -Force -ErrorAction SilentlyContinue }
  }
}

function Clear-DreaminaBrokerLease {
  if ([string]::IsNullOrWhiteSpace($brokerLeasePath) -or -not (Test-Path -LiteralPath $brokerLeasePath)) { return }
  try {
    $lease = Get-Content -LiteralPath $brokerLeasePath -Raw -ErrorAction Stop | ConvertFrom-Json
    if ([string]$lease.token -eq $brokerLeaseToken) {
      Remove-Item -LiteralPath $brokerLeasePath -Force -ErrorAction SilentlyContinue
    }
  } catch {
    # Never remove another live runner's lease when an interrupted write left
    # unreadable metadata. The server will discard it after the owner exits.
  }
}

function Test-DreaminaRegistryKey {
  $previousPreference = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  & reg.exe query $registryPath *> $null
  $result = $LASTEXITCODE -eq 0
  $ErrorActionPreference = $previousPreference
  return $result
}

function Export-DreaminaRegistryKey([string]$Target) {
  $previousPreference = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  & reg.exe export $registryPath $Target /y *> $null
  $code = $LASTEXITCODE
  $ErrorActionPreference = $previousPreference
  if ($code -ne 0) { throw "Dreamina credential export failed (exit $code)" }
}

function Remove-DreaminaRegistryKey {
  if (Test-DreaminaRegistryKey) {
    $previousPreference = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    & reg.exe delete $registryPath /f *> $null
    $ErrorActionPreference = $previousPreference
  }
}

function Import-DreaminaRegistryKey([string]$Source) {
  $previousPreference = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  & reg.exe import $Source *> $null
  $code = $LASTEXITCODE
  $ErrorActionPreference = $previousPreference
  if ($code -ne 0) { throw "Dreamina credential import failed (exit $code)" }
}

function Test-DreaminaUsableTaskId([string]$Value) {
  $normalized = ([string]$Value).Trim().Trim('"')
  if ([string]::IsNullOrWhiteSpace($normalized)) { return $false }
  return $normalized -notmatch '^(?i:0|-|none|null|undefined|unknown|missing|n/?a|na)$'
}

function Test-DreaminaTaskIdentityOutput([string]$Output) {
  if ([string]::IsNullOrWhiteSpace($Output)) { return $false }
  foreach ($match in [regex]::Matches($Output, '(?im)(?:^|[\r\n{,])\s*"?(?:submit_id|submitId|task_id|taskId|providerTaskId)"?\s*[=:]\s*"?([A-Za-z0-9._:-]+)')) {
    if (Test-DreaminaUsableTaskId -Value $match.Groups[1].Value) { return $true }
  }
  return $false
}

function Test-DreaminaVideoGenerationCommand([string]$Command) {
  $normalized = ([string]$Command).Trim().ToLowerInvariant()
  if ($normalized -in @('text2video', 'image2video', 'frames2video', 'multiframe2video', 'multimodal2video', 'multiframe_video', 'longvideo')) { return $true }
  if ($normalized -in @('version', 'user_credit', 'list_task', 'query_result', 'cancel_task', 'cancel', 'task_cancel', 'login', 'relogin', 'logout', '--help')) { return $false }
  return -not [string]::IsNullOrWhiteSpace($normalized) -and $normalized -match 'video'
}

function Test-DreaminaGenerationCommand([string]$Command) {
  $normalized = ([string]$Command).Trim().ToLowerInvariant()
  if (Test-DreaminaVideoGenerationCommand -Command $normalized) { return $true }
  if ($normalized -in @('text2image', 'image2image')) { return $true }
  if ($normalized -in @('version', 'user_credit', 'list_task', 'query_result', 'cancel_task', 'cancel', 'task_cancel', 'login', 'relogin', 'logout', '--help')) { return $false }
  return -not [string]::IsNullOrWhiteSpace($normalized) -and $normalized -match 'image'
}

function Test-DreaminaSemanticAuthFailure([string]$Output, [string]$Command) {
  if ([string]::IsNullOrWhiteSpace($Output)) { return $false }
  $matchesAuthFailure = $Output -match '(?is)authsdk:\s*not logged in' `
    -or $Output -match '(?is)未检测到(?:有效)?登录态|请先执行\s*dreamina\s+login' `
    -or $Output -match '(?is)authsdk:.*refresh failed.*(?:protocol server.*code\s*=\s*10044|session (?:expired|rejected|invalid))'
  if (-not $matchesAuthFailure) { return $false }

  # A video-generation response carrying a durable provider task identity is
  # a task record, even when its failure text mentions authsdk. Preserve the
  # task ID so the caller can query or surface that exact provider task rather
  # than incorrectly invalidating an already verified account.
  if ((Test-DreaminaGenerationCommand -Command $Command) -and (Test-DreaminaTaskIdentityOutput -Output $Output)) {
    return $false
  }

  if ($Command -eq 'list_task') {
    # Prefer a narrow textual identity check before JSON parsing. Historical
    # prompts can contain provider text that Windows PowerShell 5.1 cannot
    # always decode back through ConvertFrom-Json, but a non-empty task ID is
    # still sufficient to prove this is a task record rather than a command
    # authentication envelope.
    if (Test-DreaminaTaskIdentityOutput -Output $Output) {
      return $false
    }
    try {
      $payload = $Output | ConvertFrom-Json
      if ($payload -is [System.Array]) {
        # list_task returns historical provider jobs. A failed historical job
        # may legitimately contain "resource store: authsdk: not logged in" in
        # fail_reason even though the current command and account session are
        # healthy. Only an item without a provider task identity can represent
        # a command-level authentication envelope.
        $commandFailure = @($payload) | Where-Object {
          $status = if ($_.status) { [string]$_.status } elseif ($_.gen_status) { [string]$_.gen_status } else { [string]$_.task_status }
          $taskId = if ($_.submit_id) { [string]$_.submit_id } elseif ($_.submitId) { [string]$_.submitId } elseif ($_.task_id) { [string]$_.task_id } else { [string]$_.taskId }
          $taskIdMissing = [string]::IsNullOrWhiteSpace($taskId)
          ($taskIdMissing -or (-not (Test-DreaminaUsableTaskId -Value $taskId))) -and $status -match '^(?i:fail|failed|error)$'
        } | Select-Object -First 1
        return $null -ne $commandFailure
      }
    } catch {
      # Non-JSON command failures still use the stable text protocol below.
    }
  }
  return $true
}

try {
  try {
    # The official CLI stores its active account in one Windows registry slot,
    # so profile commands must be serialized.  Do not sit behind that mutex for
    # minutes, though: the durable media worker can safely retry a command that
    # has not entered the credential slot yet.  A short, typed busy response
    # prevents an outer 60/150-second watchdog from misreporting queue pressure
    # as a failed paid generation.
    $lockTaken = $mutex.WaitOne([TimeSpan]::FromSeconds(2))
  } catch [System.Threading.AbandonedMutexException] {
    # Windows 在上一个 CLI 被强制结束时会把互斥锁标为 abandoned，
    # 但当前进程此时已经取得锁。继续执行并在 finally 中正常释放，
    # 避免把一次旧进程异常误报为当前账号不可用。
    $lockTaken = $true
  }
  if (-not $lockTaken) {
    # Keep the broker protocol marker ASCII-only. Windows PowerShell 5.1 reads
    # UTF-8 scripts without a BOM using the active ANSI code page, so localized
    # executable strings here can corrupt parsing before the CLI even starts.
    [Console]::Error.WriteLine('[DREAMINA_PROFILE_BROKER_BUSY] Dreamina credential slot is busy; command not started.')
    exit 75
  }
  $leaseCommand = if ($ProbeOnly) { 'probe_lock' } elseif ($CliArgs.Count -gt 0) { [string]$CliArgs[0] } else { '' }
  Write-DreaminaBrokerLease -Command $leaseCommand
  if ($ProbeOnly) {
    [Console]::Out.WriteLine('DREAMINA_PROFILE_LOCK_ACQUIRED')
    $exitCode = 0
  } else {
  New-Item -ItemType Directory -Force -Path $profileRoot, $temporaryRoot | Out-Null

  # A force-killed PowerShell process cannot run finally. Recover the real
  # Windows credential slot left by that interrupted command before reading or
  # installing any profile snapshot, otherwise the next profile can appear to
  # be logged into the previous account.
  if (Test-Path -LiteralPath $recoveryAuth) {
    Remove-DreaminaRegistryKey
    Import-DreaminaRegistryKey $recoveryAuth
    Remove-Item -LiteralPath $recoveryAuth -Force
  } elseif (Test-Path -LiteralPath $recoveryEmpty) {
    Remove-DreaminaRegistryKey
    Remove-Item -LiteralPath $recoveryEmpty -Force
  }

  $hadCurrentAuth = Test-DreaminaRegistryKey
  if ($hadCurrentAuth) { Export-DreaminaRegistryKey $currentAuth }
  New-Item -ItemType Directory -Force -Path $recoveryRoot | Out-Null
  Remove-Item -LiteralPath $recoveryAuth, $recoveryEmpty -Force -ErrorAction SilentlyContinue
  if ($hadCurrentAuth) { Copy-Item -LiteralPath $currentAuth -Destination $recoveryAuth -Force }
  else { New-Item -ItemType File -Force -Path $recoveryEmpty | Out-Null }
  Remove-DreaminaRegistryKey
  # OAuth device binding must start from an empty keychain. Importing the old
  # profile token before `login checklogin` can silently keep the previous
  # account and make a newly named configuration point at the default user.
  if (-not $FreshLogin -and (Test-Path -LiteralPath $profileAuth)) { Import-DreaminaRegistryKey $profileAuth }

  $firstArg = if ($CliArgs.Count -gt 0) { [string]$CliArgs[0] } else { '' }
  $loginCommand = $firstArg -in @('login', 'relogin', 'logout')
  if (-not (Test-Path -LiteralPath $profileAuth) -and -not $loginCommand) {
    [Console]::Error.WriteLine("[DREAMINA_AUTH_REQUIRED] Dreamina profile '$ProfileId' is not signed in. Complete OAuth login first.")
    $exitCode = 78
  } else {
    # The official CLI can print an authentication-failure payload while still
    # returning exit code 0. Observe stdout without suppressing it so the caller
    # receives the original response, and keep stderr on its original stream.
    # This semantic verdict must happen before the isolated snapshot is saved.
    $commandOutput = @()
    & $Executable @CliArgs 2> $commandStderr | Tee-Object -Variable commandOutput
    $exitCode = $LASTEXITCODE
    $stderrText = if (Test-Path -LiteralPath $commandStderr) {
      Get-Content -LiteralPath $commandStderr -Raw -ErrorAction SilentlyContinue
    } else { '' }
    if (-not [string]::IsNullOrEmpty($stderrText)) { [Console]::Error.Write($stderrText) }
    $semanticOutput = ((@($commandOutput) | ForEach-Object { [string]$_ }) -join "`n") + "`n" + $stderrText
    if (Test-DreaminaSemanticAuthFailure -Output $semanticOutput -Command $firstArg) {
      if (Test-DreaminaGenerationCommand -Command $firstArg) {
        [Console]::Error.WriteLine('[DREAMINA_GENERATION_SESSION_REJECTED] authsdk: not logged in; the media generation command did not return a provider task ID, so submission outcome is unknown and the verified account snapshot remains valid.')
        if ($exitCode -eq 0) { $exitCode = 79 }
      } else {
        [Console]::Error.WriteLine('[DREAMINA_AUTH_REQUIRED] authsdk: not logged in; Dreamina returned an authentication failure payload and the previous verified profile snapshot was preserved.')
        if ($exitCode -eq 0) { $exitCode = 78 }
      }
    }
  }

  # Never replace a known-good isolated credential with registry state left by
  # a failed login, refresh, generation or query command. Successful commands
  # still persist normal token rotation immediately. OAuth relogin failures are
  # additionally restored from the server-side backup.
  if ($exitCode -eq 0 -and (Test-DreaminaRegistryKey)) {
    Export-DreaminaRegistryKey $profileAuth
    $previousPreference = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    & icacls.exe $profileAuth /inheritance:r /grant:r "$env:USERNAME`:F" 'SYSTEM:F' *> $null
    $ErrorActionPreference = $previousPreference
  }
  }
} finally {
  try {
    if (-not $ProbeOnly) {
      Remove-DreaminaRegistryKey
      if ($hadCurrentAuth -and (Test-Path -LiteralPath $currentAuth)) { Import-DreaminaRegistryKey $currentAuth }
    }
  } finally {
    if (-not $ProbeOnly) {
      Remove-Item -LiteralPath $recoveryAuth, $recoveryEmpty -Force -ErrorAction SilentlyContinue
      if (Test-Path -LiteralPath $recoveryRoot) { Remove-Item -LiteralPath $recoveryRoot -Force -ErrorAction SilentlyContinue }
      if (Test-Path -LiteralPath $temporaryRoot) { Remove-Item -LiteralPath $temporaryRoot -Recurse -Force }
    }
    Clear-DreaminaBrokerLease
    if ($lockTaken) { $mutex.ReleaseMutex() }
    $mutex.Dispose()
  }
}

exit $exitCode
