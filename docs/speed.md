# Speed and context on the Mac Studio

Measured 2026-11-24/25 (owner: *"How do we get to a point where we have hundred tokens a second… And also the context
windows"*). The Mac: M3 Ultra, 60-core GPU, 96 GB, ~819 GB/s memory bandwidth.

## Where the time goes

- **The runtime is not the limit.** Run alone, qwen3.6-35B-A3B (Q4_K_M) generates at **92 tok/s**, the same on Homebrew
  llama.cpp 0.8.0 and nightly b12678. Published MLX numbers on this chip are about the same (~95 at 8K), and MLX
  reportedly halves past 16K, where llama.cpp held 77 at 32K. Switching qwen3.6 to MLX would not help.
- **Two requests share the GPU.** 71% of qwen3.6's requests ran while another request on it was running (2 slots;
  OpenCode and Orca send two at once). Those got 63–65 tok/s; requests alone under 16K got 76.
- **Long context is slower:** 92 → 78 (8K) → 77 (32K) → 68 (64K) tok/s. Reading a prompt slows from ~1,900 to 746
  tok/s at 131K, so a cold 165K prompt takes ~4 min before the first token.

## Speculative decoding (output unchanged: byte-identical at temperature 0)

qwen3.6, same prompts, tok/s, prose / rewriting a 120-line file:

| | prose | code edit |
|---|---|---|
| none | 89–92 | 66–89 |
| `--spec-type ngram-simple --spec-draft-n-max 16` (copies text already in the context) | 90 | 285 (2 slots, both busy: 180 each) |
| MTP (`unsloth/Qwen3.6-35B-A3B-MTP-GGUF`, `--spec-type draft-mtp --spec-draft-n-max 3`) | 109–114 | 151–167 |
| MTP + ngram | **109** | **345** |

- ngram works on Homebrew 0.8.0 with 2 slots and needs no new weights. It is **on** (2026-11-25) for qwen3.6,
  Qwen3-Coder-Next, AREX-2 and Inkling. In production: qwen3.6 code edit 281 tok/s, AREX-2 25 → 106.
- MTP needs the MTP GGUF (downloaded: `~/.mux/models/unsloth--Qwen3.6-35B-A3B-MTP-GGUF`, 22.7 GB). It was measured
  only with 1 slot on the nightly, so it is not in production yet.
- `ngram-mod` and MTP "crashes" were mux's healer stopping test servers on a port inside mux's range (8200–8299).
  Test on a port outside it.
- Inkling 2 Mini: ngram took edits from 22 to 33 tok/s; it reasons a lot, and reasoning has nothing to copy.
  Qwen3.8-27B: 23 → 36 prose, 100 code edits with MTP + ngram (`docs/qwen3.8.md`).

## Context (2026-11-25)

KV memory is small for these hybrid models, because only a quarter of their layers keep a growing cache. qwen3.6
measured 24.5 GB at 131K, 26.4 GB at 262K, and 32.4 GB at 524K with YaRN (not used: it can hurt short prompts).

| model | before (per request) | now | memGb |
|---|---|---|---|
| qwen3.6-35b-a3b | 131K shared | **262K shared** | 33 |
| qwen3-coder-next | 131K split in 2 = 65K | **262K shared** | 52 |
| baai-arex-2-q4-k-m | 32K split in 2 = 16K | **131K shared** | 30 (28.8 measured) |
| inkling-2-mini | 131K split in 2 = 65K | 131K shared | (estimate) |

Last week's context failures: AREX-2 199 (mux's `assistant` tenant, 25–35K prompts), Qwen3-Coder-Next 12 (OpenCode
~86K), qwen3.6 18 (OpenCode ~132K). Checked: a 165K prompt on qwen3.6 and a 35K prompt on AREX-2 answered correctly.
OpenCode's limits for `code`, `agent` and `smart` are 262K. `caps.memGb` replaces mux's formula, which counts
0.06 GB per 1K of context and would put 15 GB on a 262K window.

**Fixed:** the healer's stuck check counted prompt tokens only once a prompt had been read, so it restarted qwen3.6 at
79% through a cold 165K prompt. It now also counts the model's log growing (llama-server logs every 16K prompt tokens).

## Turn stats and priority (2026-11-27)

The owner, 27 November: *"1 - do that on mux, so we have some stats and data direct in mux we can use and performance
tune from. 2 - yes [give Bloom's live answers priority]"*, then *"the model should always be hot, not unloaded"*.
Measured that morning: voice end of speech → first audio p50 1250 ms through Railway, p90 3598 ms, because one turn
waited 2.9 s for qwen3.6's first token while the Mac also ran 9 CI runners, Record's services, bge-m3 and arch-router.

**Turn stats** (`server/src/speed.ts`, table `turn_stats`, 30 days, no prompt or answer kept). One row per
`openai.chat`, `anthropic.messages`, `realtime.chat` (a voice turn's LLM call) and `realtime.turn` (the session's own
marks: turn decided, transcript, first token, first audio), on the Mac and on Railway alike: received → admitted
(`queue_ms` = presence `admit_ms` + cold `load_ms` + `slot_wait_ms`, with why: model busy, slot reserved for
interactive, interactive first, yielding to interactive, cold, presence), running and waiting at admission, prompt
tokens and those from llama.cpp's cache (`cache_n`), prefill ms (`timings.prompt_ms`), the first *reasoning* token
apart from the first *answer* token (TTFT is the answer's), generated tokens and tokens/s, total; tenant, the person
hashed, route, model, class; what else was going on (loaded models, slots running and waiting, open voice sessions, CI
jobs running and paused, Record busy, tenants in flight); the caller's `x-mux-trace` and `x-mux-stage`. A gateway sends
the class, the trace (its own request id when the caller sent none) and the stages on to the node, so the Mac's row
(the real breakdown: Railway never sees llama.cpp's timings) joins Railway's. The Speed page (Traffic → Speed; it is
per machine, so Railway's dashboard shows the Mac's too): p50 · p90 · p99 of queue wait, TTFT, tokens/s and total per
tenant/route/model/class over 15 min/hour/day/week; first token by class over time; the slowest turns; a turn's
breakdown with a timeline of every call and CI job that overlapped it; **hot models** (loaded since, the last unload
and why, unloads in 24 h); the priority switch.

**Priority** (`server/src/priority.ts`, `server/src/runtime/slots.ts`). llama-server serves its `--parallel` slots
first come, first served, so mux now holds the queue for the models it runs and hands out slots by class:
interactive takes any free slot, and on a model with 2+ slots `priorityReserveSlots` (1) are for interactive only;
normal takes the others when no person is waiting; background also yields while a person's turn runs on that model, for
at most `priorityBackgroundMaxWaitMs` (60 s), so it never starves. It is **off by default** (`priorityEnabled`): a node turns it
on once its gateway sends `x-mux-priority` (`deploy/speed.sh --railway` does, after Railway runs this code), or every
Railway call would arrive as `normal`; off, it is one first-come
queue again (still measured), for before/after on the same build. Trade-off: with 2 slots, two `normal` requests at
once (OpenCode, Orca) now run one after another on qwen3.6. CI steps on the Mac are paused while a voice session is
open (`pauseCiForVoice`), as they were for Record's live work. Interactive turns to a reasoning model are asked not to
think (`interactiveNoThinking`; a caller's own `chat_template_kwargs.enable_thinking` wins), and every llama.cpp turn
asks for the prompt cache. A voice answer's first clause is spoken once it has 24 characters, rather than its whole
first sentence.

**Always hot** (`deploy/speed.sh`). Pinned models are never unloaded by idle timers, room for another model, memory
pressure or a busy machine; the healer restarts a pinned model's first crash at once; a pinned chat model gets a one-token
warm-up after each load. The script pins the `interactive` route's model (qwen3.6, thinking off: 92 tok/s, ~140 ms to
its first token warm), then the Mac's `agent`, then what Railway's `agent` starts with (Inkling: 29 tok/s, always
reasons) only if it fits beside the hear sidecar (~2.5 GB), the face (5.3 GB peak), Kokoro and the headroom; stops the
failed Haru and MiniCPM-o trials; adds `--cache-reuse 256`; and with `--railway` drops from Railway's `agent` the Mac
models that cannot answer (saved to `~/.mux/speed-railway-agent.json`). It measures with `deploy/chat-latency.mjs`
before and after (priority off, then on, under a background load).

Measured: with fakes only (tests: a person's first wait p90 ~0 ms with priority on against > 40 ms behind a 120 ms
batch with it off). **Real numbers (2026-11-27, `./deploy/speed.sh --railway`, then measured again by hand):**

| On the Mac, 3 background workers filling the model | First token p50 · p90 | Total p50 · p90 | mux queue p90 |
| --- | --- | --- | --- |
| `interactive` (qwen3.6, thinking off), priority **off** | 8862 · 8947 ms | 9682 · 9770 ms | 8835 ms |
| `interactive`, priority **on** | **99 · 118 ms** | 933 · 950 ms | 0 ms |
| `agent` (qwen3.6), priority off | 8890 · 14901 ms | 9687 · 15733 ms | 14799 ms |
| `agent`, priority on | **100 · 110 ms** | 935 · 948 ms | 0 ms |

- Through Railway, `agent` starts with Inkling (pinned now): every turn reasoned first (10 of 10), the first reasoning
  token at 324–991 ms, the whole answer 2.6–3.4 s (p50 2805 ms). Bloom's live paths ask for `interactive` (qwen3.6,
  thinking off) instead.
- The script's own Mac measurement failed: it used `bloom-design-composer-test`, which may not use `agent` (403), and
  allows 30 requests a minute and 1 at a time, so the background workers and turns were refused (429). The numbers above
  were taken with a one-day key of mux's own `assistant` tenant (no limits), revoked after; the script now does the same.
- Left as they were: Railway's `agent` keeps `mac-studio/qwen3.8-flash-next` (its MTPLX service passed the script's
  check but has never answered); `mac-studio/arex-2` was dropped (old list in `~/.mux/speed-railway-agent.json`).
  Memory after: inkling-2-mini and qwen3.6 pinned and hot, 64.3 of 70 GB of mux's budget, 21 GB free on the Mac.
