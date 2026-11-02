/**
 * Free tiers of hosted model APIs, as researched on 2026-11-02 against each provider's own pages (pricing, rate
 * limits, terms). mux adds one with a key — or none, for OVHcloud's anonymous endpoints — as a provider on its free plan:
 * its limits are counted (quota.ts), it rescues traffic only when every model of ours fails, and only if it does not
 * train on free-tier prompts (trainsOnData false). Gemini counts as not training because the owner's account is in the
 * EEA (Denmark), where Google applies its paid terms to free use. Left out: tiers whose terms let the provider use the
 * prompts or limit them to testing (NVIDIA NIM and others), and ones that are trial or pay-first now.
 */
export interface FreeTierModel { id: string; kind: "chat" | "embedding" | "transcription"; name: string; catalog: string | null; goodFor: string[]; ctx: number | null }
export interface FreeTier {
  id: string; name: string; base_url: string; endpoints: string[]; signup: string | null; cardRequired: boolean; keyless: boolean; needsAccountId: boolean;
  trainsOnData: boolean | null; eu: boolean; policy: string; policyUrl: string | null; limits: { default?: Record<string, number>; per_model?: Record<string, Record<string, number>> }; notes: string;
  models: FreeTierModel[];
}
export const FREE_TIERS: FreeTier[] = [
 {
  "id": "groq",
  "name": "Groq",
  "base_url": "https://api.groq.com/openai/v1",
  "endpoints": [
   "chat",
   "transcriptions"
  ],
  "signup": "https://console.groq.com/keys",
  "cardRequired": false,
  "keyless": false,
  "needsAccountId": false,
  "trainsOnData": false,
  "eu": false,
  "policy": "By default, Groq does not retain customer data for inference requests. Customer data (inputs, outputs, and related state) is only retained in two cases: If you use features that require data retention to function ... If needed to protect platform reliability (e.g., to troubleshoot system failures or",
  "policyUrl": "https://console.groq.com/docs/your-data",
  "limits": {
   "default": {
    "rpm": 30,
    "rpd": 1000,
    "tpm": 8000,
    "tpd": 200000
   },
   "per_model": {
    "openai/gpt-oss-120b": {
     "rpm": 30,
     "rpd": 1000,
     "tpm": 8000,
     "tpd": 200000
    },
    "openai/gpt-oss-20b": {
     "rpm": 30,
     "rpd": 1000,
     "tpm": 8000,
     "tpd": 200000
    },
    "qwen/qwen3.8-27b": {
     "rpm": 30,
     "rpd": 1000,
     "tpm": 8000,
     "tpd": 200000
    },
    "openai/gpt-oss-safeguard-20b": {
     "rpm": 3,
     "rpd": 1000,
     "tpm": 2000,
     "tpd": 200000
    },
    "whisper-large-v3": {
     "rpm": 20,
     "rpd": 2000
    },
    "whisper-large-v3-turbo": {
     "rpm": 20,
     "rpd": 2000
    }
   }
  },
  "notes": "Free plan model list is now small (gpt-oss, Qwen3.8 27B, Whisper, prompt-guard, Orpheus TTS); Llama models are no longer on the free table. Limits are org-wide; low 8K TPM means long agent prompts hit TPM before RPM. No embeddings endpoint. ctx for qwen3.8-27b not checked. Training is not mentioned explicitly on the Your Data page, but nothing is retained by default, so prompts cannot be trained o",
  "models": [
   {
    "id": "openai/gpt-oss-120b",
    "kind": "chat",
    "name": "GPT-OSS 120B",
    "catalog": "gpt-oss-120b",
    "goodFor": [
     "tools",
     "code",
     "reasoning",
     "fast"
    ],
    "ctx": 131072
   },
   {
    "id": "openai/gpt-oss-20b",
    "kind": "chat",
    "name": "GPT-OSS 20B",
    "catalog": "gpt-oss-20b",
    "goodFor": [
     "tools",
     "code",
     "fast"
    ],
    "ctx": 131072
   },
   {
    "id": "qwen/qwen3.8-27b",
    "kind": "chat",
    "name": "Qwen3.8 27B",
    "catalog": "qwen3.8-27b",
    "goodFor": [
     "tools",
     "code",
     "danish",
     "fast"
    ],
    "ctx": null
   },
   {
    "id": "whisper-large-v3",
    "kind": "transcription",
    "name": "Whisper large v3",
    "catalog": null,
    "goodFor": [
     "danish"
    ],
    "ctx": null
   },
   {
    "id": "whisper-large-v3-turbo",
    "kind": "transcription",
    "name": "Whisper large v3 turbo",
    "catalog": null,
    "goodFor": [
     "danish",
     "fast"
    ],
    "ctx": null
   }
  ]
 },
 {
  "id": "gemini",
  "name": "Google AI Studio (Gemini API free tier)",
  "base_url": "https://generativelanguage.googleapis.com/v1beta/openai",
  "endpoints": [
   "chat",
   "embeddings"
  ],
  "signup": "https://aistudio.google.com/apikey",
  "cardRequired": false,
  "keyless": false,
  "needsAccountId": false,
  "trainsOnData": false,
  "eu": false,
  "policy": "If you're in the European Economic Area, Switzerland, or the United Kingdom, the terms under \"How Google uses Your Data\" in \"Paid Services\" apply to all Services, including Google AI Studio and unpaid quota in the Gemini API, even though they are offered free of charge. [Paid:] Google doesn't use yo",
  "policyUrl": "https://ai.google.dev/gemini-api/terms",
  "limits": {
   "default": {}
  },
  "notes": "Free per-model RPM/RPD/TPM are no longer published in docs; they are only shown in AI Studio (aistudio.google.com/rate-limit). Free tier: Flash, Flash-Lite, 2.5 Pro, Gemma 4, embeddings (gemini-embedding-001; gemini-embedding-2 free status unclear), Transcribe and TTS; NOT free: gemini-4-argon, gemini-3.1-pro-preview, image models. Grounding with Google Search not available on free tier. Gemini 3.",
  "models": [
   {
    "id": "gemini-3.8-flash",
    "kind": "chat",
    "name": "Gemini 3.8 Flash",
    "catalog": null,
    "goodFor": [
     "tools",
     "code",
     "danish",
     "vision",
     "reasoning"
    ],
    "ctx": null
   },
   {
    "id": "gemini-3.6-flash",
    "kind": "chat",
    "name": "Gemini 3.6 Flash",
    "catalog": null,
    "goodFor": [
     "tools",
     "code",
     "danish",
     "vision"
    ],
    "ctx": null
   },
   {
    "id": "gemini-3.5-flash-lite",
    "kind": "chat",
    "name": "Gemini 3.5 Flash-Lite",
    "catalog": null,
    "goodFor": [
     "fast",
     "danish",
     "tools"
    ],
    "ctx": null
   },
   {
    "id": "gemini-2.5-pro",
    "kind": "chat",
    "name": "Gemini 2.5 Pro",
    "catalog": null,
    "goodFor": [
     "reasoning",
     "code",
     "danish"
    ],
    "ctx": 1048576
   },
   {
    "id": "gemma-4-31b-it",
    "kind": "chat",
    "name": "Gemma 4 31B IT",
    "catalog": "gemma-4-31b",
    "goodFor": [
     "danish",
     "vision",
     "tools"
    ],
    "ctx": 262144
   },
   {
    "id": "gemma-4-26b-a4b-it",
    "kind": "chat",
    "name": "Gemma 4 26B A4B IT",
    "catalog": "gemma-4-26b-a4b",
    "goodFor": [
     "danish",
     "vision",
     "fast"
    ],
    "ctx": 262144
   },
   {
    "id": "gemini-embedding-001",
    "kind": "embedding",
    "name": "Gemini Embedding",
    "catalog": null,
    "goodFor": [
     "danish"
    ],
    "ctx": null
   },
   {
    "id": "gemini-3.5-transcribe",
    "kind": "transcription",
    "name": "Gemini 3.5 Transcribe",
    "catalog": null,
    "goodFor": [
     "danish"
    ],
    "ctx": null
   }
  ]
 },
 {
  "id": "openrouter",
  "name": "OpenRouter (:free models)",
  "base_url": "https://openrouter.ai/api/v1",
  "endpoints": [
   "chat"
  ],
  "signup": "https://openrouter.ai/keys",
  "cardRequired": false,
  "keyless": false,
  "needsAccountId": false,
  "trainsOnData": null,
  "eu": false,
  "policy": "On your account settings page, you can set whether you would like to allow routing to providers that may train on your data (according to their own policies). There are separate settings for paid and free models.",
  "policyUrl": "https://openrouter.ai/docs/guides/privacy/logging",
  "limits": {
   "default": {
    "rpm": 20,
    "rpd": 50
   }
  },
  "notes": "14 :free models listed by GET /api/v1/models on 2026-11-02 (no Qwen, no gpt-oss free variants today). Limits are account-wide across all :free models: 20 rpm, 50 rpd with <$10 lifetime credit purchase, 1000 rpd with >=$10 (one-time purchase unlocks it permanently). Never put a paid model in a `models` fallback array if the request must stay free. Free endpoints are often provider-promotional and m",
  "models": [
   {
    "id": "google/gemma-4-31b-it:free",
    "kind": "chat",
    "name": "Gemma 4 31B",
    "catalog": "gemma-4-31b",
    "goodFor": [
     "tools",
     "danish",
     "vision"
    ],
    "ctx": 262144
   },
   {
    "id": "google/gemma-4-26b-a4b-it:free",
    "kind": "chat",
    "name": "Gemma 4 26B A4B",
    "catalog": "gemma-4-26b-a4b",
    "goodFor": [
     "tools",
     "danish",
     "vision",
     "fast"
    ],
    "ctx": 262144
   },
   {
    "id": "cohere/north-mini-code:free",
    "kind": "chat",
    "name": "Cohere North Mini Code",
    "catalog": "north-mini-code-1.0",
    "goodFor": [
     "code",
     "tools"
    ],
    "ctx": 256000
   },
   {
    "id": "nvidia/nemotron-3-ultra-550b-a55b:free",
    "kind": "chat",
    "name": "Nemotron 3 Ultra 550B A55B",
    "catalog": null,
    "goodFor": [
     "tools",
     "reasoning"
    ],
    "ctx": 1000000
   },
   {
    "id": "nvidia/nemotron-3.5-super-vl:free",
    "kind": "chat",
    "name": "Nemotron 3.5 Super VL",
    "catalog": null,
    "goodFor": [
     "tools",
     "vision"
    ],
    "ctx": 1000000
   },
   {
    "id": "nvidia/nemotron-3.5-lightning:free",
    "kind": "chat",
    "name": "Nemotron 3.5 Lightning",
    "catalog": null,
    "goodFor": [
     "tools",
     "fast"
    ],
    "ctx": 1000000
   },
   {
    "id": "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free",
    "kind": "chat",
    "name": "Nemotron 3 Nano Omni 30B A3B",
    "catalog": null,
    "goodFor": [
     "tools",
     "vision"
    ],
    "ctx": 256000
   },
   {
    "id": "thinkingmachines/inkling:free",
    "kind": "chat",
    "name": "Thinking Machines Inkling",
    "catalog": null,
    "goodFor": [
     "tools",
     "vision"
    ],
    "ctx": 1048576
   }
  ]
 },
 {
  "id": "cloudflare",
  "name": "Cloudflare Workers AI",
  "base_url": "https://api.cloudflare.com/client/v4/accounts/{account_id}/ai/v1",
  "endpoints": [
   "chat",
   "embeddings"
  ],
  "signup": "https://dash.cloudflare.com/sign-up/workers-and-pages",
  "cardRequired": false,
  "keyless": false,
  "needsAccountId": true,
  "trainsOnData": false,
  "eu": false,
  "policy": "Zero data retention: Workers AI processes Customer Content only for as long as needed to provide the service. For standard inference requests that do not invoke a stateful feature, Cloudflare does not retain inputs or outputs after they are no longer needed ... Cloudflare does not use your Customer ",
  "policyUrl": "https://developers.cloudflare.com/workers-ai/platform/data-usage/",
  "limits": {
   "default": {
    "rpm": 300
   }
  },
  "notes": "Free = 10,000 Neurons/day (Workers Free plan, no card). That is small for LLMs: large models burn neurons fast (roughly a few hundred to a few thousand chat turns/day depending on model - not computed). Some models need a paid plan (kimi-k2.6/2.7, glm-5.x, deepseek-v4*). OpenAI-compatible URL serves /chat/completions and /embeddings only; Whisper runs via the native /ai/run/@cf/openai/whisper-larg",
  "models": [
   {
    "id": "@cf/qwen/qwen3.8-27b",
    "kind": "chat",
    "name": "Qwen3.8 27B",
    "catalog": "qwen3.8-27b",
    "goodFor": [
     "tools",
     "code",
     "danish"
    ],
    "ctx": null
   },
   {
    "id": "@cf/google/gemma-4-26b-a4b-it",
    "kind": "chat",
    "name": "Gemma 4 26B A4B",
    "catalog": "gemma-4-26b-a4b",
    "goodFor": [
     "danish",
     "vision",
     "fast"
    ],
    "ctx": null
   },
   {
    "id": "@cf/openai/gpt-oss-120b",
    "kind": "chat",
    "name": "GPT-OSS 120B",
    "catalog": "gpt-oss-120b",
    "goodFor": [
     "tools",
     "code",
     "reasoning"
    ],
    "ctx": null
   },
   {
    "id": "@cf/openai/gpt-oss-20b",
    "kind": "chat",
    "name": "GPT-OSS 20B",
    "catalog": "gpt-oss-20b",
    "goodFor": [
     "tools",
     "code",
     "fast"
    ],
    "ctx": null
   },
   {
    "id": "@cf/mistralai/mistral-small-3.1-24b-instruct",
    "kind": "chat",
    "name": "Mistral Small 3.1 24B",
    "catalog": null,
    "goodFor": [
     "danish",
     "tools",
     "vision"
    ],
    "ctx": null
   },
   {
    "id": "@cf/baai/bge-m3",
    "kind": "embedding",
    "name": "BGE-M3",
    "catalog": "bge-m3",
    "goodFor": [
     "danish"
    ],
    "ctx": 8192
   },
   {
    "id": "@cf/qwen/qwen3-embedding-0.6b",
    "kind": "embedding",
    "name": "Qwen3 Embedding 0.6B",
    "catalog": "qwen3-embedding-0.6b",
    "goodFor": [
     "danish"
    ],
    "ctx": null
   },
   {
    "id": "@cf/openai/whisper-large-v3-turbo",
    "kind": "transcription",
    "name": "Whisper large v3 turbo",
    "catalog": null,
    "goodFor": [
     "danish"
    ],
    "ctx": null
   }
  ]
 },
 {
  "id": "mistral",
  "name": "Mistral AI Studio / La Plateforme (Free mode, formerly 'Experiment')",
  "base_url": "https://api.mistral.ai/v1",
  "endpoints": [
   "chat",
   "embeddings",
   "transcriptions"
  ],
  "signup": "https://console.mistral.ai (Admin > Subscriptions; Free mode enabled by default, phone verification reported)",
  "cardRequired": false,
  "keyless": false,
  "needsAccountId": false,
  "trainsOnData": true,
  "eu": true,
  "policy": "Free mode As stated during subscription, we may use your data (input and output) to train our artificial intelligence models. You have the right to opt out of this program at any time.",
  "policyUrl": "https://help.mistral.ai/en/articles/323757-do-you-use-my-user-data-to-train-your-artificial-intelligence-models",
  "limits": {
   "default": {}
  },
  "notes": "Docs: 'Free mode: API access is enabled by default with no credit card required. Usage and rate limits apply.' Numeric free limits are NOT published; they are only shown in Admin Panel > API > Limits (RPS + tokens/min per model, audio seconds/min and /month). Third-party sites claim ~2 RPM / 500k TPM / 1B tokens/month - UNVERIFIED. Free data IS used for training by default, but free users can opt ",
  "models": [
   {
    "id": "mistral-small-latest",
    "kind": "chat",
    "name": "Mistral Small 4 (mistral-small-2603, 119B/6.5B active, Apache 2.0)",
    "catalog": null,
    "goodFor": [
     "tools",
     "danish",
     "code",
     "vision",
     "reasoning",
     "fast"
    ],
    "ctx": 256000
   },
   {
    "id": "mistral-large-4",
    "kind": "chat",
    "name": "Mistral Large 4",
    "catalog": null,
    "goodFor": [
     "tools",
     "danish",
     "code",
     "vision",
     "reasoning"
    ],
    "ctx": 1000000
   },
   {
    "id": "ministral-14b-latest",
    "kind": "chat",
    "name": "Ministral 3 14B (ministral-14b-2512)",
    "catalog": null,
    "goodFor": [
     "tools",
     "vision",
     "fast",
     "danish"
    ],
    "ctx": 256000
   },
   {
    "id": "ministral-8b-2512",
    "kind": "chat",
    "name": "Ministral 3 8B",
    "catalog": null,
    "goodFor": [
     "fast",
     "vision"
    ],
    "ctx": 256000
   },
   {
    "id": "codestral-latest",
    "kind": "chat",
    "name": "Codestral 25.08",
    "catalog": null,
    "goodFor": [
     "code",
     "tools"
    ],
    "ctx": 128000
   },
   {
    "id": "zai-glm-5-3-flash",
    "kind": "chat",
    "name": "Z.ai GLM 5.3 Flash (third-party, hosted by Mistral)",
    "catalog": null,
    "goodFor": [
     "tools",
     "code",
     "vision"
    ],
    "ctx": 1000000
   },
   {
    "id": "mistral-embed",
    "kind": "embedding",
    "name": "Mistral Embed (mistral-embed-2312)",
    "catalog": null,
    "goodFor": [
     "danish"
    ],
    "ctx": 8000
   },
   {
    "id": "codestral-embed-2505",
    "kind": "embedding",
    "name": "Codestral Embed",
    "catalog": null,
    "goodFor": [
     "code"
    ],
    "ctx": null
   },
   {
    "id": "voxtral-mini-transcribe-latest",
    "kind": "transcription",
    "name": "Voxtral Mini Transcribe 3 (voxtral-mini-transcribe-3-0, Public Preview)",
    "catalog": null,
    "goodFor": [
     "danish",
     "fast"
    ],
    "ctx": 32000
   },
   {
    "id": "voxtral-small-transcribe-3-0",
    "kind": "transcription",
    "name": "Voxtral Small Transcribe 3",
    "catalog": null,
    "goodFor": [
     "danish"
    ],
    "ctx": null
   }
  ]
 },
 {
  "id": "ovh",
  "name": "OVHcloud AI Endpoints",
  "base_url": "https://oai.endpoints.kepler.ai.cloud.ovh.net/v1",
  "endpoints": [
   "chat",
   "embeddings",
   "transcriptions"
  ],
  "signup": "None for anonymous use (no key at all). Key via OVHcloud Public Cloud project (paid, pay-as-you-go) lifts limits: https://endpoints.ai.cloud.ovh.net/",
  "cardRequired": false,
  "keyless": true,
  "needsAccountId": false,
  "trainsOnData": false,
  "eu": true,
  "policy": "Our infrastructure, hosted in Europe, adheres to European data protection regulations. Data is not stored or shared during or after model use, providing users with peace of mind that their data is secure and protected.",
  "policyUrl": "https://docs.ovhcloud.com/en/guides/public-cloud/ai-machine-learning/ai-endpoints-capabilities",
  "limits": {
   "default": {
    "rpm": 2
   }
  },
  "notes": "Best EU no-key rescue option: anonymous access (no API key, no account) works today, 2 requests/min per IP per model (official doc + verified live: anonymous gpt-oss-20b chat and bge-m3 embeddings returned 200 with x-ratelimit-limit-minute: 2). Because the limit is per model, spreading across models multiplies throughput. With a key (Public Cloud project, pay-as-you-go, card) 400 RPM per project p",
  "models": [
   {
    "id": "gpt-oss-120b",
    "kind": "chat",
    "name": "GPT-OSS 120B",
    "catalog": "gpt-oss-120b",
    "goodFor": [
     "tools",
     "reasoning",
     "code"
    ],
    "ctx": 131072
   },
   {
    "id": "gpt-oss-20b",
    "kind": "chat",
    "name": "GPT-OSS 20B",
    "catalog": "gpt-oss-20b",
    "goodFor": [
     "tools",
     "reasoning",
     "fast"
    ],
    "ctx": 131072
   },
   {
    "id": "Qwen3.8-27B",
    "kind": "chat",
    "name": "Qwen3.8 27B",
    "catalog": "qwen3.8-27b",
    "goodFor": [
     "tools",
     "code",
     "danish",
     "reasoning"
    ],
    "ctx": 262144
   },
   {
    "id": "Qwen3.6-27B",
    "kind": "chat",
    "name": "Qwen3.6 27B",
    "catalog": "qwen3.6-27b",
    "goodFor": [
     "tools",
     "code",
     "danish",
     "reasoning"
    ],
    "ctx": 262144
   },
   {
    "id": "Qwen3.5-9B",
    "kind": "chat",
    "name": "Qwen3.5 9B",
    "catalog": "qwen3.5-9b",
    "goodFor": [
     "tools",
     "fast"
    ],
    "ctx": 262144
   },
   {
    "id": "Mistral-Small-3.2-24B-Instruct-2506",
    "kind": "chat",
    "name": "Mistral Small 3.2 24B",
    "catalog": null,
    "goodFor": [
     "tools",
     "danish",
     "vision"
    ],
    "ctx": 131072
   },
   {
    "id": "bge-m3",
    "kind": "embedding",
    "name": "BGE-M3",
    "catalog": "bge-m3",
    "goodFor": [
     "danish"
    ],
    "ctx": 8192
   },
   {
    "id": "Qwen3-Embedding-8B",
    "kind": "embedding",
    "name": "Qwen3 Embedding 8B",
    "catalog": null,
    "goodFor": [
     "danish"
    ],
    "ctx": 32768
   },
   {
    "id": "whisper-large-v3",
    "kind": "transcription",
    "name": "Whisper large-v3",
    "catalog": null,
    "goodFor": [
     "danish"
    ],
    "ctx": null
   },
   {
    "id": "whisper-large-v3-turbo",
    "kind": "transcription",
    "name": "Whisper large-v3 turbo",
    "catalog": null,
    "goodFor": [
     "danish",
     "fast"
    ],
    "ctx": null
   }
  ]
 },
 {
  "id": "hetzner",
  "name": "Hetzner Inference API (experimental)",
  "base_url": "https://inference.hetzner.com/api/v1",
  "endpoints": [
   "chat"
  ],
  "signup": "https://experiments.hetzner.com/inference (Hetzner account login; create token under Inference)",
  "cardRequired": true,
  "keyless": false,
  "needsAccountId": false,
  "trainsOnData": false,
  "eu": true,
  "policy": "We do not store the content of request and response.",
  "policyUrl": "https://docs.hetzner.com/general/company-and-policy/experiments/inference/",
  "limits": {
   "default": {
    "rpm": 10,
    "tpm": 4000000
   }
  },
  "notes": "Free 'as long as the Inference API remains in experimental status' (Hetzner promises email notice before change); offered 'as is' for experimental purposes, no SLA. Limits per API key per 60s: 10 requests, 4M input tokens, 100k output tokens. Endpoints: /v1/models, /v1/completions, /v1/chat/completions only (no embeddings/STT). Training not mentioned explicitly but content is not stored. Data loca",
  "models": [
   {
    "id": "Qwen3.8-27B",
    "kind": "chat",
    "name": "Qwen3.8 27B",
    "catalog": "qwen3.8-27b",
    "goodFor": [
     "tools",
     "code",
     "vision",
     "danish",
     "reasoning"
    ],
    "ctx": 262144
   },
   {
    "id": "Qwen/Qwen3.6-35B-A3B-FP8",
    "kind": "chat",
    "name": "Qwen3.6 35B A3B FP8",
    "catalog": "qwen3.6-35b-a3b",
    "goodFor": [
     "tools",
     "code",
     "vision",
     "fast"
    ],
    "ctx": 262144
   }
  ]
 }
];
