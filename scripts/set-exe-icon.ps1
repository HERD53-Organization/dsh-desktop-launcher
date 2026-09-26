<#
.SYNOPSIS
  Embed an icon into a built launcher executable.

.DESCRIPTION
  electron-builder normally does this through rcedit, which it extracts from the
  `winCodeSign` archive. That archive also contains macOS .dylib symlinks, and
  7-Zip cannot create symlinks without Administrator or Developer Mode, so the
  whole extraction fails and BOTH code signing and icon embedding are lost. The
  build therefore sets `win.signAndEditExecutable: false` to avoid the download,
  and this script restores the icon afterwards through the Win32 resource API.

  It only touches the RT_GROUP_ICON / RT_ICON resources, leaves every other
  resource (version info, manifest) intact, and does not sign anything.

  Grouping is derived per Windows convention: entries of exactly 16/32/48/256
  px form the "small" group, everything else forms the "large" one. That is why
  the generated .ico must contain all of those sizes.

.EXAMPLE
  powershell -File scripts\set-exe-icon.ps1 -Executable "build\win-unpacked\DSH Launcher.exe"
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$Executable,
  [string]$Icon
)

$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
if ([string]::IsNullOrEmpty($Icon)) { $Icon = Join-Path $projectRoot 'assets\icon.ico' }

if (-not (Test-Path $Executable)) { throw "executable not found: $Executable" }
if (-not (Test-Path $Icon)) { throw "icon not found: $Icon" }

$exePath = (Resolve-Path $Executable).Path
$icoPath = (Resolve-Path $Icon).Path
$expectedSize = (Get-Item $icoPath).Length

Write-Host "  target : $exePath"
Write-Host "  icon   : $icoPath ($expectedSize bytes)"

# --------------------------------------------------------- PE sanity check ---
$pe = [System.IO.File]::ReadAllBytes($exePath)
if ($pe.Length -lt 0x40 -or $pe[0] -ne 0x4D -or $pe[1] -ne 0x5A) {
  throw 'target does not start with an MZ header; refusing to touch it'
}
$peOffset = [BitConverter]::ToInt32($pe, 0x3C)
if ($peOffset -le 0 -or $peOffset + 4 -ge $pe.Length) { throw 'PE header offset is out of range' }
if ([BitConverter]::ToUInt32($pe, $peOffset) -ne 0x00004550) {
  throw 'target has no PE\0\0 signature; refusing to touch it'
}

# ---------------------------------------------------------------- P/Invoke ---
Add-Type -Namespace DshLauncher -Name IconResources -MemberDefinition @'
[DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
public static extern IntPtr BeginUpdateResource(string pFileName, bool bDeleteExistingResources);

[DllImport("kernel32.dll", SetLastError = true)]
public static extern bool UpdateResource(IntPtr hUpdate, IntPtr lpType, IntPtr lpName, ushort wLanguage, byte[] lpData, uint cbData);

[DllImport("kernel32.dll", SetLastError = true)]
public static extern bool EndUpdateResource(IntPtr hUpdate, bool fDiscard);

[DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
public static extern IntPtr LoadLibraryEx(string lpFileName, IntPtr hFile, uint dwFlags);

[DllImport("kernel32.dll", SetLastError = true)]
public static extern bool EnumResourceNames(IntPtr hModule, IntPtr lpType, EnumResNameProc lpEnumFunc, IntPtr lParam);

public delegate bool EnumResNameProc(IntPtr hModule, IntPtr lpType, IntPtr lpName, IntPtr lParam);
'@

$RT_ICON = [IntPtr]3
$RT_GROUP_ICON = [IntPtr]14
# [uint16] rather than [ushort]: Windows PowerShell 5.1 fails to resolve the
# [ushort] alias inside a method-argument cast, though they are the same type.
$LANG_NEUTRAL = [uint16]0

# ------------------------------------------------------------- parse .ico ---
$ico = [System.IO.File]::ReadAllBytes($icoPath)
if ([BitConverter]::ToUInt16($ico, 0) -ne 0 -or [BitConverter]::ToUInt16($ico, 2) -ne 1) {
  throw 'not an .ico container'
}
$count = [BitConverter]::ToUInt16($ico, 4)
if ($count -eq 0 -or $count -gt 64) { throw "unexpected image count: $count" }

$images = @()
for ($i = 0; $i -lt $count; $i++) {
  $at = 6 + ($i * 16)
  $width = $ico[$at]; if ($width -eq 0) { $width = 256 }
  $height = $ico[$at + 1]; if ($height -eq 0) { $height = 256 }
  $length = [BitConverter]::ToUInt32($ico, $at + 8)
  $offset = [BitConverter]::ToUInt32($ico, $at + 12)
  if ($offset + $length -gt $ico.Length) { throw "image $i is out of bounds" }
  $images += [pscustomobject]@{
    Width = $width; Height = $height; Bytes = $ico[$offset..($offset + $length - 1)]
  }
}
Write-Host "  images : $(($images | ForEach-Object { "$($_.Width)x$($_.Height)" }) -join ', ')"

# Windows groups icons by intent. rt_smallicon carries 16/32/48/256; everything
# else belongs to the primary group.
$smallSizes = @(16, 32, 48, 256)
$small = @($images | Where-Object { $smallSizes -contains $_.Width })
$large = @($images | Where-Object { $smallSizes -notcontains $_.Width })
if ($small.Count -eq 0) { $small = $large }
if ($large.Count -eq 0) { $large = $small }

function Build-Group([object[]]$members) {
  $header = New-Object byte[] 6
  [BitConverter]::GetBytes([uint16]0).CopyTo($header, 0)
  [BitConverter]::GetBytes([uint16]1).CopyTo($header, 2)  # type: icon
  [BitConverter]::GetBytes([uint16]$members.Count).CopyTo($header, 4)

  $body = New-Object byte[] (14 * $members.Count)
  for ($i = 0; $i -lt $members.Count; $i++) {
    $m = $members[$i]
    $at = $i * 14
    $body[$at + 0] = if ($m.Width -ge 256) { 0 } else { [byte]$m.Width }
    $body[$at + 1] = if ($m.Height -ge 256) { 0 } else { [byte]$m.Height }
    $body[$at + 2] = 0
    $body[$at + 3] = 0
    [BitConverter]::GetBytes([uint16]1).CopyTo($body, $at + 4)              # planes
    [BitConverter]::GetBytes([uint16]32).CopyTo($body, $at + 6)             # bit count
    [BitConverter]::GetBytes([uint32]$m.Bytes.Length).CopyTo($body, $at + 8)
    # Each member points at its own RT_ICON, carried on the parsed image.
    [BitConverter]::GetBytes([uint16]$m.Id).CopyTo($body, $at + 12)
  }
  return $header + $body
}

# --------------------------------------------------------------- apply ------
$handle = [DshLauncher.IconResources]::BeginUpdateResource($exePath, $false)
if ($handle -eq [IntPtr]::Zero) {
  throw "BeginUpdateResource failed (error $([Runtime.InteropServices.Marshal]::GetLastWin32Error()))"
}

$ok = $true
try {
  # Work in a FRESH id range instead of reusing ids 1..n.
  #
  # Two approaches were tried and rejected before this one:
  #
  #   * Plain write to ids 1..n. UpdateResource only overwrites by id and never
  #     prunes, so a second run leaves stale RT_ICONs behind and members start
  #     resolving to the wrong payload.
  #   * Delete every icon resource, then write. Deleting inside the same update
  #     handle leaves the group structures pointing at removed members, and the
  #     following write did not land - the file ended up with groups whose
  #     members read back as garbage.
  #
  # Allocating ids above the highest existing one avoids both: nothing stale is
  # reused, and no deletion is needed for the bitmaps. Only the two group ids are
  # overwritten, which is safe because their count is fixed.
  $highest = 0
  $existing = [DshLauncher.IconResources]::LoadLibraryEx($exePath, [IntPtr]::Zero, 0x00000002)
  if ($existing -ne [IntPtr]::Zero) {
    foreach ($type in @($RT_ICON, $RT_GROUP_ICON)) {
      $callback = [DshLauncher.IconResources+EnumResNameProc]{
        param($m, $t, $name, $param)
        $value = [int64]$name
        # Ordinal ids arrive as a small pointer value; names would be pointers.
        if ($value -lt 0x10000 -and $value -gt $script:highest) { $script:highest = [int]$value }
        return $true
      }
      [void][DshLauncher.IconResources]::EnumResourceNames($existing, $type, $callback, [IntPtr]::Zero)
    }
  }
  $firstId = $highest + 1
  if ($firstId -lt 1) { $firstId = 1 }

  $nextId = $firstId
  foreach ($m in $images) {
    if (-not [DshLauncher.IconResources]::UpdateResource($handle, $RT_ICON, [IntPtr]$nextId, $LANG_NEUTRAL, $m.Bytes, [uint32]$m.Bytes.Length)) {
      throw "UpdateResource(RT_ICON, $nextId) failed (error $([Runtime.InteropServices.Marshal]::GetLastWin32Error()))"
    }
    $m | Add-Member -NotePropertyName Id -NotePropertyValue $nextId -Force
    $nextId++
  }

  $largeGroup = Build-Group $large
  if (-not [DshLauncher.IconResources]::UpdateResource($handle, $RT_GROUP_ICON, [IntPtr]1, $LANG_NEUTRAL, $largeGroup, [uint32]$largeGroup.Length)) {
    throw "UpdateResource(RT_GROUP_ICON, 1) failed (error $([Runtime.InteropServices.Marshal]::GetLastWin32Error()))"
  }
  $smallGroup = Build-Group $small
  if (-not [DshLauncher.IconResources]::UpdateResource($handle, $RT_GROUP_ICON, [IntPtr]2, $LANG_NEUTRAL, $smallGroup, [uint32]$smallGroup.Length)) {
    throw "UpdateResource(RT_GROUP_ICON, 2) failed (error $([Runtime.InteropServices.Marshal]::GetLastWin32Error()))"
  }
} catch {
  $ok = $false
  $message = $_.Exception.Message
} finally {
  # Commit only when every write succeeded, so a partial replacement never lands.
  [void][DshLauncher.IconResources]::EndUpdateResource($handle, (-not $ok))
}

if (-not $ok) { throw $message }

# ---------------------------------------------------------------- verify ----
# Read the resources back out and compare them against the source .ico. A size
# check alone proves nothing: a PE rewrite can succeed in structure while the
# icon never lands.
Add-Type -Namespace DshLauncher -Name IconReader -MemberDefinition @'
[DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
public static extern IntPtr LoadLibraryEx(string lpFileName, IntPtr hFile, uint dwFlags);

[DllImport("kernel32.dll", SetLastError = true)]
public static extern IntPtr FindResource(IntPtr hModule, IntPtr lpName, IntPtr lpType);

[DllImport("kernel32.dll", SetLastError = true)]
public static extern IntPtr LoadResource(IntPtr hModule, IntPtr hResInfo);

[DllImport("kernel32.dll", SetLastError = true)]
public static extern IntPtr LockResource(IntPtr hResData);

[DllImport("kernel32.dll", SetLastError = true)]
public static extern uint SizeofResource(IntPtr hModule, IntPtr hResInfo);
'@

$LOAD_LIBRARY_AS_DATAFILE = [uint32]0x00000002
$module = [DshLauncher.IconReader]::LoadLibraryEx($exePath, [IntPtr]::Zero, $LOAD_LIBRARY_AS_DATAFILE)
if ($module -eq [IntPtr]::Zero) {
  throw "could not load the rewritten executable for verification (error $([Runtime.InteropServices.Marshal]::GetLastWin32Error()))"
}

# Verify EVERY group, and verify that each member's id resolves to a bitmap of
# the declared size. Checking only that sizes appear in the directory is not
# enough: with a shared id range the directory looks perfect while every member
# points at the wrong payload, and Windows silently falls back to the previous
# icon.
function Read-ResourceBytes([IntPtr]$Module, [IntPtr]$Name, [IntPtr]$Type) {
  $info = [DshLauncher.IconReader]::FindResource($Module, $Name, $Type)
  if ($info -eq [IntPtr]::Zero) { return $null }
  $length = [DshLauncher.IconReader]::SizeofResource($Module, $info)
  $loaded = [DshLauncher.IconReader]::LoadResource($Module, $info)
  $locked = [DshLauncher.IconReader]::LockResource($loaded)
  if ($locked -eq [IntPtr]::Zero -or $length -eq 0) { return $null }
  $buffer = New-Object byte[] $length
  [Runtime.InteropServices.Marshal]::Copy($locked, $buffer, 0, [int]$length)
  return ,$buffer
}

$readBack = @{}
foreach ($groupId in 1, 2) {
  $groupBytes = Read-ResourceBytes $module ([IntPtr]$groupId) $RT_GROUP_ICON
  if ($null -eq $groupBytes) { throw "verification failed: RT_GROUP_ICON $groupId is missing after the write" }
  $entries = [BitConverter]::ToUInt16($groupBytes, 4)
  for ($i = 0; $i -lt $entries; $i++) {
    $at = 6 + ($i * 14)
    $w = $groupBytes[$at]; if ($w -eq 0) { $w = 256 }
    $declared = [BitConverter]::ToUInt32($groupBytes, $at + 8)
    $memberId = [BitConverter]::ToUInt16($groupBytes, $at + 12)

    $payload = Read-ResourceBytes $module ([IntPtr]$memberId) $RT_ICON
    if ($null -eq $payload) {
      throw "verification failed: group $groupId member $memberId ($($w)x$($w)) has no RT_ICON payload"
    }
    if ($payload.Length -ne $declared) {
      throw "verification failed: group $groupId member $memberId declares $declared bytes but RT_ICON $memberId holds $($payload.Length) - the group and bitmap ids are out of step"
    }
    $readBack[$w] = $memberId
  }
}

$missing = @($images | Where-Object { -not $readBack.ContainsKey($_.Width) })
if ($missing.Count -gt 0) {
  throw "verification failed: sizes $(($missing | ForEach-Object { $_.Width }) -join ', ') are absent from the exe"
}

Write-Host "  verified: $(($readBack.Keys | Sort-Object -Descending | ForEach-Object { "${_}px->id$($readBack[$_])" }) -join ', ')" -ForegroundColor Green
