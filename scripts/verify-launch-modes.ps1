<#
.SYNOPSIS
  Verify the two launch behaviours: a manual launch opens a window, an autostart
  launch only installs the tray.

.DESCRIPTION
  The self-test runs without --autostart, so it can only prove the manual path.
  This drives the real executable both ways and watches for visible top-level
  windows, which is the part a user actually notices.

  Window visibility is detected through EnumWindows rather than
  Process.MainWindowHandle: an Electron app owns several message-only and
  helper windows, and MainWindowHandle does not reliably report the real one.

.EXAMPLE
  powershell -File scripts\verify-launch-modes.ps1 -Executable "build\win-unpacked\DSH Launcher.exe"
#>
[CmdletBinding()]
param(
  [string]$Executable,
  [int]$ObserveMs = 9000
)

$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
if ([string]::IsNullOrEmpty($Executable)) {
  $Executable = Join-Path $projectRoot 'build\win-unpacked\DSH Launcher.exe'
}
if (-not (Test-Path $Executable)) { throw "not found: $Executable" }

Add-Type -Namespace Win -Name Vis -MemberDefinition @'
[DllImport("user32.dll")]
public static extern bool IsWindowVisible(IntPtr hWnd);
[DllImport("user32.dll")]
public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
[DllImport("user32.dll")]
public static extern bool EnumWindows(EnumProc cb, IntPtr param);
[DllImport("user32.dll", CharSet = CharSet.Unicode)]
public static extern int GetWindowTextW(IntPtr hWnd, System.Text.StringBuilder text, int count);
[DllImport("user32.dll")]
public static extern bool IsWindow(IntPtr hWnd);
public delegate bool EnumProc(IntPtr hWnd, IntPtr param);
'@

<#
  Collects the visible top-level windows owned by one process.

  The accumulator is a local captured by the delegate, not $script: scope: a
  script-scoped counter survives between calls and reported the previous run's
  total, which made an autostart launch look like it had opened windows.
#>
function Get-VisibleWindows([int]$TargetProcessId) {
  $collected = New-Object System.Collections.Generic.List[string]
  $callback = [Win.Vis+EnumProc]{
    param($hWnd, $param)
    $owner = 0
    [void][Win.Vis]::GetWindowThreadProcessId($hWnd, [ref]$owner)
    if ($owner -eq $TargetProcessId -and [Win.Vis]::IsWindowVisible($hWnd)) {
      $buffer = New-Object System.Text.StringBuilder 256
      [void][Win.Vis]::GetWindowTextW($hWnd, $buffer, 256)
      $collected.Add($buffer.ToString())
    }
    return $true
  }
  [void][Win.Vis]::EnumWindows($callback, [IntPtr]::Zero)
  return $collected
}

function Test-LaunchMode([string]$Label, [string[]]$ExtraArgs, [bool]$ExpectWindow) {
  Write-Host ''
  Write-Host "  --- $Label ---"
  $userData = Join-Path $env:TEMP ("dsh-launchmode-" + [guid]::NewGuid().ToString('N').Substring(0, 8))
  $arguments = @("--user-data-dir=$userData") + $ExtraArgs
  $process = Start-Process -FilePath $Executable -ArgumentList $arguments -PassThru
  $targetPid = $process.Id

  $titles = New-Object System.Collections.Generic.List[string]
  $deadline = (Get-Date).AddMilliseconds($ObserveMs)
  while ((Get-Date) -lt $deadline) {
    if ($process.HasExited) { break }
    foreach ($title in (Get-VisibleWindows $targetPid)) {
      if (-not $titles.Contains($title)) { $titles.Add($title) }
    }
    Start-Sleep -Milliseconds 400
  }

  $exitedEarly = $process.HasExited
  if (-not $exitedEarly) {
    # Stop only this instance, by pid and tree.
    taskkill /PID $targetPid /T /F 2>&1 | Out-Null
    Start-Sleep -Milliseconds 500
  }

  $maxVisible = $titles.Count
  $named = @($titles | Where-Object { $_ -ne '' })
  Write-Host ("    visible windows : {0}{1}" -f $maxVisible,
    $(if ($exitedEarly) { ' (process exited early!)' } else { '' }))
  if ($named.Count -gt 0) { Write-Host ("    titles          : {0}" -f ($named -join ' | ')) }

  # Windows with no title are internal helpers and do not count as "the window
  # opened"; a real top-level window always has one here.
  $ok = if ($ExpectWindow) { $named.Count -gt 0 } else { $named.Count -eq 0 }
  Write-Host ("    {0}" -f $(if ($ok) { 'PASS' } else { 'FAIL' })) -ForegroundColor $(if ($ok) { 'Green' } else { 'Red' })
  return $ok
}

Write-Host ''
Write-Host '  Launch-mode verification'
Write-Host '  ================================================================'

$manual = Test-LaunchMode -Label 'manual launch' -ExtraArgs @() -ExpectWindow $true
$auto = Test-LaunchMode -Label 'autostart launch' -ExtraArgs @('--autostart') -ExpectWindow $false

Write-Host ''
if ($manual -and $auto) {
  Write-Host '  Both launch modes behave as intended.' -ForegroundColor Green
  exit 0
}
Write-Host '  At least one launch mode is wrong.' -ForegroundColor Red
exit 1
