# Inkling 2 Mini

Added 2026-11-24 (owner: *"Install and load https://huggingface.co/blog/inkling2mini"*). Model id `inkling-2-mini`,
installed by `./deploy/inkling.sh`. No route sends to it yet; that waits until it is measured and the owner decides.

## The model

- **Source:** [thinkingmachines/Inkling-2-Mini](https://huggingface.co/thinkingmachines/Inkling-2-Mini) (Thinking Machines
  Lab, 2026-11-20), [blog](https://huggingface.co/blog/inkling2mini).
- **Shape:** a looped MoE with 26.4 B parameters in total and 3.4 B active per token. It has 24 layers, and layers 6–17
  run three times per token with shared weights, so each token goes through 48 layer passes (5.4 B effective active).
  It routes 8 of 128 experts per token. Five of every six layers use sliding-window attention over 1,024 tokens.
- **In and out:** text and images in (40–4096 px per side), text out. Context of up to 1M tokens.
- **Reasoning:** `reasoning_effort` takes `none`, `minimal`, `low`, `medium`, `high` (the model's default), `xhigh`,
  `max`, or a number from 0.0 to 0.99. Mux starts it with `--reasoning-effort medium`, because the card warns of long
  reasoning loops, especially when debugging code. A request's own `reasoning_effort` overrides that. Even at the
  minimum it still reasons a little.
- **Weights here:** [ggml-org/Inkling-2-Mini-GGUF](https://huggingface.co/ggml-org/Inkling-2-Mini-GGUF). The model is
  `Inkling-2-Mini-IQ4_NL.gguf` (17.6 GB, imatrix-calibrated, with the experts of layers 0–19 at IQ4_NL and the rest at
  Q8_0). The vision projector is `mmproj-Inkling-2-Mini-BF16.gguf` (0.64 GB). Both are in
  `~/.mux/models/ggml-org--Inkling-2-Mini-GGUF`. Against BF16, IQ4_NL has a KL divergence of 0.0095 and picks the same
  top token 95.5% of the time; Q8_0 (27.8 GB) has 0.0030 and 97.6%.

## Runtime: its own llama.cpp

The `inkling2_loop` architecture arrived in llama.cpp #32694, merged 2026-11-20, after v1.0.0. The Homebrew build
(0.8.0 here; 1.0.0 stable) cannot load it. Mux therefore gained a per-model `server_bin`, a llama-server under
`~/.mux/llama.cpp/` and nothing else. This model runs on nightly **b12678** (`~/.mux/llama.cpp/b12678/`). Every other
model stays on `/opt/homebrew/bin/llama-server`. Once a Homebrew release includes Inkling, set `server_bin` to null and
delete the folder.

Open upstream at the time of writing: Metal FLASH_ATTN_EXT with indexed bias for Inkling 2 (#32808), and DSpark
speculative decoding (#32218).

## Licence and terms

- **Weights: Apache-2.0** (the card's metadata and section 2). The repo has no LICENSE file (it returned 404). Keep
  Apache-2.0's notice and credit Thinking Machines Lab on anything derived from it.
- **[Model Acceptable Use Policy](https://thinkingmachines.ai/model-acceptable-use-policy/)** (2026-07-15). It calls
  itself binding on anyone who uses the Model Materials, modified versions included, so it covers this quant. It places
  no limit on commercial use and no limit by territory; the only geographic term is export control and sanctions.
  - It bans the usual: illegal use (including the EU AI Act's prohibited practices), CSAM, CBRN, cyberweapons, extremism,
    non-consensual sexual content, surveillance and doxxing, scams and impersonation, and unlicensed medical, legal or
    financial advice. It also bans automated decisions about people's rights without human oversight, and getting
    around safeguards.
  - **What it requires of mux and its tenants:** we are responsible for our users' compliance. Where people use a product
    built on it, the product must tell them its known material limitations and risks, and that they are talking to an
    AI wherever law requires it or it matters to them. It must not pass AI output off as written by a person.
  - It may change at any time, and continued use means accepting the change.

## Measured on the Mac

2026-11-24, llama.cpp b12678, 131072 context split into 2 slots of 65536, `--cache-ram 1024`:

- **Load:** 21.1 s cold, after mux unloaded qwen3.6 to make room; 3 s warm. Mux's estimate is 25.8 GB. The process
  held **22.8 GB** (RSS) after a few requests.
- **Speed:** **29 tokens/s** generating (800 tokens in 27.5 s), 175 tokens/s on prompts (105 tokens). That is less than
  half of qwen3.6 (~80) and Qwen3-Coder-Next (64): the loop runs 48 layer passes per token.
- **Answers:** text ("Copenhagen"), image (an 8×8 red PNG: "Red"), and a tool call (`get_weather {"city":"Aarhus"}`),
  all through mux with a one-day key of the `assistant` tenant.
- **Reasoning never switches off:** with `reasoning_effort: "none"` a 300-word answer still spent about 2,000
  characters reasoning first, as the card says.
- **Room:** all four loaded models were pinned (62.2 of 70 GB), so it could not load. The owner chose to unpin
  qwen3.6 (2026-11-24), which mux now swaps with Inkling as needed. The Mac's swap stood at 17 GB before and 19 GB
  after.
