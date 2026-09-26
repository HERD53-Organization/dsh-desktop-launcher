<#
.SYNOPSIS
  Run after an electron-builder build to embed the icon into the launcher .exe.

.DESCRIPTION
  electron-builder would normally embed the icon itself through rcedit, which it
  extracts from the `winCodeSign` archive. That archive also contains macOS
  .dylib symlinks, and 7-Zip cannot create symlinks without Administrator or
  Developer Mode, so the extraction fails and BOTH code signing and icon
  embedding are skipped. The build therefore sets
  `win.signAndEditExecutable: false` to avoid the download, and the icon is
  applied here instead.

  Kept as a separate file rather than inlined into package.json: passing
  PowerShell code through npm on Windows turns into quote-escaping noise, while
  `-File <path>` needs none.

  A no-op on non-Windows platforms and on a missing target, so it is safe to
  chain unconditionally after a build.
#>
[CmdletBinding()]
param(
  [string]$Executable
)

$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
if ([string]::IsNullOrEmpty($Executable)) {
  # Must match electron-builder's `directories.output`. When this default went
  # stale after the output moved from out/ to build/, the script reported
  # "skipped" and the build still exited 0 - shipping an Electron-icon .exe with
  # no error. A missing target is therefore a failure, not a no-op.
  $Executable = Join-Path $projectRoot 'build\win-unpacked\DSH Launcher.exe'
}

if ($env:OS -ne 'Windows_NT') {
  Write-Host '  embed-exe-icon: not Windows; skipped'
  exit 0
}
if (-not (Test-Path $Executable)) {
  Write-Error "embed-exe-icon: no packaged executable at '$Executable'. Run the electron-builder step first, or pass -Executable."
  exit 1
}

& (Join-Path $PSScriptRoot 'set-exe-icon.ps1') -Executable $Executable
