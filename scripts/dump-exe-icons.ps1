<#
.SYNOPSIS
  Read every icon resource back out of an executable and dump it as a PNG.

.DESCRIPTION
  Diagnostic for "the .exe still shows the wrong icon". It walks the
  RT_GROUP_ICON resources, resolves each member to its RT_ICON bitmap, and
  reports what is actually stored - group ids, member ids, and sizes. With
  -OutFile it writes the largest member as a PNG so the artwork can be viewed.

  Checking this rather than trusting the writer is the point: an icon update can
  succeed as a resource write yet still be ignored by the shell if the group
  structures are malformed or two groups share member ids.
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$Executable,
  [string]$OutFile
)

$ErrorActionPreference = 'Stop'
if (-not (Test-Path $Executable)) { throw "not found: $Executable" }
$exePath = (Resolve-Path $Executable).Path

Add-Type -Namespace IconDump -Name Native -MemberDefinition @'
[DllImport("kernel32.dll", SetLastError=true, CharSet=CharSet.Unicode)]
public static extern IntPtr LoadLibraryEx(string f, IntPtr h, uint flags);
[DllImport("kernel32.dll", SetLastError=true)]
public static extern IntPtr FindResource(IntPtr m, IntPtr name, IntPtr type);
[DllImport("kernel32.dll", SetLastError=true)]
public static extern IntPtr LoadResource(IntPtr m, IntPtr info);
[DllImport("kernel32.dll", SetLastError=true)]
public static extern IntPtr LockResource(IntPtr d);
[DllImport("kernel32.dll", SetLastError=true)]
public static extern uint SizeofResource(IntPtr m, IntPtr info);
[DllImport("kernel32.dll", SetLastError=true)]
public static extern bool EnumResourceNames(IntPtr m, IntPtr type, EnumResNameProc cb, IntPtr param);
public delegate bool EnumResNameProc(IntPtr m, IntPtr type, IntPtr name, IntPtr param);
'@

function Read-Resource([IntPtr]$Module, [IntPtr]$Name, [IntPtr]$Type) {
  $info = [IconDump.Native]::FindResource($Module, $Name, $Type)
  if ($info -eq [IntPtr]::Zero) { return $null }
  $size = [IconDump.Native]::SizeofResource($Module, $info)
  $handle = [IconDump.Native]::LoadResource($Module, $info)
  $pointer = [IconDump.Native]::LockResource($handle)
  if ($pointer -eq [IntPtr]::Zero -or $size -eq 0) { return $null }
  $bytes = New-Object byte[] $size
  [Runtime.InteropServices.Marshal]::Copy($pointer, $bytes, 0, [int]$size)
  return ,$bytes
}

$module = [IconDump.Native]::LoadLibraryEx($exePath, [IntPtr]::Zero, 0x00000002)
if ($module -eq [IntPtr]::Zero) { throw "could not load $exePath as a data file" }

$RT_ICON = [IntPtr]3
$RT_GROUP_ICON = [IntPtr]14

# Collect every RT_GROUP_ICON id by enumeration rather than assuming 1 and 2.
$groupIds = New-Object System.Collections.Generic.List[int]
$callback = [IconDump.Native+EnumResNameProc]{
  param($m, $type, $name, $param)
  # Ordinal ids arrive as a small pointer value.
  $value = [int64]$name
  if ($value -lt 0x10000) { $groupIds.Add([int]$value) }
  return $true
}
[void][IconDump.Native]::EnumResourceNames($module, $RT_GROUP_ICON, $callback, [IntPtr]::Zero)

if ($groupIds.Count -eq 0) {
  Write-Host '  no RT_GROUP_ICON resources found' -ForegroundColor Red
  exit 1
}
Write-Host ("  RT_GROUP_ICON ids: " + (($groupIds | Sort-Object) -join ', '))

$largestBytes = $null
$largestSize = 0

foreach ($groupId in ($groupIds | Sort-Object)) {
  $group = Read-Resource $module ([IntPtr]$groupId) $RT_GROUP_ICON
  if ($null -eq $group) { Write-Host "  group $groupId : unreadable"; continue }
  $members = [BitConverter]::ToUInt16($group, 4)
  Write-Host ("  group {0}: {1} member(s)" -f $groupId, $members)
  for ($i = 0; $i -lt $members; $i++) {
    $at = 6 + $i * 14
    $w = $group[$at]; if ($w -eq 0) { $w = 256 }
    $h = $group[$at + 1]; if ($h -eq 0) { $h = 256 }
    $bytesInResource = [BitConverter]::ToUInt32($group, $at + 8)
    $memberId = [BitConverter]::ToUInt16($group, $at + 12)

    $payload = Read-Resource $module ([IntPtr]$memberId) $RT_ICON
    $actual = if ($null -eq $payload) { 'MISSING' } else { "$($payload.Length) bytes" }
    $verdict = if ($null -eq $payload) { 'BROKEN' }
      elseif ($payload.Length -ne $bytesInResource) { 'SIZE MISMATCH' }
      else { 'ok' }
    Write-Host ("      {0,3}x{0,-3} memberId={1,-3} declared={2,-6} actual={3,-12} {4}" -f $w, $memberId, $bytesInResource, $actual, $verdict)

    if ($null -ne $payload -and $w -gt $largestSize) {
      $largestSize = $w
      $largestBytes = $payload
    }
  }
}

if ($OutFile -and $null -ne $largestBytes) {
  # RT_ICON payloads are already PNG when created from a PNG-compressed .ico.
  [System.IO.File]::WriteAllBytes($OutFile, $largestBytes)
  Write-Host ("  wrote largest member ({0}x{0}) to {1}" -f $largestSize, $OutFile)
}
