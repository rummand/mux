# Qwen3.8-27B against qwen3.6-35B-A3B

Added 2026-11-24 (owner: *"get Qwen 3.8 installed and test that out… figure out if Qwen 3.8 is better than Qwen 3.6"*).
Model id `qwen3.8-27b`. No route sends to it; that is the owner's call.

## The model

- [Qwen/Qwen3.8-27B](https://huggingface.co/Qwen/Qwen3.8-27B): dense, 27.8 B parameters, text and images, 262K native
  context. **Apache-2.0.** Credit Qwen; keep the licence notice on anything derived.
- Weights: [ggml-org/Qwen3.8-27B-GGUF](https://huggingface.co/ggml-org/Qwen3.8-27B-GGUF): `Qwen3.8-27B-Q4_K_M.gguf`
  (19.4 GB), its MTP drafter `mtp-Qwen3.8-27B-Q8_0.gguf` (3.2 GB) and vision `mmproj-Qwen3.8-27B-Q8_0.gguf` (0.6 GB), in
  `~/.mux/models/ggml-org--Qwen3.8-27B-GGUF`.
- In mux: llama.cpp nightly b12678 (`server_bin`), `-md <mtp> --spec-type draft-mtp,ngram-simple --spec-draft-n-max 3`.
  One slot, because MTP has not been tested with two here. 131K context; it holds **32 GB** (`caps.memGb`).
- The other Qwen3.8 models do not suit this Mac. Qwen3.8-Flash-Next is 180 B (512 experts, licence "other"), and its
  2-bit GGUF alone is 68 GB. Qwen3.8-2.4T is far too big.

## Published (Qwen's model cards; neither card compares the two directly)

| | Qwen3.8-27B | Qwen3.6-35B-A3B |
|---|---|---|
| Terminal-Bench (2.1 vs 2.0) | 73.0 | 51.5 |
| SWE-bench Pro | 61.7 | 49.5 |
| LiveCodeBench v6 | 90.3 | 80.4 |
| GPQA Diamond | 89.2 | 86.0 |
| HLE | 30.8 | 21.4 |

## Measured on the Mac (2026-11-24, temperature 0, same prompts, thinking off unless noted)

Our own test set grades itself. Code answers run against hidden tests, which were checked against reference
solutions first.

| | qwen3.6-35B-A3B | Qwen3.8-27B |
|---|---|---|
| Code, 12 problems | 11/12 | 11/12 |
| Hard code, 8 problems (regex, JSON parser, Lisp, sudoku, skyline…) | 6/8 | **7/8** |
| Maths, 10 exact answers | 10/10 | 10/10 |
| Maths with thinking (budget 12,000 tokens) | 8/10 (both misses hit the budget) | 10/10 * |
| Tool calls, 7 cases (Danish, two calls at once, none needed) | 7/7 | 7/7 |
| Instructions, 6 checkable constraints | 6/6 | 6/6 |
| Danish, 6 questions | 6/6 | 6/6 |
| Three facts across ~60K tokens | ✓ (95 s) | ✓ (344 s) |
| Speed, prose / code edit, no speculation | 89–92 / 66–89 | 23 / 25 |
| Speed, MTP + ngram (1 slot) | 109 / 345 | 36 / 100 |

\* Qwen3.8 used only 112–441 tokens per question with `enable_thinking: true`, against qwen3.6's 1,500–12,000. Its
thinking probably did not switch on that way (its card adds a `reasoning_effort` setting), so this row is not a fair
comparison.

**Verdict:** on our tests Qwen3.8-27B is a little stronger at hard code (7/8 against 6/8) and ties everywhere else.
Qwen's published coding numbers put it well ahead. But it is **3–4× slower**: it is dense, so every token reads all 27 B
weights, while qwen3.6 reads about 3 B. It also needs 32 GB against qwen3.6's ~24 GB, and it reads long prompts about
3.6× more slowly. It suits hard coding or reasoning turns where quality matters more than speed (a `smart` or
`reasoning` candidate). It does not replace qwen3.6 on `agent`, `code` or anything interactive.

The tests: the scratchpad's `evalq.py` (not in the repo).
