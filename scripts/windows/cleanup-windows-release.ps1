#Requires -Version 5.1
[CmdletBinding()]
param(
    [string[]]$KeepVersions = @(),
    [switch]$RemoveUnpacked
)

$ErrorActionPreference = "Stop"
$scriptRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$repoRoot = (Resolve-Path -LiteralPath (Join-Path $scriptRoot "..\..")).Path
$releaseRoot = (Resolve-Path -LiteralPath (Join-Path $repoRoot "release\windows")).Path

if (-not $releaseRoot.StartsWith($repoRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "Release path is outside the repository: $releaseRoot"
}

if (-not $KeepVersions.Count) {
    $packageVersion = (Get-Content -LiteralPath (Join-Path $repoRoot "package.json") -Raw -Encoding UTF8 | ConvertFrom-Json).version
    $currentVersion = [version]$packageVersion
    $publishedVersions = Get-ChildItem -LiteralPath $releaseRoot -File -Filter "Shensi-Setup-*-x64.exe" |
        ForEach-Object {
            if ($_.Name -match '^Shensi-Setup-(\d+\.\d+\.\d+)-\d{17}-x64\.exe$') {
                [version]$Matches[1]
            }
        } |
        Sort-Object -Descending -Unique
    $previousVersion = $publishedVersions | Where-Object { $_ -lt $currentVersion } | Select-Object -First 1
    $KeepVersions = @($packageVersion, "2.8.0")
    if ($previousVersion) { $KeepVersions += $previousVersion.ToString() }
    $KeepVersions = @($KeepVersions | Sort-Object -Unique)
}

$removed = 0
$freedBytes = [int64]0
foreach ($file in Get-ChildItem -LiteralPath $releaseRoot -File) {
    if ($file.Name -notlike "Shensi-Setup-*") { continue }
    $keep = $false
    foreach ($version in $KeepVersions) {
        if ($file.Name -like "Shensi-Setup-$version-*") {
            $keep = $true
            break
        }
    }
    if ($keep) { continue }
    if (-not $file.FullName.StartsWith($releaseRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "Release file is outside the verified output directory: $($file.FullName)"
    }
    $freedBytes += $file.Length
    Remove-Item -LiteralPath $file.FullName -Force
    $removed += 1
}

if ($RemoveUnpacked) {
    $unpacked = Join-Path $releaseRoot "win-unpacked"
    if (Test-Path -LiteralPath $unpacked) {
        $resolvedUnpacked = (Resolve-Path -LiteralPath $unpacked).Path
        if (-not $resolvedUnpacked.StartsWith($releaseRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
            throw "Unpacked output is outside the verified release directory: $resolvedUnpacked"
        }
        $freedBytes += [int64]((Get-ChildItem -LiteralPath $resolvedUnpacked -Recurse -File | Measure-Object Length -Sum).Sum)
        Remove-Item -LiteralPath $resolvedUnpacked -Recurse -Force
    }
}

[pscustomobject]@{
    releaseRoot = $releaseRoot
    keptVersions = $KeepVersions
    removedFiles = $removed
    freedBytes = $freedBytes
} | ConvertTo-Json -Depth 4
