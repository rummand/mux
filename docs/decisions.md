# Decisions (2026-10-30)

**Engine: llama.cpp, one llama-server per model, upgraded to 0.8.0.** It was already what this Mac ran (Nexus's
Qwen3.6 at ~80 tok/s), it has the widest architecture coverage, same-day GGUFs from unsloth/ggml-org/bartowski, a
JSON-schema grammar that makes forced tools reliable, and since 0.8.0 serves Jev's `/v1/systemone` natively for
decision models (Laya, Clef, d3, d1, granite-switch). One process per model keeps memory accounting and failure
isolation simple. MLX (mlx-lm, or omlx as one multi-model upstream) is the second backend for models where it
benchmarks faster; Ollama adds nothing mux does not already do (pull, load, keep-alive) and hides the flags.
Colibrì was slow (tokens a second) and once swapped the Mac full; it is not used.

**Gateway: our own, in TypeScript, LiteLLM's ideas.** LiteLLM's proxy has the gateway half (virtual keys, budgets,
RPM/TPM, fallbacks, cooldowns, spend logs) and mux copies those concepts — but it does not manage local model
processes, memory, downloads, the forced-tool guard or System One, and it brings Python + Postgres. mux speaks plain
OpenAI, so LiteLLM can still stand in front (or behind, as an `external` provider for cloud fallbacks) later.
**Not Rust:** gateway overhead is measured on every request (`overhead_ms`, shown p50/p99 on the dashboard); against a
local model's 100+ ms to first token and tens of tokens a second, single milliseconds do not show. If they ever do,
a Rust gateway can front mux without changing anything behind it.

**Lens:** LiteLLM Lens's idea — investigations over traffic that end in findings with evidence — done locally: rules
for what can be counted, a local model for the rest; nothing leaves the Mac.

**Nexus cutover:** the owner chose "model servers only": com.nexus.{llm, llm-challenger, toolguard,
toolguard-challenger, embed} are stopped and their plists renamed `*.disabled-by-mux`. Their ports answer through
mux's localhost compatibility listeners, so Caddy, Tailscale Funnel, Nexus on Railway and Nexus Build changed nothing.
Speech/voice (mlx-audio :8093), Caddy, LiveKit, CI and builds are untouched.

**Memory guard:** the free-memory check uses macOS's own available figure (`memory_pressure -Q`), not free+inactive
pages, which undercount on this busy Mac (26.9 GB "free" vs 48 GB available at cutover). The prompt cache is counted
at half its ceiling.
