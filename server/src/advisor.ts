import { CATALOG, type CatalogEntry } from "./catalog.js";
import { db, settings } from "./db.js";
import { listModels, type Caps } from "./models.js";
import { systemStats } from "./runtime/system.js";

/**
 * Which model to run for what, on this Mac. Each use case weighs the capabilities it needs; the result is ranked by
 * that, by whether the model fits mux's memory budget and the disk, and by what benchmarks on this Mac measured.
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

export interface Advice {
  id: string; name: string; family: string; kind: string; sizeGb: number; needGb: number; params: string; activeParams?: string; license: string;
  installed: boolean; modelId: string | null; fit: "fits" | "tight" | "too-big"; diskOk: boolean; score: number; caps: Caps;
  measured: { score: number; tps: number; ttftMs: number } | null; reasons: string[]; notes: string; routes: string[]; repo: string; file: string; released: string;
}

export async function advise(useCase: UseCase, priority: "quality" | "balanced" | "speed" = "balanced"): Promise<{ useCase: string; budgetGb: number; diskFreeGb: number; memTotalGb: number; ranked: Advice[] }> {
  const s = settings();
  const sys = await systemStats();
  const installed = listModels();
  const w = { ...USE_CASES[useCase].w } as Record<string, number>;
  if (priority === "quality") w.quality = (w.quality ?? 0) + 1.2;
  if (priority === "speed") w.speed = (w.speed ?? 0) + 1.2;
  const wantEmbedding = useCase === "rag";
  const entries: CatalogEntry[] = CATALOG.filter((c) => (wantEmbedding ? c.kind === "embedding" : c.kind === "chat"));
  const ranked = entries.map((c): Advice => {
    const mine = installed.find((m) => m.catalog_id === c.id || m.id === c.id);
    const need = needGb(c.sizeGb, c.defaultCtx, c.kind === "embedding");
    const fit = need <= s.memoryBudgetGb * 0.6 ? "fits" : need <= s.memoryBudgetGb ? "tight" : "too-big";
    const diskOk = !!mine || sys.diskFreeGb - c.sizeGb >= s.diskReserveGb;
    const bench = mine ? latestBench(mine.id) : undefined;
    const caps: Caps = { ...c.caps };
    // A benchmark on this Mac beats the catalog's estimate: speed from measured tokens a second, quality from the pass rate.
    if (bench?.tps) caps.speed = Math.min(10, Math.max(1, bench.tps / 10));
    if (bench?.score != null) caps.quality = (caps.quality ?? 5) * 0.5 + bench.score * 10 * 0.5;
    let score = Object.entries(w).reduce((a, [k, v]) => a + (caps[k as keyof Caps] ?? 0) * v, 0) / Object.values(w).reduce((a, v) => a + v, 0);
    const reasons: string[] = [];
    if (fit === "too-big") { score -= 4; reasons.push(`needs ~${need} GB, over mux's ${s.memoryBudgetGb} GB budget`); }
    else if (fit === "tight") { score -= 0.8; reasons.push(`~${need} GB: fits, but leaves little room for other models`); }
    else reasons.push(`~${need} GB in memory`);
    if (!diskOk) { score -= 3; reasons.push(`${c.sizeGb} GB download won't fit the ${sys.diskFreeGb.toFixed(0)} GB free disk with the reserve`); }
    if (mine) { score += 0.3; reasons.push("already on this Mac"); }
    if (c.activeParams) reasons.push(`MoE: ${c.activeParams} active of ${c.params} — fast for its size`);
    const top = Object.entries(w).sort((a, b) => b[1] - a[1])[0][0] as keyof Caps;
    reasons.push(`${top} ${caps[top] ?? "?"}/10`);
    if (bench) reasons.push(`measured here: ${bench.tps?.toFixed(0)} tok/s, ${(bench.score * 100).toFixed(0)}% of checks passed`);
    return {
      id: c.id, name: c.name, family: c.family, kind: c.kind, sizeGb: c.sizeGb, needGb: need, params: c.params, activeParams: c.activeParams, license: c.license,
      installed: !!mine, modelId: mine?.id ?? null, fit, diskOk, score: Math.round(score * 100) / 100, caps,
      measured: bench ? { score: bench.score, tps: bench.tps, ttftMs: bench.ttft_ms } : null, reasons, notes: c.notes, routes: c.routes, repo: c.repo, file: c.file, released: c.released,
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
