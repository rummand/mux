import type { CatalogEntry } from "./catalog.js";

/**
 * The decision and speech models in Baseten's model library, run here instead of on Baseten, plus Microsoft's
 * VibeVoice-ASR beside the speech models. Repos, files, sizes and licenses were read off the Hugging Face API on
 * 2026-11-03 (VibeVoice-ASR on 2026-11-07); benchmarks are the makers' own, from each model card.
 * Only elephant-1 runs on llama-server today; the rest carry `needs`, so the Library lists them without a Download.
 * Danish coverage is in each note because it decides most of what we would use them for.
 */
export const DECISION_SPEECH_MODELS: CatalogEntry[] = [
  // ── Base Labs decision models (System One): calibrated probabilities over fixed options, no generated text ──────
  {
    id: "elephant-1", name: "Elephant-1 9B", family: "Base Labs decision", kind: "systemone",
    repo: "waseigo/elephant-1-decision-GGUF", file: "elephant-1-Q4_K_M.gguf", mmproj: "elephant-1.mmproj-Q8_0.gguf", sizeGb: 5.63,
    params: "9.4B", arch: "qwen35", ctx: 16384, license: "mit", routes: ["systemone"], defaultCtx: 8192, released: "2026-10", minLlama: "0.8.0",
    caps: { quality: 8, speed: 6.5, vision: 6 },
    notes: "Baseten's 9B decision model (fine-tuned from Qwen3.5-9B): choice, yes/no and score questions answered from one prefill. English only on the card. Text and images.",
    benchmarks: [
      { name: "Jev Decision Index 0.4", value: 62.65, url: "https://huggingface.co/baselabs/elephant-1" },
      { name: "Artificial Analysis Decision Index (replica)", value: 65.2, url: "https://huggingface.co/baselabs/elephant-1" },
    ],
    experimental: "Community GGUF: baselabs/elephant-1 with decision metadata grafted on so llama.cpp (build 11820+) serves it as an openjev decision model. Its author measured 28 of 32 answers matching Baseten's reference runtime (largest probability gap 0.26) and validated up to 26 options per question; it reads at most 52.",
  },
  {
    id: "joey-1", name: "Joey-1 2B", family: "Base Labs decision", kind: "systemone",
    repo: "baselabs/joey-1", file: "model.safetensors", sizeGb: 5.44,
    params: "2.7B", arch: "qwen35", ctx: 16384, license: "mit", routes: ["systemone"], defaultCtx: 8192, released: "2026-10",
    caps: { quality: 6.5, speed: 9, vision: 5 },
    notes: "Baseten's 2B decision model (fine-tuned from Qwen3.5-2B), the cheapest of the three. English only on the card.",
    benchmarks: [
      { name: "Jev Decision Index 0.4 (public split)", value: 63.3, url: "https://huggingface.co/baselabs/joey-1" },
      { name: "Artificial Analysis Decision Index (replica)", value: 62.9, url: "https://huggingface.co/baselabs/joey-1" },
    ],
    needs: "a decision runtime for Apple Silicon. Only Baseten's CUDA runtime (OneJev + serve.patch) runs it, and no GGUF or MLX port exists yet.",
  },
  {
    id: "mammoth-1", name: "Mammoth-1 27B", family: "Base Labs decision", kind: "systemone",
    repo: "baselabs/mammoth-1", file: "model-00001-of-00002.safetensors", sizeGb: 54.72,
    params: "27.4B", arch: "qwen35", ctx: 16384, license: "mit", routes: ["systemone"], defaultCtx: 8192, released: "2026-10",
    caps: { quality: 9, speed: 4, vision: 7 },
    notes: "Baseten's largest decision model (fine-tuned from Qwen3.5-27B), the most accurate of the three. English only on the card.",
    benchmarks: [
      { name: "Jev Decision Index 0.4", value: 71.24, url: "https://huggingface.co/baselabs/mammoth-1" },
      { name: "Artificial Analysis Decision Index (replica)", value: 65.9, url: "https://huggingface.co/baselabs/mammoth-1" },
    ],
    needs: "a decision GGUF. The published GGUFs are plain text models (llama.cpp answers 501), and the MLX port skips the bidirectional attention it was trained with.",
  },
  // ── Speech: transcription and diarization ─────────────────────────────────────────────────────────────────────
  {
    id: "nemotron-3.5-asr", name: "Nemotron 3.5 ASR 0.6B", family: "NVIDIA Nemotron Speech", kind: "transcription",
    repo: "nvidia/nemotron-3.5-asr-streaming-0.6b", file: "nemotron-3.5-asr-streaming-0.6b.q8_0.gguf", sizeGb: 0.74,
    params: "0.64B", arch: "nemotron-asr", ctx: 0, license: "openmdw-1.1", routes: ["transcribe"], defaultCtx: 0, released: "2026-06",
    caps: { quality: 6, speed: 9.5, multilingual: 7 },
    notes: "Streaming multilingual ASR, 40 locales including Danish (da-DK). Danish is weak: FLEURS WER 27.5 at 1.12 s chunks, 32.6 at 80 ms.",
    benchmarks: [
      { name: "FLEURS WER, transcription-ready locales, 1.12 s", value: 8.84, url: "https://huggingface.co/nvidia/nemotron-3.5-asr-streaming-0.6b" },
      { name: "FLEURS WER, Danish, 1.12 s", value: 27.49, url: "https://huggingface.co/nvidia/nemotron-3.5-asr-streaming-0.6b" },
    ],
    needs: "NVIDIA NeMo-Speech.cpp (`nemo-speech serve`, Metal build) as a transcription backend, or mlx-audio.",
  },
  {
    id: "nemotron-3-asr-en", name: "Nemotron 3 ASR English 0.6B", family: "NVIDIA Nemotron Speech", kind: "transcription",
    repo: "nvidia/nemotron-speech-streaming-en-0.6b", file: "nemotron-speech-streaming-en-0.6b.q8_0.gguf", sizeGb: 0.7,
    params: "0.62B", arch: "nemotron-asr", ctx: 0, license: "nvidia-open-model-license", routes: ["transcribe"], defaultCtx: 0, released: "2026-03",
    caps: { quality: 7, speed: 9.5, multilingual: 0 },
    notes: "Streaming English ASR, 80 ms to 1.12 s chunks. No Danish.",
    benchmarks: [
      { name: "Open ASR Leaderboard mean WER, 1.12 s", value: 6.93, url: "https://huggingface.co/nvidia/nemotron-speech-streaming-en-0.6b" },
    ],
    needs: "NVIDIA NeMo-Speech.cpp (`nemo-speech serve`, Metal build) as a transcription backend, or mlx-audio.",
  },
  {
    id: "nemotron-3-diarization", name: "Nemotron 3 Diarization", family: "NVIDIA Nemotron Speech", kind: "transcription",
    repo: "nvidia/Nemotron-3-Diarization", file: "Nemotron-3-Diarization.q8_0.gguf", sizeGb: 0.11,
    params: "99M", arch: "nemotron-diarization", ctx: 0, license: "openmdw-1.1", routes: ["transcribe"], defaultCtx: 0, released: "2026-09",
    caps: { quality: 7, speed: 10, multilingual: 6 },
    notes: "Who spoke when, up to 8 speakers. Language-agnostic; Danish is not named on the card. Pairs with an ASR model for speaker-tagged transcripts.",
    benchmarks: [
      { name: "DER, DIHARD III full", value: 12.73, url: "https://huggingface.co/nvidia/Nemotron-3-Diarization" },
      { name: "DER, AliMeeting near", value: 6.4, url: "https://huggingface.co/nvidia/Nemotron-3-Diarization" },
    ],
    needs: "NVIDIA NeMo-Speech.cpp, whose /v1/audio/diarizations is not an OpenAI endpoint mux routes yet.",
  },
  {
    id: "moss-transcribe-diarize", name: "MOSS Transcribe Diarize 0.9B", family: "MOSS", kind: "transcription",
    repo: "cstr/MOSS-Transcribe-Diarize-GGUF", file: "moss-transcribe-diarize-0.9b-q8_0.gguf", sizeGb: 1.41,
    params: "0.91B", arch: "moss-diarize", ctx: 0, license: "apache-2.0", routes: ["transcribe"], defaultCtx: 0, released: "2026-07",
    caps: { quality: 7.5, speed: 8.5, multilingual: 6 },
    notes: "Transcript, speakers and timestamps in one pass, up to 90 minutes. The card claims 50+ languages without listing them, so Danish is unverified. Community GGUF of OpenMOSS-Team/MOSS-Transcribe-Diarize.",
    benchmarks: [
      { name: "Open ASR Leaderboard mean WER", value: 5.17, url: "https://huggingface.co/OpenMOSS-Team/MOSS-Transcribe-Diarize" },
    ],
    needs: "CrispASR (`crispasr --server --backend moss-diarize`) or mlx-audio as a transcription backend. whisper.cpp does not run it.",
  },
  {
    id: "vibevoice-asr", name: "VibeVoice-ASR 7B", family: "Microsoft VibeVoice", kind: "transcription",
    repo: "microsoft/VibeVoice-ASR", file: "model-00001-of-00008.safetensors", sizeGb: 17.35, downloadable: true,
    params: "8.7B", arch: "vibevoice", ctx: 65536, license: "mit", routes: ["transcribe"], defaultCtx: 0, released: "2026-01",
    caps: { quality: 8, speed: 5, multilingual: 7.5 },
    notes: "Microsoft's own release (bf16 safetensors, 8 shards). Up to 60 minutes in one pass, with speakers, timestamps and text as JSON segments, plus hotwords (names, terms) as context. 50+ languages with code-switching; Danish and Kalaallisut are on the card, untested here. The streaming 7B and 1.5B successors cover 10 languages without Danish.",
    benchmarks: [
      { name: "DER, cpWER and tcpWER (charts only, no table)", value: "see card", url: "https://huggingface.co/microsoft/VibeVoice-ASR" },
      { name: "Technical report", value: "arXiv 2601.18184", url: "https://arxiv.org/abs/2601.18184" },
    ],
    needs: "a transcription backend for safetensors: Microsoft's VibeVoice code (transformers or vLLM; vLLM wants CUDA) or mlx-audio, and a way to pass its speaker JSON through /v1/audio/transcriptions. The Library downloads the whole repo; no model is registered until that backend exists.",
  },
  {
    id: "vibevoice-asr-gguf", name: "VibeVoice-ASR 7B (GGUF Q8_0)", family: "Microsoft VibeVoice", kind: "transcription",
    repo: "cstr/vibevoice-asr-GGUF", file: "vibevoice-asr-q8_0.gguf", sizeGb: 9.45, downloadable: true,
    params: "8.7B", arch: "vibevoice", ctx: 65536, license: "mit", routes: ["transcribe"], defaultCtx: 0, released: "2026-04",
    caps: { quality: 8, speed: 5.5, multilingual: 7.5 },
    notes: "Community GGUF of microsoft/VibeVoice-ASR for CrispASR (Q4_K 4.8 GB and F16 16.7 GB are in the repo too). Same model as vibevoice-asr; wants 24 kHz mono.",
    needs: "CrispASR (`crispasr --server --backend vibevoice`, Metal build) as a transcription backend. whisper.cpp and llama-server do not run it.",
  },
  {
    id: "voxtral-mini-4b-realtime", name: "Voxtral Mini 4B Realtime", family: "Voxtral", kind: "transcription",
    repo: "ggml-org/Voxtral-Mini-4B-Realtime-2602-GGUF", file: "Voxtral-Mini-4B-Realtime-2602-Q8_0.gguf", mmproj: "mmproj-Voxtral-Mini-4B-Realtime-2602-Q8_0.gguf", sizeGb: 3.66,
    params: "4.4B", arch: "voxtral", ctx: 0, license: "apache-2.0", routes: ["transcribe"], defaultCtx: 0, released: "2026-02",
    caps: { quality: 7.5, speed: 8, multilingual: 5 },
    notes: "Streaming ASR at 240 ms to 2.4 s delay, 13 languages. No Danish.",
    benchmarks: [
      { name: "FLEURS mean WER, 480 ms", value: 8.72, url: "https://huggingface.co/mistralai/Voxtral-Mini-4B-Realtime-2602" },
    ],
    needs: "a realtime transcription route: llama-server serves this model only on its WebSocket /v1/realtime, not /v1/audio/transcriptions.",
  },
  {
    id: "ultravox-v0.6-70b", name: "Ultravox v0.6 70B", family: "Ultravox", kind: "chat",
    repo: "steampunque/ultravox-v0_6-llama-3_3-70b-MP-GGUF", file: "ultravox-v0_6-llama-3_3-70b.mmproj.gguf", sizeGb: 43.92,
    params: "70B", arch: "llama", ctx: 131072, license: "llama3.3", routes: [], defaultCtx: 32768, released: "2025-05",
    caps: { quality: 8, speed: 3, multilingual: 7 },
    notes: "Speech in, text out: Llama 3.3 70B that listens. 42 languages including Danish, untested in Danish. Size is the 1.4 GB audio projector plus a Q4_K_M Llama-3.3-70B (42.5 GB).",
    benchmarks: [
      { name: "LibriSpeech WER", value: 2.55, url: "https://huggingface.co/fixie-ai/ultravox-v0_6-llama-3_3-70b" },
      { name: "Big Bench Audio", value: 85.48, url: "https://huggingface.co/fixie-ai/ultravox-v0_6-llama-3_3-70b" },
    ],
    needs: "a two-repo install (a Llama-3.3-70B GGUF plus this community projector), and the Llama 3.3 backbone is gated on Hugging Face.",
  },
];
