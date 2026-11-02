# mux on a Windows PC

`install.ps1` makes a Windows PC a mux node and joins it to the gateway; `presence-helper.ps1` tells the node whether
someone is at the PC, so it never slows them down.

> **Untested.** These were written on a Mac with no Windows machine to run them on. Run them on one PC first and watch
> each step; expect to fix small things (a winget id, a llama.cpp asset name, a Scheduled Task setting).

## Install

In an elevated PowerShell on the PC:

```powershell
git clone https://github.com/rummand/mux C:\mux   # or download install.ps1 alone
powershell -ExecutionPolicy Bypass -File C:\mux\deploy\windows\install.ps1 `
  -GatewayUrl https://<your gateway> -GatewayToken <gateway admin token>
```

Log in to Tailscale first (`tailscale up`) unless you pass `-NodeUrl http://<pc>.local:7070` for a gateway in the
house. Options: `-Name`, `-Mode away-only|available|off` (default away-only), `-Port`.

## What runs

| Piece | Where | As |
|---|---|---|
| mux node (`MUX_ROLE=node`) | Scheduled Task `mux`, at startup | SYSTEM, restarted if it stops |
| llama-server | `C:\mux\llama` — CUDA with NVIDIA, else Vulkan | started by mux per model |
| presence helper | Scheduled Task `mux presence`, at logon | the person at the PC |
| settings, database, log | `C:\ProgramData\mux` (`mux.env` readable by administrators only) | |

The memory budget is 85% of the GPU's VRAM (6 GB or more), else half the RAM.

## Presence

Every 5 s the helper reports idle time, a fullscreen app or game, the microphone in use (a call) and the battery. The
node turns that into its state — **free** (nobody there for 10 min), **polite** (someone there: only loaded models,
one at a time), **busy** (fullscreen, a game or a call: nothing new, idle models unloaded after a minute), **away**
(turned off, or a battery under 20%) — and the gateway routes by it. With nobody logged in there is no helper, and the
PC counts as free.

The helper reports with a presence token (`C:\ProgramData\mux\presence.token`), which may only report presence; the
admin token stays with administrators.

## Checks on the first PC

1. `Get-ScheduledTask mux, "mux presence"` — both Ready/Running; `C:\ProgramData\mux\mux.log` shows "node … listening".
2. From the PC: `Invoke-RestMethod http://127.0.0.1:7070/api/admin/presence -Headers @{authorization="Bearer <admin token>"}` —
   `signals.source` is `helper`, `idleS` grows while you leave the mouse alone, `fullscreen` is true in a fullscreen video.
3. On the gateway's dashboard (Providers), or in the menu bar app connected to the gateway: the PC is online, with its state.
4. Load a small model on it from the gateway (Models, pick the PC at the top) and send a request with someone at the PC
   (polite) and without (free).
