import { CATALOG, type CatalogEntry } from "./catalog.js";
import { db, now, settings } from "./db.js";
import { getModel, listModels, listRoutes, type Caps, type Model } from "./models.js";
import { signals, trendingNotInCatalog, type Signal } from "./signals.js";
import { systemStats } from "./runtime/system.js";

/**
 * Which model to run for what, on this Mac. Each use case weighs the capabilities it needs; the result is ranked by
 * that, by whether the model fits mux's memory budget and the disk, and by evidence in three strengths:
 *   1. what mux measures itself — its traffic over 30 days (speed, errors) and benchmarks on this Mac — counts most;
 *   2. the catalog's estimates from published results (caps);
 *   3. what the world uses — Hugging Face downloads and trends (signals.ts) — counts least: a nudge of at most ±0.3.
 * insights() turns the ranking into things to do: promote, try, measure, retire.
 */
export const USE_CASES = {
  agent: { label: "Agents with tools", w: { tools: 2, quality: 1.2, reasoning: 1, speed: 0.8, context: 0.4 } },
  support: { label: "Customer support chat", w: { multilingual: 1.4, quality: 1.2, speed: 1.3, tools: 0.6 } },
  danish: { label: "Danish & multilingual", w: { multilingual: 2.2, quality: 1.2, speed: 0.6 } },
  code: { label: "Code & dev agents", w: { code: 2.2, tools: 1, quality: 1, speed: 0.6, context: 0.5 } },
  reasoning: { label: "Reasoning & planning", w: { reasoning: 2.2, quality: 1.3, speed: 0.4 } },
  extraction: { label: "Extraction / JSON / classification", w: { speed: 1.6, tools: 1, quality: 1 } },
  fast: { label: "Fast answers / routing", w: { speed: 2.6, quality: 0.8, tools: 0.5 } },
  vision: { label: "Images, screenshots, documents", w: { vision: 2.5, quality: 1, speed: 0.5 } },
  rag: { label: "RAG embeddings", w: { quality: 1.5, multilingual: 1.5, speed: 1 } },
} as const;
export type UseCase = keyof typeof USE_CASES;

const GB = 1024 ** 3;
export const needGb = (sizeGb: number, ctx: number, embedding: boolean) => Math.round((sizeGb * 1.04 + (embedding ? 0.2 : (ctx / 1024) * 0.06) + 0.5) * 10) / 10;

function latestBench(modelId: string) {
  return db.prepare("SELECT score, tps, ttft_ms FROM benchmarks WHERE model_id = ? AND status = 'done' ORDER BY ts DESC LIMIT 1").get(modelId) as { score: number; tps: number; ttft_ms: number } | undefined;
}

/** A model's own traffic over 30 days, across every id it runs under here (this machine's, or a node's). */
export interface Usage { requests: number; errors: number; errorRate: number; tenants: number; tps: number | null; latencyMs: number | null; ttftMs: number | null; costUsd: number; toolShare: number; lastTs: number | null }

export function usageOf(ids: string[], days = 30): Usage | null {
  if (!ids.length) return null;
  const r = db.prepare(`SELECT COUNT(*) n, SUM(status >= 400) e, COUNT(DISTINCT tenant_id) t, AVG(CASE WHEN status < 400 THEN tps END) tps,
      AVG(CASE WHEN status < 400 THEN latency_ms END) lat, AVG(CASE WHEN status < 400 THEN ttft_ms END) ttft, COALESCE(SUM(cost_usd), 0) usd, AVG(tools > 0) tools, MAX(ts) last
    FROM requests WHERE ts >= ? AND model_id IN (${ids.map(() => "?").join(",")})`).get(now() - days * 86400_000, ...ids) as { n: number; e: number | null; t: number; tps: number | null; lat: number | null; ttft: number | null; usd: number; tools: number | null; last: number | null };
  if (!r.n) return null;
  return { requests: r.n, errors: r.e ?? 0, errorRate: (r.e ?? 0) / r.n, tenants: r.t, tps: r.tps, latencyMs: r.lat, ttftMs: r.ttft, costUsd: r.usd, toolShare: r.tools ?? 0, lastTs: r.last };
}

/** Every model here that is this catalog entry: by catalog id, by id, or (a node's) by the model it runs upstream. */
const instancesOf = (c: CatalogEntry, all: Model[]) => all.filter((m) => m.catalog_id === c.id || m.id === c.id || (m.backend === "node" && m.upstream_model === c.id));

export interface Advice {
  id: string; name: string; family: string; kind: string; sizeGb: number; needGb: number; params: string; activeParams?: string; license: string;
  installed: boolean; modelId: string | null; fit: "fits" | "tight" | "too-big"; diskOk: boolean; score: number; caps: Caps;
  measured: { score: number; tps: number; ttftMs: number } | null; reasons: string[]; notes: string; routes: string[]; repo: string; file: string; released: string;
  /** What mux saw it do over 30 days, and what the world makes of it. */
  usage: Usage | null; web: Signal | null;
  benchmarks: CatalogEntry["benchmarks"]; supersededBy: string | null; experimental: string | null; research: string | null;
  /** The routes it is a candidate on now, and where in each (1 = tried first). */
  onRoutes: { route: string; position: number }[];
}

export async function advise(useCase: UseCase, priority: "quality" | "balanced" | "speed" = "balanced"): Promise<{ useCase: string; budgetGb: number; diskFreeGb: number; memTotalGb: number; ranked: Advice[] }> {
  const s = settings();
  const sys = await systemStats();
  const installed = listModels();
  const web = signals();
  const routeList = listRoutes();
  const w = { ...USE_CASES[useCase].w } as Record<string, number>;
  if (priority === "quality") w.quality = (w.quality ?? 0) + 1.2;
  if (priority === "speed") w.speed = (w.speed ?? 0) + 1.2;
  const wantEmbedding = useCase === "rag";
  const entries: CatalogEntry[] = CATALOG.filter((c) => (wantEmbedding ? c.kind === "embedding" : c.kind === "chat"));
  const ranked = entries.map((c): Advice => {
    const mineAll = instancesOf(c, installed);
    const mine = mineAll.find((m) => m.enabled) ?? mineAll[0];
    const usage = usageOf(mineAll.map((m) => m.id));
    const sig = web.get(c.id) ?? null;
    const onRoutes = routeList.flatMap((r) => { const i = r.candidates.findIndex((id) => mineAll.some((m) => m.id === id)); return i >= 0 ? [{ route: r.name, position: i + 1 }] : []; });
    const need = needGb(c.sizeGb, c.defaultCtx, c.kind === "embedding");
    const fit = need <= s.memoryBudgetGb * 0.6 ? "fits" : need <= s.memoryBudgetGb ? "tight" : "too-big";
    const diskOk = !!mine || sys.diskFreeGb - c.sizeGb >= s.diskReserveGb;
    const bench = mine ? latestBench(mine.id) : undefined;
    const caps: Caps = { ...c.caps };
    // A benchmark on this Mac beats the catalog's estimate: speed from measured tokens a second, quality from the pass rate.
    if (bench?.tps) caps.speed = Math.min(10, Math.max(1, bench.tps / 10));
    if (bench?.score != null) caps.quality = (caps.quality ?? 5) * 0.5 + bench.score * 10 * 0.5;
    // Real traffic beats a benchmark's few prompts: with 50+ answers, their speed is the model's speed here.
    if (usage && usage.requests - usage.errors >= 50 && usage.tps) caps.speed = Math.min(10, Math.max(1, usage.tps / 10));
    let score = Object.entries(w).reduce((a, [k, v]) => a + (caps[k as keyof Caps] ?? 0) * v, 0) / Object.values(w).reduce((a, v) => a + v, 0);
    const reasons: string[] = [];
    if (fit === "too-big") { score -= 4; reasons.push(`needs ~${need} GB, over mux's ${s.memoryBudgetGb} GB budget`); }
    else if (fit === "tight") { score -= 0.8; reasons.push(`~${need} GB: fits, but leaves little room for other models`); }
    else reasons.push(`~${need} GB in memory`);
    if (!diskOk) { score -= 3; reasons.push(`${c.sizeGb} GB download won't fit the ${sys.diskFreeGb.toFixed(0)} GB free disk with the reserve`); }
    if (mine) { score += 0.3; reasons.push("already on this Mac"); }
    // Failing in real use costs more than any estimate earns: 10% errors over 20+ requests is −1.5.
    if (usage && usage.requests >= 20 && usage.errorRate > 0.01) { score -= Math.min(3, usage.errorRate * 15); reasons.push(`${(usage.errorRate * 100).toFixed(1)}% of its ${usage.requests} requests here failed in 30 days`); }
    if (usage && usage.requests >= 20 && usage.errorRate <= 0.01) reasons.push(`${usage.requests.toLocaleString()} requests here in 30 days from ${usage.tenants} tenant${usage.tenants === 1 ? "" : "s"}, ${usage.errors ? `${usage.errors} failed` : "none failed"}`);
    // The world's verdict nudges, never decides: ±0.3 at most.
    if (sig?.popularity != null) {
      score += (sig.popularity - 5) * 0.06;
      const dl = (sig.downloads ?? 0) + (sig.baseDownloads ?? 0);
      if (dl > 0) reasons.push(`${dl >= 1e6 ? `${(dl / 1e6).toFixed(1)}M` : dl >= 1e3 ? `${Math.round(dl / 1e3)}k` : dl} downloads on Hugging Face in 30 days${(sig.likes ?? 0) + (sig.baseLikes ?? 0) ? `, ${((sig.likes ?? 0) + (sig.baseLikes ?? 0)).toLocaleString()} likes` : ""}`);
    }
    if (c.activeParams) reasons.push(`MoE: ${c.activeParams} active of ${c.params} — fast for its size`);
    // Superseded: the research found a newer model doing its job better — unless this one is measured here.
    if (c.supersededBy && !bench && !usage) { score -= 0.3; reasons.push(`superseded by ${c.supersededBy}`); }
    // Experimental: unverified here, or only its maker's numbers — it does not outrank checked models on claims alone.
    if (c.experimental) { if (!bench && !usage) score -= 0.3; reasons.push(`experimental: ${c.experimental}`); }
    const top = Object.entries(w).sort((a, b) => b[1] - a[1])[0][0] as keyof Caps;
    reasons.push(`${top} ${caps[top] ?? "?"}/10`);
    if (bench) reasons.push(`measured here: ${bench.tps?.toFixed(0)} tok/s, ${(bench.score * 100).toFixed(0)}% of checks passed`);
    return {
      id: c.id, name: c.name, family: c.family, kind: c.kind, sizeGb: c.sizeGb, needGb: need, params: c.params, activeParams: c.activeParams, license: c.license,
      installed: !!mine, modelId: mine?.id ?? null, fit, diskOk, score: Math.round(score * 100) / 100, caps,
      measured: bench ? { score: bench.score, tps: bench.tps, ttftMs: bench.ttft_ms } : null, reasons, notes: c.notes, routes: c.routes, repo: c.repo, file: c.file, released: c.released,
      usage, web: sig, onRoutes, benchmarks: c.benchmarks, supersededBy: c.supersededBy ?? null, experimental: c.experimental ?? null, research: c.research ?? null,
    };
  }).sort((a, b) => b.score - a.score);
  return { useCase: USE_CASES[useCase].label, budgetGb: s.memoryBudgetGb, diskFreeGb: sys.diskFreeGb, memTotalGb: sys.memTotalGb, ranked };
}

/** A whole setup within the budget: the always-on lanes first (fast, agent, embeddings), the rest loaded on demand. */
export async function recommendStack() {
  const s = settings();
  const plan: { lane: string; pick: Advice | null; alwaysOn: boolean }[] = [];
  let resident = 0;
  for (const [lane, uc, alwaysOn] of [["fast", "fast", true], ["agent", "agent", true], ["embed", "rag", true], ["smart", "reasoning", false], ["code", "code", false], ["danish", "danish", false], ["vision", "vision", false]] as const) {
    const { ranked } = await advise(uc, lane === "fast" ? "speed" : "balanced");
    const room = alwaysOn ? s.memoryBudgetGb - resident : s.memoryBudgetGb - resident;
    const pick = ranked.find((a) => a.fit !== "too-big" && a.diskOk && a.needGb <= room) ?? null;
    if (pick && alwaysOn) resident += pick.needGb;
    plan.push({ lane, pick, alwaysOn });
  }
  return { budgetGb: s.memoryBudgetGb, residentGb: Math.round(resident * 10) / 10, plan };
}

export const gb = (b: number) => b / GB;

/**
 * How every model here did over 30 days — chat, embeddings, reranking and speech alike: traffic, errors, speed, who
 * used it, its last benchmark and the routes it is on. This is mux measuring itself.
 */
export function usageTable(days = 30) {
  const rows = db.prepare(`SELECT model_id, COUNT(*) n, SUM(status >= 400) e, COUNT(DISTINCT tenant_id) t, AVG(CASE WHEN status < 400 THEN latency_ms END) lat,
      AVG(CASE WHEN status < 400 THEN ttft_ms END) ttft, AVG(CASE WHEN status < 400 THEN tps END) tps, COALESCE(SUM(cost_usd), 0) usd, SUM(prompt_tokens + completion_tokens) tok, MAX(ts) last
    FROM requests WHERE ts >= ? AND model_id IS NOT NULL GROUP BY model_id ORDER BY n DESC`).all(now() - days * 86400_000) as { model_id: string; n: number; e: number | null; t: number; lat: number | null; ttft: number | null; tps: number | null; usd: number; tok: number | null; last: number }[];
  const routes = listRoutes();
  const bench = new Map((db.prepare("SELECT b.model_id, b.score, b.tps, b.ts FROM benchmarks b JOIN (SELECT model_id, MAX(ts) ts FROM benchmarks WHERE status = 'done' GROUP BY model_id) l ON l.model_id = b.model_id AND l.ts = b.ts").all() as { model_id: string; score: number; tps: number; ts: number }[]).map((b) => [b.model_id, b]));
  const ids = new Set([...rows.map((r) => r.model_id), ...listModels().filter((m) => m.enabled).map((m) => m.id)]);
  return [...ids].map((id) => {
    const r = rows.find((x) => x.model_id === id);
    const m = getModel(id);
    return {
      id, kind: m?.kind ?? null, backend: m?.backend ?? null, enabled: m?.enabled ?? false,
      requests: r?.n ?? 0, errors: r?.e ?? 0, errorRate: r ? (r.e ?? 0) / r.n : 0, tenants: r?.t ?? 0, latencyMs: r?.lat ?? null, ttftMs: r?.ttft ?? null, tps: r?.tps ?? null,
      tokens: r?.tok ?? 0, costUsd: r?.usd ?? 0, lastTs: r?.last ?? null,
      bench: bench.get(id) ? { score: bench.get(id)!.score, tps: bench.get(id)!.tps, ts: bench.get(id)!.ts } : null,
      routes: routes.flatMap((x) => { const i = x.candidates.indexOf(id); return i >= 0 ? [`${x.name}#${i + 1}`] : []; }),
    };
  }).sort((a, b) => b.requests - a.requests);
}

/* ── Insights: the ranking turned into things to do ───────────────────────────────────────────────────────────── */

export interface Insight {
  kind: "promote" | "try" | "measure" | "retire" | "watch";
  title: string; detail: string; priority: "high" | "medium" | "low";
  /** The change that does it, through the admin API (the dashboard applies it; the assistant proposes it). */
  action: { method: "POST" | "PUT" | "PATCH"; path: string; body: unknown; label: string } | null;
}

const family = (id: string) => id.split("/").pop()!.split(/[-_.]/)[0].toLowerCase();

/** Which use case (and priority) judges each route. */
export const ROUTE_CASES: Record<string, [UseCase, "quality" | "balanced" | "speed"]> = {
  agent: ["agent", "balanced"], fast: ["fast", "speed"], smart: ["reasoning", "quality"], code: ["code", "balanced"],
  multilingual: ["danish", "balanced"], danish: ["danish", "balanced"], vision: ["vision", "balanced"], embed: ["rag", "balanced"],
};

export async function insights(): Promise<{ insights: Insight[]; trending: ReturnType<typeof trendingNotInCatalog>; generated: number }> {
  const out: Insight[] = [];
  const routes = listRoutes();
  const cache = new Map<string, Advice[]>();
  const rank = async (uc: UseCase, p: "quality" | "balanced" | "speed") => { const k = `${uc}/${p}`; if (!cache.has(k)) cache.set(k, (await advise(uc, p)).ranked); return cache.get(k)!; };

  for (const r of routes) {
    const judge = ROUTE_CASES[r.name];
    if (!judge || !r.candidates.length) continue;
    const ranked = await rank(...judge);
    const usable = ranked.filter((a) => a.installed && a.modelId && a.fit !== "too-big" && getModel(a.modelId)?.enabled);
    const first = ranked.find((a) => a.onRoutes.some((o) => o.route === r.name && o.position === 1));
    const best = usable[0];
    // Promote: an installed model this route's job ranks clearly higher than the one tried first — and that mux has
    // seen work (a benchmark or real traffic), so a promotion is never on estimates alone.
    if (best && first && best.id !== first.id && best.score - first.score >= 0.5 && (best.measured || (best.usage?.requests ?? 0) >= 20)) {
      out.push({ kind: "promote", priority: best.score - first.score >= 1.5 ? "high" : "medium",
        title: `Put ${best.name} first on ${r.name}`,
        detail: `For ${USE_CASES[judge[0]].label.toLowerCase()} it scores ${best.score.toFixed(1)} against ${first.name}'s ${first.score.toFixed(1)}. ${best.reasons.filter((x) => /measured|requests|failed/.test(x)).join("; ")}`.trim(),
        action: { method: "POST", path: "/experiments", body: { route: r.name, challenger: best.modelId, share: 0.1 }, label: `A/B test on ${r.name}` } });
    }
    // Try: a model not here yet that would beat the best one here by a clear margin, and fits.
    const fresh = ranked.find((a) => !a.installed && a.fit === "fits" && a.diskOk);
    if (fresh && fresh.score - (best?.score ?? 0) >= 0.7) {
      out.push({ kind: "try", priority: "medium", title: `Try ${fresh.name} for ${r.name}`,
        detail: `Estimated ${fresh.score.toFixed(1)} for ${USE_CASES[judge[0]].label.toLowerCase()}, against ${best ? `${best.name}'s ${best.score.toFixed(1)}` : "nothing installed"}. ${fresh.sizeGb.toFixed(1)} GB to download, ~${fresh.needGb} GB in memory. Download it, benchmark it, and the advisor will rank it on what it measures.`,
        action: { method: "POST", path: "/downloads", body: { catalogId: fresh.id }, label: `Download ${fresh.sizeGb.toFixed(1)} GB` } });
    }
  }

  // Demote: a model tried first on a route that fails often in real use — every kind, speech included. The next
  // candidate answers instead while someone finds the cause (the healer and Lens look at why).
  for (const r of routes.filter((x) => x.candidates.length)) {
    const u = usageOf([r.candidates[0]]);
    if (!u || u.requests < 10 || u.errorRate < 0.1) continue;
    if (r.candidates.length === 1) {
      // Nothing to fall back to: offer the most reliable other model of the same kind that has real traffic.
      const kind = getModel(r.candidates[0])?.kind;
      const alt = listModels().filter((m) => m.enabled && m.kind === kind && m.id !== r.candidates[0])
        .map((m) => ({ m, u: usageOf([m.id]) })).filter((x) => x.u && x.u.requests >= 10 && x.u.errorRate < u.errorRate)
        // The same family (whisper → whisper-turbo) does the same job; another one may be a specialist (a Danish-only
        // model behind a route for every language). Error rates cannot tell, so family counts for 5 points of them.
        .sort((a, b) => (a.u!.errorRate - (family(a.m.id) === family(r.candidates[0]) ? 0.05 : 0)) - (b.u!.errorRate - (family(b.m.id) === family(r.candidates[0]) ? 0.05 : 0)))[0];
      out.push({ kind: "promote", priority: "high", title: `${r.candidates[0]} fails ${(u.errorRate * 100).toFixed(0)}% of its requests, alone on ${r.name}`,
        detail: `${u.errors} of ${u.requests} requests failed in 30 days, with no other model on ${r.name} to answer instead.${alt ? ` ${alt.m.id} failed ${(alt.u!.errorRate * 100).toFixed(1)}% of ${alt.u!.requests}: add it behind as a fallback.` : " Add a second model to the route."} And find out why (its log, or ask the assistant).`,
        action: alt ? { method: "POST", path: "/experiments", body: { route: r.name, challenger: alt.m.id, share: 0.5 }, label: `A/B test ${alt.m.id}` } : null });
      continue;
    }
    out.push({ kind: "promote", priority: "high", title: `${r.candidates[0]} fails ${(u.errorRate * 100).toFixed(0)}% of its requests, first on ${r.name}`,
      detail: `${u.errors} of ${u.requests} requests failed in 30 days. Move it to the back of ${r.name}, so ${r.candidates[1]} answers first, and find out why (its log, or ask the assistant).`,
      action: { method: "POST", path: "/experiments", body: { route: r.name, challenger: r.candidates[1], share: 0.5 }, label: `A/B test ${r.candidates[1]}` } });
  }

  // Measure: models in use or on a route with no benchmark, or one older than two weeks.
  const benched = new Map((db.prepare("SELECT model_id, MAX(ts) ts FROM benchmarks WHERE status = 'done' GROUP BY model_id").all() as { model_id: string; ts: number }[]).map((b) => [b.model_id, b.ts]));
  const onAnyRoute = new Set(routes.flatMap((r) => r.candidates));
  for (const m of listModels().filter((x) => x.enabled && (x.kind === "chat" || x.kind === "embedding") && x.backend !== "external" && x.backend !== "jev")) {
    const ts = benched.get(m.id);
    const used = usageOf([m.id]);
    if ((!ts || now() - ts > 14 * 86400_000) && (onAnyRoute.has(m.id) || used)) {
      out.push({ kind: "measure", priority: used && used.requests > 100 ? "medium" : "low", title: `Benchmark ${m.id}`,
        detail: `${ts ? `Last benchmarked ${Math.round((now() - ts) / 86400_000)} days ago` : "Never benchmarked here"}${used ? `, yet it answered ${used.requests.toLocaleString()} requests in 30 days` : ""}. A benchmark turns the advisor's estimate into a measurement (tool calls, JSON, Danish, code, speed).`,
        action: { method: "POST", path: "/benchmarks", body: { model: m.id }, label: "Benchmark" } });
    }
  }

  // Retire: a model of this machine that nothing used in 30 days and no route lists — it holds disk, and a slot in the choice.
  for (const m of listModels().filter((x) => x.enabled && !x.pinned && ["llamacpp", "mlx"].includes(x.backend) && !onAnyRoute.has(x.id))) {
    if (usageOf([m.id])) continue;
    out.push({ kind: "retire", priority: "low", title: `Retire ${m.id}`,
      detail: `No requests in 30 days and on no route${m.size_bytes ? `; it takes ${(m.size_bytes / GB).toFixed(1)} GB of disk` : ""}. Disabling keeps the files (delete them on Models when sure).`,
      action: { method: "PATCH", path: `/models/${encodeURIComponent(m.id)}`, body: { enabled: false }, label: "Disable" } });
  }

  // Watch: what is rising on Hugging Face that the catalog does not know yet.
  const trending = trendingNotInCatalog();
  const order = { high: 0, medium: 1, low: 2 }, kinds = { promote: 0, try: 1, measure: 2, retire: 3, watch: 4 };
  out.sort((a, b) => order[a.priority] - order[b.priority] || kinds[a.kind] - kinds[b.kind]);
  return { insights: out, trending, generated: now() };
}
