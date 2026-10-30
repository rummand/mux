import { getModel, getRoute, listModels, type Kind, type Model, type Route } from "../models.js";
import type { Tenant } from "../tenants.js";
import { isLoaded } from "../runtime/manager.js";
import { inCooldown, measuredTps } from "./health.js";
import { loadedOnNode, providerUp } from "../providers.js";

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

export interface Decision { route: Route | null; candidates: Model[]; reason: string; requested: string }

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
function unfit(m: Model, f: Features): string | null {
  if (!m.enabled) return "disabled";
  if (!providerUp(m.provider_id)) return "provider offline";
  if (inCooldown(m.id)) return "cooling down after failures";
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
  if (m.cost_in || m.cost_out) s -= 3;
  return s;
}

const describe = (f: Features) => [f.tools && (f.forcedTool ? "forced tool" : "tools"), f.code && "code", f.reasoning && "reasoning", f.danish && "danish", f.vision && "vision", f.json && "json", f.simple && "simple", `~${f.inputTokens} tok`].filter(Boolean).join("+");

/** The models to try, best first, and why. */
export function decide(tenant: Tenant, requested: string | undefined, kind: Kind, f: Features | null): Decision {
  const { route, model, via } = resolve(tenant, requested, kind);
  const feats = f ?? features({});
  if (model) {
    // A model asked for by name is tried first; the tenant's default route stands behind it.
    const def = getRoute(kind === "chat" ? tenant.default_route || "auto" : kind === "embedding" ? "embed" : kind);
    const backups = (def?.candidates ?? []).filter((id) => id !== model.id).map(getModel).filter((m): m is Model => !!m && m.kind === kind && !unfit(m, feats));
    return { route: null, candidates: [model, ...backups], reason: [via, `model ${model.id}`].filter(Boolean).join("; "), requested: requested ?? "" };
  }
  const r = route!;
  const pool = (r.candidates.length ? r.candidates.map(getModel) : listModels().filter((m) => m.kind === kind)).filter((m): m is Model => !!m && m.kind === kind);
  const skipped: string[] = [];
  const fit = pool.filter((m) => { const why = unfit(m, feats); if (why) skipped.push(`${m.id}: ${why}`); return !why; });
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
  const reason = [via, `route ${r.name}: ${how}`, skipped.length ? `skipped ${skipped.join("; ")}` : ""].filter(Boolean).join("; ");
  if (!ordered.length) throw new RouteError(`route ${r.name} has no model that can take this request${skipped.length ? ` (${skipped.join("; ")})` : ""}`, 503, "no_capable_model");
  return { route: r, candidates: ordered, reason, requested: requested ?? "" };
}
