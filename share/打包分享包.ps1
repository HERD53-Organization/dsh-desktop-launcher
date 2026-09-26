<#
.SYNOPSIS
  Assemble the ready-to-send DSH-Launcher folder, and optionally zip it.

.DESCRIPTION
  Produces one folder the user can right-click and compress, or upload as-is:

    DSH-Launcher/
      win-unpacked/     the built launcher (must travel whole; the .exe alone
                        will not start)
      setup.bat         one-time setup for the recipient
      安装说明.md        install guide

  Two directories, two jobs — the build output and the deliverable are
  deliberately separate:

    build/          raw electron-builder output; wiped and rebuilt by
                    `npm run dist`, never edited or shipped directly
    DSH-Launcher/   the deliverable; rebuilt from build/ + share/ on every run

  Putting setup.bat into build/ instead would look simpler but breaks: `npm run
  dist` empties the electron-builder output directory, so anything placed there
  is deleted on the next build.

  No staging copy is needed any more. The earlier design copied the payload into
  a temp folder purely so all three entries could sit at the archive root, since
  7-Zip cannot map two source directories into one root on this build (no -aos
  rename rule). Assembling the deliverable folder directly removes that copy.

.EXAMPLE
  powershell -File share\打包分享包.ps1
  powershell -File share\打包分享包.ps1 -NoZip
#>
[CmdletBinding()]
param(
  [string]$BuiltDir,
  [string]$DeliverableDir,
  [switch]$NoZip,
  # Kept for compatibility: this script no longer stages anything.
  [switch]$KeepStaging
)

$ErrorActionPreference = 'Stop'

$projectRoot = Split-Path -Parent $PSScriptRoot
if ([string]::IsNullOrEmpty($BuiltDir)) { $BuiltDir = Join-Path $projectRoot 'build\win-unpacked' }
if ([string]::IsNullOrEmpty($DeliverableDir)) { $DeliverableDir = Join-Path $projectRoot 'DSH-Launcher' }

# Chinese filename composed from code points so this file stays ASCII-only.
$guideName = [string]([char]0x5B89) + [char]0x88C5 + [char]0x8BF4 + [char]0x660E + '.md'

function Write-Step($message) { Write-Host "  $message" }

Write-Host ''
Write-Host '  Assembling DSH-Launcher'
Write-Host '  ================================================================'

# --------------------------------------------------------------- preflight ---
if (-not (Test-Path (Join-Path $BuiltDir 'DSH Launcher.exe'))) {
  throw "build output not found at '$BuiltDir'. Run 'npm run dist' first."
}
Write-Step "build output : $BuiltDir"

$setupSource = Join-Path $PSScriptRoot 'setup.bat'
$guideSource = Join-Path $PSScriptRoot $guideName
foreach ($required in @($setupSource, $guideSource)) {
  if (-not (Test-Path $required)) { throw "missing required file: $required" }
}

# Guard against a mis-set -DeliverableDir wiping the wrong directory.
if ($DeliverableDir.TrimEnd('\') -eq $projectRoot.TrimEnd('\')) {
  throw 'refusing to use the project root as the deliverable directory'
}

# ------------------------------------------------------------- assemble ------
if (Test-Path $DeliverableDir) {
  Write-Step "clearing previous $(Split-Path -Leaf $DeliverableDir)"
  Remove-Item $DeliverableDir -Recurse -Force
}
New-Item -ItemType Directory -Path $DeliverableDir -Force | Out-Null

Write-Step 'copying win-unpacked (large, this takes a moment) ...'
Copy-Item $BuiltDir (Join-Path $DeliverableDir 'win-unpacked') -Recurse -Force
Copy-Item $setupSource (Join-Path $DeliverableDir 'setup.bat') -Force
Copy-Item $guideSource (Join-Path $DeliverableDir $guideName) -Force

# ----------------------------------------------------- force CRLF on .bat ----
# cmd.exe mis-parses a .bat with bare LF line endings: the REM header block is
# executed as commands. Any editor that rewrites setup.bat with LF reintroduces
# this, so the shipped copy is repaired and checked every time.
$setupTarget = Join-Path $DeliverableDir 'setup.bat'
$text = [System.IO.File]::ReadAllText($setupTarget)
$text = ($text -replace "`r`n", "`n") -replace "`n", "`r`n"
[System.IO.File]::WriteAllText($setupTarget, $text, (New-Object System.Text.UTF8Encoding($false)))

$bytes = [System.IO.File]::ReadAllBytes($setupTarget)
$loneLf = ([regex]::Matches([System.Text.Encoding]::UTF8.GetString($bytes), "(?<!`r)`n")).Count
if ($loneLf -ne 0) { throw "setup.bat still has $loneLf bare LF line ending(s); cmd.exe would mis-parse it." }
$firstCr = [Array]::IndexOf($bytes, [byte]13)
if ($firstCr -lt 0 -or $firstCr + 1 -ge $bytes.Length -or $bytes[$firstCr + 1] -ne 0x0A) {
  throw 'setup.bat does not begin with a CRLF-terminated line; refusing to ship.'
}
Write-Step ('setup.bat line endings verified as CRLF (first CR at byte {0})' -f $firstCr)

# ------------------------------------------------------------------ report ---
$sizeMb = (Get-ChildItem $DeliverableDir -Recurse -File | Measure-Object Length -Sum).Sum / 1MB
Write-Step ("deliverable  : $DeliverableDir")
Write-Step ("size         : {0:N1} MB" -f $sizeMb)

# --------------------------------------------------------------------- zip ---
if (-not $NoZip) {
  $zipPath = Join-Path $projectRoot 'DSH-Launcher.zip'
  if (Test-Path $zipPath) { Remove-Item $zipPath -Force }

  # 7-Zip is preferred: Compress-Archive chokes on this payload (hundreds of
  # files plus the locale pack set) and takes minutes when it does work.
  $sevenZip = 'C:\Program Files\7-Zip\7z.exe'
  if (Test-Path $sevenZip) {
    Write-Step 'compressing with 7-Zip ...'
    Push-Location $projectRoot
    try {
      & $sevenZip a -mx=5 -bso0 -bsp0 $zipPath (Split-Path -Leaf $DeliverableDir) | Out-Null
      if ($LASTEXITCODE -ne 0) { throw "7-Zip failed with exit code $LASTEXITCODE" }
    } finally {
      Pop-Location
    }
  } else {
    Write-Step 'compressing with Compress-Archive (slower; install 7-Zip to speed this up) ...'
    Compress-Archive -Path $DeliverableDir -DestinationPath $zipPath -CompressionLevel Optimal
  }

  # The archive must contain the deliverable folder itself, with all three
  # entries inside it - that is what setup.bat's %~dp0-relative paths assume.
  Add-Type -AssemblyName System.IO.Compression.FileSystem
  $archive = [System.IO.Compression.ZipFile]::OpenRead($zipPath)
  try {
    # 7-Zip stores entry labels with backslashes; normalize before inspecting,
    # otherwise splitting on '/' returns the whole path as the first segment.
    $entryPaths = @($archive.Entries | ForEach-Object { $_.FullName -replace '\\', '/' })
    # @() matters: PowerShell unwraps a single-element pipeline result into a
    # scalar string, making $roots[0] the first character instead of the value.
    $roots = @($entryPaths | ForEach-Object { ($_ -split '/')[0] } | Where-Object { $_ -ne '' } | Sort-Object -Unique)
    $leaf = Split-Path -Leaf $DeliverableDir
    $expected = @(
      "$leaf/win-unpacked/DSH Launcher.exe",
      "$leaf/setup.bat",
      "$leaf/$guideName"
    )
    $missing = @($expected | Where-Object { $entryPaths -notcontains $_ })
  } finally {
    $archive.Dispose()
  }
  if ($roots.Count -ne 1 -or $roots[0] -ne $leaf) {
    throw "archive root should be exactly '$leaf', got: $($roots -join ', ')"
  }
  if ($missing.Count -gt 0) {
    throw "archive is missing: $($missing -join ', ')"
  }
  Write-Step "archive verified: root '$leaf', all three entries present"
  Write-Step ("archive      : $zipPath ({0:N1} MB)" -f ((Get-Item $zipPath).Length / 1MB))
}

Write-Host ''
Write-Host '  Done. To share, either send the zip, or right-click the folder:'
Write-Host "    $DeliverableDir"
Write-Host '  Tell the recipient to:'
Write-Host '    1. extract'
Write-Host '    2. run setup.bat once (installs Node.js and dsh if missing)'
Write-Host '    3. double-click win-unpacked\DSH Launcher.exe'
Write-Host '    4. left-click its tray icon - the launcher has no window of its own'
Write-Host '  Never send anyone your own ~/.dsh/.credentials.yaml.'
Write-Host ''
