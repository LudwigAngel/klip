# Klip window helper: real on-screen bounds of top-level windows.
#   windows.ps1 -Handles 123,456   -> JSON { "123": { x, y, width, height, minimized } }
param([string]$Handles = '')
$ErrorActionPreference = 'Stop'
Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class KlipWin {
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
  [DllImport("dwmapi.dll")] public static extern int DwmGetWindowAttribute(IntPtr h, int attr, out RECT r, int size);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
}
"@
$out = @{}
foreach ($h in $Handles.Split(',')) {
  if (-not $h) { continue }
  $p = [IntPtr][Int64]$h
  $r = New-Object KlipWin+RECT
  # DWMWA_EXTENDED_FRAME_BOUNDS (9) excludes the invisible resize borders.
  if ([KlipWin]::DwmGetWindowAttribute($p, 9, [ref]$r, 16) -ne 0) { [void][KlipWin]::GetWindowRect($p, [ref]$r) }
  $out[$h] = @{ x = $r.L; y = $r.T; width = $r.R - $r.L; height = $r.B - $r.T; minimized = [KlipWin]::IsIconic($p) }
}
ConvertTo-Json -Compress -InputObject $out
