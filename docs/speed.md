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
