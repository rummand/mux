# Make this Windows PC a mux node and join it to a gateway. Run in an elevated PowerShell:
#
#   powershell -ExecutionPolicy Bypass -File install.ps1 -GatewayUrl https://<gateway> -GatewayToken <admin token>
#
# What it does (each step again on a re-run, so it also updates a node):
#   1. Node.js, Git and Tailscale (winget), if missing.
#   2. mux from GitHub into C:\mux, built.
#   3. llama.cpp's llama-server: the CUDA build with an NVIDIA GPU, else the Vulkan build (AMD, Intel).
#   4. C:\ProgramData\mux\mux.env: role node, an admin token, a presence token, the memory budget from the GPU's VRAM.
#   5. A Scheduled Task "mux" that runs the node at startup as SYSTEM, restarted if it stops.
#   6. A Scheduled Task "mux presence" that runs the presence helper in the session of whoever logs on.
#   7. Joins the gateway: through Tailscale Funnel (from anywhere) unless -NodeUrl says otherwise.
#
# The node starts in "away-only": it takes work only while nobody is at the PC. Change that from the gateway's
# dashboard or with -Mode available.
#
# UNTESTED: written on a Mac without a Windows machine to run it on; try it on one PC first (deploy/windows/README.md).
param(
  [Parameter(Mandatory = $true)][string]$GatewayUrl,
  [Parameter(Mandatory = $true)][string]$GatewayToken,
  [string]$Name = $env:COMPUTERNAME,
  [string]$NodeUrl = "",
  [ValidateSet("away-only", "available", "off")][string]$Mode = "away-only",
  [string]$Repo = "https://github.com/rummand/mux",
  [string]$Dir = "C:\mux",
  [int]$Port = 7070
)
$ErrorActionPreference = "Stop"
$Home_ = "$env:ProgramData\mux"
function Step($s) { Write-Host "→ $s" -ForegroundColor Cyan }

if (-not ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  throw "Run this in an elevated PowerShell (Run as administrator)."
}

# 1 ── Tools ────────────────────────────────────────────────────────────────────────────────────────────────────
Step "Node.js, Git and Tailscale"
foreach ($p in @(@{ id = "OpenJS.NodeJS.LTS"; cmd = "node" }, @{ id = "Git.Git"; cmd = "git" }, @{ id = "Tailscale.Tailscale"; cmd = "tailscale" })) {
  if (-not (Get-Command $p.cmd -ErrorAction SilentlyContinue)) { winget install --id $p.id -e --silent --accept-package-agreements --accept-source-agreements }
}
$env:Path = [Environment]::GetEnvironmentVariable("Path", "Machine") + ";" + [Environment]::GetEnvironmentVariable("Path", "User")

# 2 ── mux ──────────────────────────────────────────────────────────────────────────────────────────────────────
Step "mux in $Dir"
if (Test-Path "$Dir\.git") { git -C $Dir pull --ff-only } else { git clone $Repo $Dir }
Push-Location $Dir
npm ci --no-audit --no-fund
npm run build -w server
Pop-Location

# 3 ── llama-server ─────────────────────────────────────────────────────────────────────────────────────────────
$nvidia = [bool](Get-Command nvidia-smi -ErrorAction SilentlyContinue)
$flavour = if ($nvidia) { "cuda" } else { "vulkan" }
Step "llama.cpp ($flavour)"
$release = Invoke-RestMethod "https://api.github.com/repos/ggml-org/llama.cpp/releases/latest" -Headers @{ "User-Agent" = "mux-install" }
$assets = $release.assets | Where-Object { $_.name -match "bin-win-$flavour.*x64\.zip$" }
if ($nvidia) {
  # One CUDA version (the release has several): the oldest, which the most drivers run; its build and its runtime.
  $cuda = $assets | ForEach-Object { if ($_.name -match "cuda-(\d+\.\d+)") { [version]$matches[1] } } | Sort-Object -Unique | Select-Object -First 1
  $assets = $assets | Where-Object { $_.name -match "cuda-$([regex]::Escape($cuda.ToString()))-x64\.zip$" }
}
if (-not $assets) { throw "No llama.cpp $flavour build for Windows in release $($release.tag_name)." }
$llama = "$Dir\llama"
New-Item -ItemType Directory -Force $llama | Out-Null
foreach ($a in $assets) {  # the CUDA build comes with its runtime (cudart-…) as a second zip
  $zip = "$env:TEMP\$($a.name)"
  Invoke-WebRequest $a.browser_download_url -OutFile $zip
  Expand-Archive $zip -DestinationPath $llama -Force
}
$server = Get-ChildItem $llama -Recurse -Filter llama-server.exe | Select-Object -First 1
if (-not $server) { throw "llama-server.exe was not in the llama.cpp download." }

# 4 ── Settings ─────────────────────────────────────────────────────────────────────────────────────────────────
Step "settings in $Home_"
New-Item -ItemType Directory -Force $Home_ | Out-Null
$vramGb = 0
if ($nvidia) {
  $vramGb = [math]::Floor(((nvidia-smi --query-gpu=memory.total --format=csv,noheader,nounits | Select-Object -First 1) -as [double]) / 1024)
} else {
  # AMD and Intel: the adapter's dedicated memory, from the display adapters' registry keys (64-bit value).
  $keys = Get-ChildItem "HKLM:\SYSTEM\ControlSet001\Control\Class\{4d36e968-e325-11ce-bfc1-08002be10318}" -ErrorAction SilentlyContinue
  foreach ($k in $keys) { $v = (Get-ItemProperty $k.PSPath -Name "HardwareInformation.qwMemorySize" -ErrorAction SilentlyContinue)."HardwareInformation.qwMemorySize"; if ($v) { $vramGb = [math]::Max($vramGb, [math]::Floor($v / 1GB)) } }
}
$ramGb = [math]::Floor((Get-CimInstance Win32_ComputerSystem).TotalPhysicalMemory / 1GB)
# Models live in VRAM when there is a GPU with room; else in RAM, leaving half of it for the person at the PC.
$budget = if ($vramGb -ge 6) { [math]::Floor($vramGb * 0.85) } else { [math]::Floor($ramGb / 2) }
$envFile = "$Home_\mux.env"
$old = @{}
if (Test-Path $envFile) { Get-Content $envFile | ForEach-Object { if ($_ -match "^([A-Z_]+)=(.*)$") { $old[$matches[1]] = $matches[2] } } }
$token = if ($old.MUX_ADMIN_TOKEN) { $old.MUX_ADMIN_TOKEN } else { -join ((1..48) | ForEach-Object { "{0:x}" -f (Get-Random -Max 16) }) }
$presence = if ($old.MUX_PRESENCE_TOKEN) { $old.MUX_PRESENCE_TOKEN } else { -join ((1..48) | ForEach-Object { "{0:x}" -f (Get-Random -Max 16) }) }
@"
MUX_ROLE=node
MUX_NAME=$Name
MUX_PORT=$Port
MUX_HOME=$Home_
MUX_ADMIN_TOKEN=$token
MUX_PRESENCE_TOKEN=$presence
MUX_PRESENCE_MODE=$Mode
MUX_LLAMA_SERVER=$($server.FullName)
MUX_MEMORY_BUDGET_GB=$budget
"@ | Set-Content -Encoding ascii $envFile
# Only administrators and SYSTEM read the admin token.
icacls $envFile /inheritance:r /grant:r "SYSTEM:F" "Administrators:F" | Out-Null
# Everyone on the PC may read the presence token: it can only report presence.
Set-Content -Encoding ascii "$Home_\presence.token" $presence
icacls "$Home_\presence.token" /inheritance:r /grant:r "SYSTEM:F" "Administrators:F" "Users:R" | Out-Null
Write-Host "  GPU: $(if ($vramGb) { "$vramGb GB VRAM" } else { 'none found' }), RAM $ramGb GB → model memory budget $budget GB"

# 5 ── The node, at startup ─────────────────────────────────────────────────────────────────────────────────────
Step "Scheduled Task: mux"
$run = "$Home_\run.cmd"
@"
@echo off
for /f "usebackq tokens=1,* delims==" %%a in ("$envFile") do set "%%a=%%b"
cd /d "$Dir\server"
node dist\index.js >> "$Home_\mux.log" 2>&1
"@ | Set-Content -Encoding ascii $run
$action = New-ScheduledTaskAction -Execute "cmd.exe" -Argument "/c `"$run`""
$settings = New-ScheduledTaskSettingsSet -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
Register-ScheduledTask -TaskName "mux" -Action $action -Trigger (New-ScheduledTaskTrigger -AtStartup) -Settings $settings -User "SYSTEM" -RunLevel Highest -Force | Out-Null
Stop-ScheduledTask -TaskName "mux" -ErrorAction SilentlyContinue
Start-ScheduledTask -TaskName "mux"

# 6 ── The presence helper, in the session of whoever logs on ───────────────────────────────────────────────────
Step "Scheduled Task: mux presence"
Copy-Item "$Dir\deploy\windows\presence-helper.ps1" "$Home_\presence-helper.ps1" -Force
$helper = New-ScheduledTaskAction -Execute "powershell.exe" -Argument "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$Home_\presence-helper.ps1`" -Node http://127.0.0.1:$Port"
$users = New-ScheduledTaskPrincipal -GroupId "S-1-5-32-545" -RunLevel Limited  # BUILTIN\Users, in their own session
Register-ScheduledTask -TaskName "mux presence" -Action $helper -Trigger (New-ScheduledTaskTrigger -AtLogOn) -Principal $users -Settings $settings -Force | Out-Null
Start-ScheduledTask -TaskName "mux presence" -ErrorAction SilentlyContinue

# 7 ── Join the gateway ─────────────────────────────────────────────────────────────────────────────────────────
Step "waiting for the node"
$local = "http://127.0.0.1:$Port"
for ($i = 0; $i -lt 60; $i++) { try { Invoke-RestMethod "$local/health" -TimeoutSec 2 | Out-Null; break } catch { Start-Sleep 2 } }
if (-not $NodeUrl) {
  # From anywhere, as the Mac Studio joins: Tailscale Funnel at /mux (log in to Tailscale first if this fails).
  $dns = ((tailscale status --json | ConvertFrom-Json).Self.DNSName).TrimEnd(".")
  if (-not $dns) { throw "Tailscale is not logged in: run 'tailscale up', then this script again (or pass -NodeUrl)." }
  tailscale funnel --bg --https=443 --set-path=/mux "http://127.0.0.1:$Port" | Out-Null
  $NodeUrl = "https://$dns/mux"
} else {
  New-NetFirewallRule -DisplayName "mux $Port" -Direction Inbound -Protocol TCP -LocalPort $Port -Action Allow -Profile Private -ErrorAction SilentlyContinue | Out-Null
}
Step "joining $GatewayUrl as $Name ($NodeUrl)"
$body = @{ gatewayUrl = $GatewayUrl; gatewayToken = $GatewayToken; nodeUrl = $NodeUrl; name = $Name } | ConvertTo-Json
$r = Invoke-RestMethod -Method Post -Uri "$local/api/admin/join" -Headers @{ authorization = "Bearer $token" } -ContentType "application/json" -Body $body -TimeoutSec 60
if ($r.ok) { Write-Host "✓ $Name joined as $($r.provider.id): online, $($r.provider.latencyMs) ms" -ForegroundColor Green }
else { Write-Host "✗ joined, but the gateway says $($r.provider.status): $($r.provider.error)" -ForegroundColor Yellow }
Write-Host "  It takes work: $Mode. Node log: $Home_\mux.log"
