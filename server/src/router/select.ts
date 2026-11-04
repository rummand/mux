import { getModel, getRoute, listModels, type Kind, type Model, type Route } from "../models.js";
import type { Tenant } from "../tenants.js";
import { isLoaded, loadOf } from "../runtime/manager.js";
import { inCooldown, measuredTps } from "./health.js";
import { loadedOnNode, presenceOf, providerUp } from "../providers.js";
import { restingReason } from "../presence.js";
import { outside } from "./border.js";
import { split } from "../experiments.js";
import { freePlan, quotaBlock } from "../quota.js";
import { settings } from "../db.js";
import { stick, stuck } from "./affinity.js";

/** What a request needs, read from the request itself. */
export interface Features {
  inputTokens: number; maxTokens: number; tools: boolean; forcedTool: boolean; vision: boolean;
  code: boolean; reasoning: boolean; danish: boolean; json: boolean; simple: boolean;
}

interface ChatLike {
  messages?: { role: string; content?: unknown }[];
  tools?: unknown[]; tool_choice?: unknown; max_tokens?: number; max_completion_tokens?: number;
  response_format?: { type?: string }; reasoning_effort?: string;
}

const textOf = (c: unknown): string =>
  typeof c === "string" ? c : Array.isArray(c) ? c.map((p) => (typeof p === "string" ? p : (p as { text?: string })?.text ?? "")).join(" ") : "";

export function features(body: ChatLike): Features {
  const msgs = body.messages ?? [];
  const all = msgs.map((m) => textOf(m.content)).join("\n");
  const last = textOf([...msgs].reverse().find((m) => m.role === "user")?.content);
  const vision = msgs.some((m) => Array.isArray(m.content) && m.content.some((p) => (p as { type?: string })?.type === "image_url"));
  const toolsJson = body.tools?.length ? JSON.stringify(body.tools).length : 0;
  const inputTokens = Math.ceil((all.length + toolsJson) / 3.5);
  const code = /```|\bdef |\bfunction\b|\bclass \w|=>|\bconst |\bimport |SELECT .+ FROM|Traceback|\.(ts|js|py|go|rs|java|sql|tsx)\b|stack trace/i.test(last || all.slice(-4000));
  const reasoning = !!body.reasoning_effort && body.reasoning_effort !== "none" || /step[- ]by[- ]step|\bprove\b|\bderive\b|\bcalculate\b|\bplan\b|trin for trin|beregn|ræsonn/i.test(last);
  // Danish: its letters, or two of its commonest small words (which English rarely has, Norwegian often shares).
  const danish = /[æøå]/i.test(last) || new Set(last.toLowerCase().match(/\b(og|ikke|jeg|mig|min|mit|du|dig|det|hvad|hvordan|hvorfor|hvornår|hvis|skal|kan|vil|til|med|af|også|nu|lige|tak|hej)\b/g) ?? []).size >= 2;
  const tools = !!body.tools?.length && body.tool_choice !== "none";
  const forcedTool = tools && (body.tool_choice === "required" || typeof body.tool_choice === "object");
  const json = body.response_format?.type === "json_object" || body.response_format?.type === "json_schema";
  const maxTokens = body.max_completion_tokens ?? body.max_tokens ?? 1024;
  return { inputTokens, maxTokens, tools, forcedTool, vision, code, reasoning, danish, json, simple: !tools && !code && !reasoning && !vision && inputTokens < 600 && maxTokens <= 1024 };
}

export interface Decision { route: Route | null; candidates: Model[]; reason: string; requested: string; experiment?: { id: string; arm: "A" | "B" }; sticky?: boolean }

export class RouteError extends Error {
  constructor(message: string, public status = 404, public type = "model_not_found") { super(message); }
}

const allowed = (t: Tenant, name: string) => !t.allowed.length || t.allowed.includes(name);

/** The route or model a request's `model` names, after the tenant's aliases; unknown names go to the tenant's default. */
export function resolve(tenant: Tenant, requested: string | undefined, kind: Kind): { route: Route | null; model: Model | null; via: string } {
  const asked = (requested ?? "").trim();
  const name = tenant.aliases[asked] ?? asked;
  const via = name !== asked ? `alias ${asked} → ${name}` : "";
  const named = name.replace(/^mux\//, "");
  const route = getRoute(named);
  if (route && route.kind === kind) {
    if (!allowed(tenant, route.name)) throw new RouteError(`this key may not use route ${route.name}`, 403, "permission_denied");
    return { route, model: null, via };
  }
  const model = getModel(named);
  if (model && model.kind === kind) {
    if (!allowed(tenant, model.id)) throw new RouteError(`this key may not use model ${model.id}`, 403, "permission_denied");
    return { route: null, model, via };
  }
  // A bare name of a model a provider has ("qwen3.6-35b-a3b" for "mac-studio/qwen3.6-35b-a3b"): the one that is up.
  const remote = listModels().filter((m) => m.kind === kind && m.upstream_model === named && m.provider_id && allowed(tenant, m.id));
  const pick = remote.find((m) => providerUp(m.provider_id)) ?? remote[0];
  if (pick) return { route: null, model: pick, via: `${named} → ${pick.id}` };
  // Anything else — "gpt-4o", "claude-sonnet-4-5", "" — is the tenant's default for that kind, so a SaaS written for a
  // hosted API works by changing only its base URL and key.
  const fallback = kind === "embedding" ? "embed" : kind === "rerank" ? "rerank" : kind === "systemone" ? "systemone"
    : kind === "transcription" ? "transcribe" : kind === "speech" ? "speak" : tenant.default_route || "auto";
  const def = getRoute(fallback);
  if (!def) throw new RouteError(`no route ${fallback} for ${asked || "(no model)"}; create it on the Routes page`);
  return { route: def, model: null, via: asked ? `${asked} is not a mux route or model → ${tenant.id}'s default ${def.name}` : `default ${def.name}` };
}

/** In memory and ready: here, on its node, or a cloud API (always ready). */
export const warm = (m: Model) => isLoaded(m.id) || m.backend === "external" || m.backend === "jev" || (m.backend === "node" && !!m.provider_id && loadedOnNode(m.provider_id, m.upstream_model ?? ""));

const cap = (m: Model, k: keyof Model["caps"], d = 5) => m.caps[k] ?? d;

/** Can this model take the request at all? The reason when not. */
function unfit(m: Model, f: Features, t?: Tenant): string | null {
  if (!m.enabled) return "disabled";
  const border = outside(t?.data_border, m);
  if (border) return border;
  const quota = quotaBlock(m);
  if (quota) return quota;
  if (!providerUp(m.provider_id)) return "provider offline";
  if (inCooldown(m.id)) return "cooling down after failures";
  // Presence: a machine with someone at it, or turned off, takes less or nothing (presence.ts).
  const pr = m.backend === "node" ? presenceOf(m.provider_id) : null;
  if (pr?.state === "away" || pr?.state === "busy") return `node ${pr.state} (${pr.reasons.join(", ")})`;
  if (pr?.state === "polite" && !warm(m)) return `node polite (${pr.reasons.join(", ")}): only loaded models`;
  if (["llamacpp", "mlx", "laya"].includes(m.backend)) { const r = restingReason(m.id, isLoaded(m.id)); if (r) return r; }
  if (f.vision && !(m.mmproj || cap(m, "vision", 0) > 0)) return "no vision";
  if (m.kind === "chat" && f.inputTokens + Math.min(f.maxTokens, 4096) > m.ctx) return `context ${m.ctx} too small for ~${f.inputTokens} tokens`;
  return null;
}

function score(m: Model, f: Features): number {
  let s = cap(m, "quality") * 1.0;
  if (f.simple) s += cap(m, "speed") * 1.6; else s += cap(m, "speed") * 0.5;
  if (f.tools) s += cap(m, "tools") * 1.6;
  if (f.code) s += cap(m, "code") * 1.6;
  if (f.reasoning) s += cap(m, "reasoning") * 1.3;
  if (f.danish) s += cap(m, "multilingual") * 1.3;
  if (f.vision) s += cap(m, "vision", 0) * 1.5;
  if (f.inputTokens > 16000) s += cap(m, "context") * 0.8;
  // A model already in memory answers now; a cold one pays its load first. Paid models are the fallback, not the
  // first choice, unless the request needs what only they have.
  s += warm(m) ? 4 : -Math.min(4, m.size_bytes / 1024 ** 3 / 8);
  if (m.cost_in || m.cost_out || freePlan(m)) s -= 3; // paid, or a free tier's quota: the cloud is the fallback
  // By the kind of machine: a server first, a laptop last; a polite machine (someone is there) after a free one.
  const pr = m.backend === "node" ? presenceOf(m.provider_id) : null;
  if (pr?.class === "always-on") s += 1;
  if (pr?.class === "laptop") s -= 1.5;
  if (pr?.state === "polite") s -= 2;
  // Burst: a model whose slots are all taken makes the next request wait; past a queue of a couple, a model elsewhere
  // — another node, or a paid API if the tenant's border allows one — answers sooner.
  s -= Math.min(8, waiting(m) * 2.5);
  return s;
}

/** How many requests a new one would wait behind: on this machine now, on a node as of its last report (≤ 5 s). */
export function waiting(m: Model): number {
  const l = ["llamacpp", "mlx", "laya"].includes(m.backend) ? loadOf(m.id) : m.backend === "node" ? presenceOf(m.provider_id)?.load?.[m.upstream_model ?? ""] ?? null : null;
  return l && l.inflight >= l.slots ? l.inflight - l.slots + 1 : 0;
}

const describe = (f: Features) => [f.tools && (f.forcedTool ? "forced tool" : "tools"), f.code && "code", f.reasoning && "reasoning", f.danish && "danish", f.vision && "vision", f.json && "json", f.simple && "simple", `~${f.inputTokens} tok`].filter(Boolean).join("+");

/** Arch-Router, here or on a node: it picks routes, it does not answer. */
export const isRouterModel = (m: Model, router = settings().intentRouterModel) =>
  m.id === router || /arch-router/i.test(m.id) || /arch-router/i.test(m.upstream_model ?? "");

/** The models to try, best first, and why. */
export function decide(tenant: Tenant, requested: string | undefined, kind: Kind, f: Features | null, affinity?: string | null): Decision {
  const { route, model, via } = resolve(tenant, requested, kind);
  const feats = f ?? features({});
  if (model) {
    // A tenant's data border holds even for a model named outright.
    const border = outside(tenant.data_border, model);
    if (border) throw new RouteError(`${model.id} is ${border}`, 403, "data_border");
    // A model asked for by name is tried first; the tenant's default route stands behind it.
    const def = getRoute(kind === "chat" ? tenant.default_route || "auto" : kind === "embedding" ? "embed" : kind);
    const backups = (def?.candidates ?? []).filter((id) => id !== model.id).map(getModel).filter((m): m is Model => !!m && m.kind === kind && !unfit(m, feats, tenant));
    const rescue = rescueModels(kind, feats, tenant, [model, ...backups]);
    return { route: null, candidates: [model, ...backups, ...rescue], reason: [via, `model ${model.id}`, rescue.length ? `rescue: ${rescue.map((m) => m.id).join(", ")}` : ""].filter(Boolean).join("; "), requested: requested ?? "" };
  }
  const r = route!;
  // A route that lists no models takes every model of its kind — but not a free tier's: those answer only when named,
  // or as the rescue below.
  // The intent router answers no chat itself
  const router = settings().intentRouterModel;
  const pool = (r.candidates.length ? r.candidates.map(getModel) : listModels().filter((m) => m.kind === kind && !freePlan(m))).filter((m): m is Model => !!m && m.kind === kind && !isRouterModel(m, router));
  const skipped: string[] = [];
  const fit = pool.filter((m) => { const why = unfit(m, feats, tenant); if (why) skipped.push(`${m.id}: ${why}`); return !why; });
  let ordered = fit;
  let how: string = r.strategy;
  if (r.strategy === "auto") {
    const scored = fit.map((m) => ({ m, s: score(m, feats) })).sort((a, b) => b.s - a.s);
    ordered = scored.map((x) => x.m);
    how = `auto (${describe(feats)}) → ${scored.slice(0, 3).map((x) => `${x.m.id} ${x.s.toFixed(1)}`).join(", ")}`;
  } else if (r.strategy === "fastest") {
    const tps = (m: Model) => (measuredTps(m.id) ?? cap(m, "speed") * 8) + (warm(m) ? 1000 : 0);
    ordered = [...fit].sort((a, b) => tps(b) - tps(a));
  } else if (r.strategy === "quality") {
    ordered = [...fit].sort((a, b) => cap(b, "quality") - cap(a, "quality"));
  }
  // An experiment on this route splits its traffic: arm B tries the challenger first, arm A the champion.
  const sp = split(r.name, ordered, affinity);
  if (sp) ordered = sp.candidates;
  // Affinity: a run stays on the model it started on — while that model can still take it and has no queue to speak of.
  let sticky = false;
  if (affinity && ordered.length > 1) {
    const prev = stuck(affinity, r.name);
    const m = prev ? ordered.find((x) => x.id === prev) : undefined;
    if (m && m !== ordered[0] && waiting(m) < 2) { ordered = [m, ...ordered.filter((x) => x !== m)]; sticky = true; }
    else if (m === ordered[0]) sticky = true;
  }
  if (affinity && ordered[0]) stick(affinity, r.name, ordered[0].id);
  // Free tiers, last: they answer when everything of ours failed or is out.
  const rescue = rescueModels(kind, feats, tenant, ordered);
  ordered = [...ordered, ...rescue];
  if (rescue.length) skipped.push(`rescue if all fail: ${rescue.map((m) => m.id).join(", ")}`);
  const reason = [via, `route ${r.name}: ${how}`, sp ? `experiment ${sp.experiment.id}, arm ${sp.experiment.arm}` : "", sticky ? `kept on ${ordered[0].id} for this run` : "", skipped.length ? `skipped ${skipped.join("; ")}` : ""].filter(Boolean).join("; ");
  if (!ordered.length) throw new RouteError(`route ${r.name} has no model that can take this request${skipped.length ? ` (${skipped.join("; ")})` : ""}`, 503, "no_capable_model");
  return { route: r, candidates: ordered, reason, requested: requested ?? "", ...(sp ? { experiment: sp.experiment } : {}), ...(sticky ? { sticky } : {}) };
}

/**
 * The free-tier models that may answer when a request's own candidates all fail or are out: same kind, inside the
 * tenant's data border and their quotas, able to do what the request needs, from providers that do not train on
 * free-tier prompts (unless freeRescueTraining allows those). The best three, by quality.
 */
export function rescueModels(kind: Kind, f: Features, tenant: Tenant, already: Model[]): Model[] {
  const s = settings();
  if (!s.freeRescue) return [];
  const have = new Set(already.map((m) => m.id));
  return listModels()
    .filter((m) => m.kind === kind && !have.has(m.id))
    .filter((m) => { const p = freePlan(m); return !!p && (s.freeRescueTraining || p.trainsOnData === false); })
    .filter((m) => !unfit(m, f, tenant) && (!f.tools || cap(m, "tools") >= 5))
    // Embeddings only from the same model: another model's vectors would not match the tenant's stored ones.
    .filter((m) => kind !== "embedding" || (!!already[0] && baseName(m) === baseName(already[0])))
    .sort((a, b) => cap(b, "quality") - cap(a, "quality"))
    .slice(0, 3);
}

/** A model's own name, without its host's prefixes: "ovh/bge-m3", "@cf/baai/bge-m3" and "bge-m3" are one model. */
const baseName = (m: Model) => (m.upstream_model || m.id).split("/").pop()!.toLowerCase().replace(/[-_.]?(gguf|q\d.*|f16|bf16)$/i, "");
