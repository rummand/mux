# mux presence helper for Windows: runs in the session of the person at the PC (a Scheduled Task at logon) and tells
# the mux node on this PC, every 5 s, whether someone is there and what they are doing — the node's service runs in
# Session 0 and cannot see that itself. It reports with the presence token, which may only report presence.
#
# What it reads:
#   idle time         GetLastInputInfo (keyboard and mouse)
#   fullscreen, game  SHQueryUserNotificationState (a fullscreen app, a Direct3D game, presentation mode)
#   a call            the microphone in use by any app (Windows' privacy "consent store")
#   battery           Win32_Battery
#
# UNTESTED: written on a Mac; check it on the first PC (see deploy/windows/README.md).
param(
  [string]$Node = "http://127.0.0.1:7070",
  [string]$TokenFile = "$env:ProgramData\mux\presence.token",
  [int]$Every = 5
)
$ErrorActionPreference = "SilentlyContinue"

Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public static class MuxPresence {
  [StructLayout(LayoutKind.Sequential)] struct LASTINPUTINFO { public uint cbSize; public uint dwTime; }
  [DllImport("user32.dll")] static extern bool GetLastInputInfo(ref LASTINPUTINFO plii);
  [DllImport("shell32.dll")] static extern int SHQueryUserNotificationState(out int state);
  public static double IdleSeconds() {
    var i = new LASTINPUTINFO(); i.cbSize = (uint)Marshal.SizeOf(i);
    if (!GetLastInputInfo(ref i)) return -1;
    return ((uint)Environment.TickCount - i.dwTime) / 1000.0;
  }
  // 2 busy (a fullscreen app), 3 a Direct3D fullscreen app (a game), 4 presentation mode; 5 normal.
  public static int NotificationState() { int s; return SHQueryUserNotificationState(out s) == 0 ? s : 0; }
}
"@

function MicrophoneInUse {
  # An app with the microphone open has LastUsedTimeStop = 0 under the consent store.
  $roots = @("HKCU:\Software\Microsoft\Windows\CurrentVersion\CapabilityAccessManager\ConsentStore\microphone",
             "HKCU:\Software\Microsoft\Windows\CurrentVersion\CapabilityAccessManager\ConsentStore\microphone\NonPackaged")
  foreach ($root in $roots) {
    foreach ($k in (Get-ChildItem $root -ErrorAction SilentlyContinue)) {
      $stop = (Get-ItemProperty $k.PSPath -Name LastUsedTimeStop -ErrorAction SilentlyContinue).LastUsedTimeStop
      if ($stop -eq 0) { return $true }
    }
  }
  return $false
}

while ($true) {
  try {
    $token = (Get-Content $TokenFile -Raw).Trim()
    $idle = [MuxPresence]::IdleSeconds()
    $n = [MuxPresence]::NotificationState()
    $battery = Get-CimInstance Win32_Battery | Select-Object -First 1
    $body = @{
      idleS = if ($idle -ge 0) { $idle } else { $null }
      fullscreen = ($n -eq 2 -or $n -eq 4)
      game = ($n -eq 3)
      call = (MicrophoneInUse)
      onBattery = if ($battery) { $battery.BatteryStatus -eq 1 } else { $false }
      batteryPct = if ($battery) { [double]$battery.EstimatedChargeRemaining } else { $null }
    } | ConvertTo-Json -Compress
    Invoke-RestMethod -Method Post -Uri "$Node/api/admin/presence/signals" -Headers @{ authorization = "Bearer $token" } -ContentType "application/json" -Body $body -TimeoutSec 4 | Out-Null
  } catch { }
  Start-Sleep -Seconds $Every
}
