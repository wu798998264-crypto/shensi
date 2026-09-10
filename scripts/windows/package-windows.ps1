#Requires -Version 5.1
<#
.SYNOPSIS
    Shensi Creative Engine - Windows desktop installer packaging script.

.DESCRIPTION
    - Generates a timestamp-based buildId (format yyyyMMddHHmmssfff)
    - Updates release-build.json (buildId / createdAt / publishable=true)
    - Runs `npm run verify` and stops immediately on any failure
    - Packages with electron-builder and verifies the embedded build identity
    - Creates an output directory under release/windows for the installer

.PARAMETER SkipVerify
    Skip `npm run verify` and go straight to `npm run build`.

.PARAMETER SkipBuild
    Skip both verify and build (assume the code is already built; only
    regenerate the build identity and the output directory).

.PARAMETER OutputDir
    Output root directory (relative to the repo root). Default: release.

.PARAMETER ProductName
    Artifact name prefix. Default: ShensiCreativeEngine.

.EXAMPLE
    powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/windows/package-windows.ps1
#>
[CmdletBinding()]
param(
    [switch]$SkipVerify,
    [switch]$SkipBuild,
    [string]$OutputDir = "release",
    [string]$ProductName = "ShensiCreativeEngine"
)

$ErrorActionPreference = "Stop"

# ---------------------------------------------------------------------------
# Path resolution: repo root = two levels up from this script (scripts/windows)
# ---------------------------------------------------------------------------
$scriptDir = $null
if ($MyInvocation.MyCommand.Path) { $scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path }
if (-not $scriptDir) { $scriptDir = $PSScriptRoot }
if (-not $scriptDir) { $scriptDir = (Get-Location).Path }

# Ensure the scripts/windows directory exists (idempotent; this script lives there)
if (-not (Test-Path -LiteralPath $scriptDir)) {
    New-Item -ItemType Directory -Path $scriptDir -Force | Out-Null
}

$repoRoot = (Resolve-Path (Join-Path (Join-Path $scriptDir "..") "..")).Path
Write-Host "==> Repo root: $repoRoot"

$packageJsonPath = Join-Path $repoRoot "package.json"
$packageJson = Get-Content -LiteralPath $packageJsonPath -Raw -Encoding UTF8 | ConvertFrom-Json
$version = $packageJson.version

# A formal installer version is immutable. Refuse to create a second package
# with the same semantic version even though its timestamped buildId would be
# different. Bump package.json first so users can always distinguish releases.
$existingWindowsOutput = Join-Path (Join-Path $repoRoot $OutputDir) "windows"
if (Test-Path -LiteralPath $existingWindowsOutput) {
    $sameVersionInstaller = Get-ChildItem -LiteralPath $existingWindowsOutput -File -Filter "Shensi-Setup-$version-*-x64.exe" |
        Select-Object -First 1
    if ($sameVersionInstaller) {
        throw "Installer version $version already exists: $($sameVersionInstaller.Name). Increment package.json version before packaging again."
    }
}

# ---------------------------------------------------------------------------
# 1. Generate buildId and createdAt (UTC, matching release-build.json format)
# ---------------------------------------------------------------------------
$nowUtc = (Get-Date).ToUniversalTime()
$buildId = $nowUtc.ToString("yyyyMMddHHmmssfff")
$createdAt = $nowUtc.ToString("yyyy-MM-ddTHH:mm:ss.fffffffZ")
Write-Host "==> buildId   = $buildId"
Write-Host "==> createdAt = $createdAt"

# ---------------------------------------------------------------------------
# 2. Update release-build.json
# ---------------------------------------------------------------------------
$releaseBuildPath = Join-Path $repoRoot "release-build.json"
if (-not (Test-Path -LiteralPath $releaseBuildPath)) {
    throw "release-build.json not found at: $releaseBuildPath"
}

$releaseBuild = Get-Content -LiteralPath $releaseBuildPath -Raw -Encoding UTF8 | ConvertFrom-Json
$releaseBuild.version = $version
$releaseBuild.buildId = $buildId
$releaseBuild.createdAt = $createdAt
$releaseBuild.publishable = $true

$releaseBuildJson = $releaseBuild | ConvertTo-Json -Depth 20
[System.IO.File]::WriteAllText($releaseBuildPath, $releaseBuildJson, [System.Text.UTF8Encoding]::new($false))
Write-Host "==> Updated release-build.json (buildId=$buildId, publishable=true)"

# ---------------------------------------------------------------------------
# 3. Build verification. A formal package must never continue after a failed
# verification; callers may explicitly use -SkipVerify only for local diagnosis.
# ---------------------------------------------------------------------------
Push-Location $repoRoot
try {
    $buildOk = $false
    if (-not $SkipVerify) {
        Write-Host "==> Running: npm run verify ..."
        & npm run verify
        if ($LASTEXITCODE -eq 0) {
            $buildOk = $true
        } else { throw "npm run verify failed (exit $LASTEXITCODE)" }
    }
    if (-not $buildOk -and -not $SkipBuild) {
        Write-Host "==> Running: npm run build ..."
        & npm run build
        if ($LASTEXITCODE -ne 0) {
            throw "npm run build failed (exit $LASTEXITCODE)"
        }
        $buildOk = $true
    }
    if (-not $buildOk) {
        Write-Warning "Build verification skipped (both SkipVerify and SkipBuild were set)"
    }
} finally {
    Pop-Location
}

# ---------------------------------------------------------------------------
# 4. Prepare the installer output directory
# ---------------------------------------------------------------------------
$outputRoot = Join-Path $repoRoot $OutputDir
$windowsOutput = Join-Path $outputRoot "windows"
New-Item -ItemType Directory -Path $windowsOutput -Force | Out-Null
Write-Host "==> Output directory: $windowsOutput"

# ---------------------------------------------------------------------------
# 5. Package: prefer electron-builder, otherwise a simple portable staging
# ---------------------------------------------------------------------------
$electronBuilderCmd = Join-Path (Join-Path (Join-Path $repoRoot "node_modules") ".bin") "electron-builder.cmd"
$hasElectronBuilder = Test-Path -LiteralPath $electronBuilderCmd

if ($hasElectronBuilder) {
    Write-Host "==> Packaging with electron-builder ..."
    Push-Location $repoRoot
    try {
        $env:SHENSI_BUILD_ID = $buildId
        # electron-builder normally downloads Electron again even when the
        # exact runtime is already installed under node_modules. Prefer that
        # verified local runtime so formal builds are deterministic and do not
        # fail merely because GitHub/CDN TLS is temporarily unavailable.
        $localElectronDist = Join-Path (Join-Path (Join-Path $repoRoot "node_modules") "electron") "dist"
        $localElectronExe = Join-Path $localElectronDist "electron.exe"
        $builderArgs = @("--win", "--x64")
        if (Test-Path -LiteralPath $localElectronExe) {
            $env:ELECTRON_BUILDER_OFFLINE = "false"
            $builderArgs += "--config.electronDist=$localElectronDist"
            Write-Host "==> Using local Electron runtime: $localElectronDist"
            Write-Host "==> Local Electron runtime with online trusted timestamp signing"
            Write-Host "==> Formal signing requires a trusted timestamp for GitHub update publication"
        } else {
            Write-Warning "Local Electron runtime not found; electron-builder may download it from the configured mirror"
        }
        & $electronBuilderCmd @builderArgs
        if ($LASTEXITCODE -ne 0) {
            throw "electron-builder failed (exit $LASTEXITCODE)"
        }
    } finally {
        Pop-Location
    }
    Write-Host "==> electron-builder packaging complete"
} else {
    throw "electron-builder is required; unsafe fallback copying is disabled to prevent shipping personal works or test data."

    $stageName = "$ProductName-$version-$buildId"
    $stageRoot = Join-Path $windowsOutput $stageName
    if (Test-Path -LiteralPath $stageRoot) {
        Remove-Item -LiteralPath $stageRoot -Recurse -Force
    }

    $coreRoot = Join-Path (Join-Path $stageRoot "app") "core"
    $desktopAppRoot = Join-Path (Join-Path $stageRoot "app") "desktop-app"
    New-Item -ItemType Directory -Path $coreRoot -Force | Out-Null
    New-Item -ItemType Directory -Path $desktopAppRoot -Force | Out-Null

    # Copy the core runtime (server.mjs and its dependencies)
    $coreItems = @("server.mjs", "package.json", "release-build.json", "update-config.json", "index.html", "src", "scripts", "packaging")
    foreach ($item in $coreItems) {
        $src = Join-Path $repoRoot $item
        if (Test-Path -LiteralPath $src) {
            Copy-Item -LiteralPath $src -Destination $coreRoot -Recurse -Force
        }
    }

    # Copy the desktop shell (Electron main process / preload)
    $desktopAppSrc = Join-Path (Join-Path $repoRoot "packaging") "windows\desktop-app"
    if (Test-Path -LiteralPath $desktopAppSrc) {
        Get-ChildItem -LiteralPath $desktopAppSrc -Force | ForEach-Object {
            Copy-Item -LiteralPath $_.FullName -Destination $desktopAppRoot -Recurse -Force
        }
    }

    # Write a build manifest recording the buildId for this artifact
    $manifest = [ordered]@{
        productName = $ProductName
        version     = $version
        buildId      = $buildId
        createdAt    = $createdAt
        packagedAt   = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ss.fffffffZ")
        platform     = "win32"
        kind         = "portable-staging"
    }
    $manifestJson = $manifest | ConvertTo-Json -Depth 10
    $manifestPath = Join-Path $stageRoot "build-manifest.json"
    [System.IO.File]::WriteAllText($manifestPath, $manifestJson, [System.Text.UTF8Encoding]::new($false))
    Write-Host "==> Simple packaging complete: $stageRoot"
}

Write-Host "==> Packaging finished (buildId=$buildId)"

# A failed/interrupted NSIS run can leave a tiny uninstaller-only shell that
# looks like a valid .exe. Refuse to publish it: verify the final installer is
# substantial and parseable before treating this build as successful.
$installerPath = Join-Path $windowsOutput "Shensi-Setup-$version-$buildId-x64.exe"
& (Join-Path $repoRoot "scripts\windows\sign-final-installer.ps1") -InstallerPath $installerPath
& node (Join-Path $repoRoot "scripts\verify-windows-package.mjs") $installerPath
if ($LASTEXITCODE -ne 0) { throw "Windows installer verification failed (exit $LASTEXITCODE)" }
Write-Host "==> Installer verification passed: $installerPath"

# Retain only the current release, the most recent rollback version, and the
# pinned major stable node. The build-numbered installer remains immutable,
# while unpacked staging output and redundant micro-builds are removed.
& powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $repoRoot "scripts\windows\cleanup-windows-release.ps1") -RemoveUnpacked
if ($LASTEXITCODE -ne 0) { throw "Windows release cleanup failed (exit $LASTEXITCODE)" }
