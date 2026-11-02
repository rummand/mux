import { CATALOG } from "./catalog.js";
import { config } from "./config.js";
import { db, event, now } from "./db.js";

/**
 * What the world uses: for each catalog model, its Hugging Face downloads (last 30 days), likes and trending score —
 * the base model's and the GGUF repo mux downloads — read once a day; and the GGUF models trending now that the
 * catalog does not have. The advisor weighs these lightly beside what mux measures itself (advisor.ts): popularity is
 * evidence that a model is good and kept up, not that it is good here.
 */
db.exec(`
CREATE TABLE IF NOT EXISTS model_signals (
  catalog_id TEXT PRIMARY KEY, repo TEXT, base_repo TEXT,
  downloads INTEGER, likes INTEGER, trending REAL, base_downloads INTEGER, base_likes INTEGER,
  fetched_at INTEGER NOT NULL, error TEXT
);
CREATE TABLE IF NOT EXISTS trending_models (
  repo TEXT PRIMARY KEY, downloads INTEGER, likes INTEGER, trending REAL, created_at TEXT, pipeline TEXT, fetched_at INTEGER NOT NULL
);
`);

const HF = "https://huggingface.co";
const headers = () => (config.hfToken ? { authorization: `Bearer ${config.hfToken}` } : {}) as Record<string, string>;

interface HfModel { id: string; downloads?: number; likes?: number; trendingScore?: number; createdAt?: string; pipeline_tag?: string; cardData?: { base_model?: string | string[] }; tags?: string[] }

async function hfModel(repo: string): Promise<HfModel | null> {
  const r = await fetch(`${HF}/api/models/${repo}?expand[]=downloads&expand[]=likes&expand[]=trendingScore&expand[]=cardData&expand[]=createdAt`, { headers: headers(), signal: AbortSignal.timeout(15_000) });
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(`${repo}: ${r.status}`);
  return (await r.json()) as HfModel;
}

/** The model a GGUF repo was made from (its card's base_model, or the tag base_model:…); the GGUF repo itself otherwise. */
function baseOf(m: HfModel): string | null {
  const b = m.cardData?.base_model;
  const fromCard = Array.isArray(b) ? b[0] : b;
  const fromTag = m.tags?.find((t) => t.startsWith("base_model:") && !t.includes(":quantized:") && !t.includes(":finetune:"))?.split(":").pop();
  const base = fromCard || fromTag || null;
  return base && base !== m.id ? base : null;
}

let running: Promise<{ ok: number; failed: number }> | null = null;

/** Read every catalog model's numbers from Hugging Face (6 at a time), and what is trending among GGUF models. */
export function refreshSignals(): Promise<{ ok: number; failed: number }> {
  running ??= (async () => {
    let ok = 0, failed = 0;
    const put = db.prepare(`INSERT INTO model_signals(catalog_id, repo, base_repo, downloads, likes, trending, base_downloads, base_likes, fetched_at, error) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(catalog_id) DO UPDATE SET repo = excluded.repo, base_repo = excluded.base_repo, downloads = excluded.downloads, likes = excluded.likes, trending = excluded.trending,
        base_downloads = excluded.base_downloads, base_likes = excluded.base_likes, fetched_at = excluded.fetched_at, error = excluded.error`);
    const queue = [...CATALOG];
    await Promise.all(Array.from({ length: 6 }, async () => {
      for (let c = queue.shift(); c; c = queue.shift()) {
        if (!c.repo || !c.repo.includes("/")) continue; // e.g. Laya's npm package
        try {
          const m = await hfModel(c.repo);
          if (!m) { put.run(c.id, c.repo, null, null, null, null, null, null, now(), "not on Hugging Face"); failed++; continue; }
          const baseRepo = baseOf(m);
          const base = baseRepo ? await hfModel(baseRepo).catch(() => null) : null;
          put.run(c.id, c.repo, baseRepo, m.downloads ?? null, m.likes ?? null, m.trendingScore ?? null, base?.downloads ?? null, base?.likes ?? null, now(), null);
          ok++;
        } catch (e) { put.run(c.id, c.repo, null, null, null, null, null, null, now(), (e as Error).message.slice(0, 200)); failed++; }
      }
    }));
    try {
      const r = await fetch(`${HF}/api/models?filter=gguf&sort=trendingScore&limit=60&expand[]=downloads&expand[]=likes&expand[]=trendingScore&expand[]=createdAt&expand[]=pipeline_tag`, { headers: headers(), signal: AbortSignal.timeout(20_000) });
      if (r.ok) {
        const list = (await r.json()) as HfModel[];
        db.prepare("DELETE FROM trending_models").run();
        const t = db.prepare("INSERT INTO trending_models(repo, downloads, likes, trending, created_at, pipeline, fetched_at) VALUES(?, ?, ?, ?, ?, ?, ?)");
        for (const m of list) t.run(m.id, m.downloads ?? 0, m.likes ?? 0, m.trendingScore ?? 0, m.createdAt ?? null, m.pipeline_tag ?? null, now());
      }
    } catch { /* trending is a bonus */ }
    event(failed ? "warn" : "info", "advisor", `web signals: ${ok} catalog models read from Hugging Face${failed ? `, ${failed} failed` : ""}`);
    return { ok, failed };
  })().finally(() => { running = null; });
  return running;
}

export interface Signal { repo: string; baseRepo: string | null; downloads: number | null; likes: number | null; trending: number | null; baseDownloads: number | null; baseLikes: number | null; fetchedAt: number; error: string | null; popularity: number | null }

/**
 * Every catalog model's signals, with a popularity 0–10: the log of its downloads (base model and GGUF together)
 * against the most downloaded model in the catalog, so the best known model is 10 and one with a few hundred is ~2.
 */
export function signals(): Map<string, Signal> {
  const rows = db.prepare("SELECT * FROM model_signals").all() as { catalog_id: string; repo: string; base_repo: string | null; downloads: number | null; likes: number | null; trending: number | null; base_downloads: number | null; base_likes: number | null; fetched_at: number; error: string | null }[];
  const total = (r: (typeof rows)[number]) => (r.downloads ?? 0) + (r.base_downloads ?? 0);
  const top = Math.log10(Math.max(10, ...rows.map(total)) + 1);
  return new Map(rows.map((r) => [r.catalog_id, {
    repo: r.repo, baseRepo: r.base_repo, downloads: r.downloads, likes: r.likes, trending: r.trending, baseDownloads: r.base_downloads, baseLikes: r.base_likes, fetchedAt: r.fetched_at, error: r.error,
    popularity: r.error ? null : Math.round((Math.log10(total(r) + 1) / top) * 100) / 10,
  }]));
}

/** Kinds mux can serve, as Hugging Face names them; not image generators or "any-to-any" demos. */
const SERVABLE = new Set(["text-generation", "image-text-to-text", "feature-extraction", "sentence-similarity", "text-ranking", "automatic-speech-recognition", "text-to-speech"]);
/** Re-uploads with the safety training removed, which mux does not offer its tenants. */
const UNSAFE = /uncensored|abliterat|heretic|nsfw|jailbr|unfiltered/i;
/** Who quantised it is not the model: "unsloth/Qwen3.8-Flash-Next-GGUF" and "bartowski/…" are one model. */
const modelName = (repo: string) => repo.split("/").pop()!.toLowerCase().replace(/[-_.](gguf|gsq|rco|imatrix|i1|q\d.*|\d{4}|instruct|it)\b/g, "").replace(/[^a-z0-9]/g, "");

/**
 * GGUF models trending on Hugging Face now that the catalog has no entry for (by repo or by base model): servable
 * kinds only, no safety-stripped re-uploads, one row per model (its most downloaded upload).
 */
export function trendingNotInCatalog(limit = 15) {
  const known = new Set<string>();
  for (const c of CATALOG) known.add(c.repo.toLowerCase());
  for (const s of signals().values()) if (s.baseRepo) known.add(s.baseRepo.toLowerCase());
  const names = CATALOG.map((c) => c.name.toLowerCase().replace(/[^a-z0-9]/g, ""));
  return [...(db.prepare("SELECT * FROM trending_models ORDER BY trending DESC").all() as { repo: string; downloads: number; likes: number; trending: number; created_at: string | null; pipeline: string | null; fetched_at: number }[])
    .filter((m) => !known.has(m.repo.toLowerCase()) && !names.some((n) => n.length > 5 && m.repo.toLowerCase().replace(/[^a-z0-9]/g, "").includes(n)))
    .filter((m) => (!m.pipeline || SERVABLE.has(m.pipeline)) && !UNSAFE.test(m.repo))
    .reduce((acc, m) => { const k = modelName(m.repo); const prev = acc.get(k); if (!prev || m.downloads > prev.downloads) acc.set(k, { ...m, uploads: (prev?.uploads ?? 0) + 1 }); else prev.uploads++; return acc; }, new Map<string, { repo: string; downloads: number; likes: number; trending: number; created_at: string | null; pipeline: string | null; fetched_at: number; uploads: number }>())
    .values()].sort((a, b) => b.trending - a.trending).slice(0, limit);
}

/** Read once a day (and a minute after start, if the last read is older than that). */
export function startSignals() {
  const last = (db.prepare("SELECT MAX(fetched_at) t FROM model_signals").get() as { t: number | null }).t ?? 0;
  if (now() - last > 86400_000) setTimeout(() => void refreshSignals().catch(() => undefined), 60_000).unref();
  setInterval(() => void refreshSignals().catch(() => undefined), 86400_000).unref();
}

export const signalsAge = () => (db.prepare("SELECT MAX(fetched_at) t FROM model_signals").get() as { t: number | null }).t;
