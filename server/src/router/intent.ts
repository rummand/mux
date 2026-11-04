import { settings } from "../db.js";
import { getModel, listRoutes, type Route } from "../models.js";
import { acquire, release } from "../runtime/manager.js";

/**
 * Intent routing: Arch-Router (Katanemo, 1.5B) reads the conversation and picks the route whose description fits the
 * user's latest intent — code, an agent with tools, Danish for a customer, a quick answer, the best answer. It decides
 * for requests on a route whose strategy is "auto", once per user turn: the tool calls of an agent loop reuse the
 * turn's decision, and affinity (affinity.ts) keeps the run on its model. If the router says "other", names no route,
 * or takes longer than its budget, the auto route's own scoring decides, as before (the owner, 2026-11-04).
 *
 * The router model is set by intentRouterModel: "arch-router" on the Mac, "mac-studio/arch-router" on a gateway. It
 * answers no chat itself (select.ts leaves it out of every route's pool).
 */
const BUDGET_MS = 2000;
const TTL = 30 * 60_000;
type Msg = { role: string; content?: unknown };

const TASK = `
You are a helpful assistant designed to find the best suited route.
You are provided with route description within <routes></routes> XML tags:
<routes>

{routes}

</routes>

<conversation>

{conversation}

</conversation>
`;
const FORMAT = `
Your task is to decide which route is best suit with user intent on the conversation in <conversation></conversation> XML tags.  Follow the instruction:
1. If the latest intent from user is irrelevant or user intent is full filled, response with other route {"route": "other"}.
2. You must analyze the route descriptions and find the best match route for user latest intent. 
3. You only response the name of the route that best matches the user's request, use the exact name in the <routes></routes>.

Based on your analysis, provide your response in the following JSON formats if you decide to match any route:
{"route": "route_name"} 
`;

const textOf = (c: unknown): string =>
  typeof c === "string" ? c : Array.isArray(c) ? c.map((p) => (typeof p === "string" ? p : (p as { text?: string })?.text ?? "")).join(" ") : "";
/** Long text kept as its start and end (60/40), as Plano does: what a message is about is usually in both. */
const trim = (s: string, n: number) => (s.length <= n ? s : `${s.slice(0, Math.floor(n * 0.6))} … ${s.slice(s.length - Math.floor(n * 0.4))}`);

/**
 * What belongs on mux's standard routes, as Arch-Router reads it: kinds of requests, not what the route is made of.
 * Measured 2026-11-04 on the Mac: 10 of 12 sample requests to the right route, against 4 of 7 with the routes' own
 * descriptions. A route's own `intent` replaces these.
 */
export const DEFAULT_INTENTS: Record<string, string> = {
  agent: "Carrying out tasks with tools for the user: booking, scheduling, sending messages or invites, looking things up in systems, multi-step actions and workflows",
  code: "Programming: writing, explaining, reviewing, debugging or fixing code, SQL queries, scripts, error messages and stack traces",
  fast: "Quick simple tasks with short answers: classify, label, extract fields, yes/no, sentiment, short factual lookups, reformatting",
  multilingual: "Requests written in Danish or another non-English language, translation, and writing replies or texts for customers",
  smart: "Hard questions needing deep reasoning and long careful answers: analysis, comparisons, strategy, math, research, explaining complex topics",
};
export const intentOf = (r: Route) => r.intent?.trim() || DEFAULT_INTENTS[r.name] || r.description.trim();

/** The routes Arch-Router chooses among: chat routes it has words for, other than auto itself, System One and vision. */
export function choices(): Route[] {
  return listRoutes().filter((r) => r.kind === "chat" && r.strategy !== "auto" && r.name !== "systemone" && r.name !== "vision" && intentOf(r));
}

/** The conversation as the router reads it: the last turns of user and assistant text, each trimmed. */
export function conversation(msgs: Msg[]): { role: string; content: string }[] {
  return msgs.filter((m) => m.role === "user" || m.role === "assistant").map((m) => ({ role: m.role, content: trim(textOf(m.content).replace(/\s+/g, " ").trim(), 1200) }))
    .filter((m) => m.content).slice(-6);
}

export function prompt(routes: Route[], convo: { role: string; content: string }[]): string {
  return TASK.replace("{routes}", JSON.stringify(routes.map((r) => ({ name: r.name, description: intentOf(r) })))).replace("{conversation}", JSON.stringify(convo)) + FORMAT;
}

/** {"route": "code"} — or {'route': 'code'}, as the GGUF build answers — → "code"; anything else → null. */
export function parse(text: string, names: Set<string>): string | null {
  const m = /["']route["']\s*:\s*["']([^"']+)["']/.exec(text);
  const name = m?.[1]?.trim();
  return name && names.has(name) ? name : null;
}

// Per run and user turn: the turn's decision, reused by its tool calls
const decided = new Map<string, { route: string | null; at: number }>();
const stats = { asked: 0, routed: 0, other: 0, failed: 0, ms: [] as number[], byRoute: {} as Record<string, number>, lastError: null as string | null };
export const intentStats = () => {
  const ms = [...stats.ms].sort((a, b) => a - b);
  return { model: settings().intentRouterModel || null, asked: stats.asked, routed: stats.routed, other: stats.other, failed: stats.failed, byRoute: stats.byRoute,
    p50Ms: ms.length ? ms[Math.floor(ms.length / 2)] : null, p95Ms: ms.length ? ms[Math.min(ms.length - 1, Math.floor(ms.length * 0.95))] : null, lastError: stats.lastError };
};

/** The route for this request by its intent, or null to let the auto route's scoring decide. */
export async function intentRoute(msgs: Msg[], affinity: string | null, vision: boolean): Promise<{ route: string; why: string } | null> {
  const id = settings().intentRouterModel;
  if (!id) return null;
  // Arch-Router reads text only: images go where images are read.
  if (vision) return listRoutes().some((r) => r.name === "vision" && r.candidates.length) ? { route: "vision", why: "intent: vision (images)" } : null;
  const turn = msgs.filter((m) => m.role === "user").length;
  const key = affinity ? `${affinity}|${turn}` : null;
  const cached = key ? decided.get(key) : undefined;
  if (cached && Date.now() - cached.at < TTL) return cached.route ? { route: cached.route, why: `intent: ${cached.route} (this turn's decision)` } : null;

  const m = getModel(id);
  const routes = choices();
  const convo = conversation(msgs);
  if (!m || !m.enabled || routes.length < 2 || !convo.length) return null;
  stats.asked++;
  const t0 = Date.now();
  let up: Awaited<ReturnType<typeof acquire>> | null = null;
  try {
    up = await acquire(m);
    const r = await fetch(`${up.baseUrl}/chat/completions`, {
      method: "POST", headers: { "content-type": "application/json", ...up.headers }, signal: AbortSignal.timeout(BUDGET_MS),
      body: JSON.stringify({ model: up.model, temperature: 0, max_tokens: 24, messages: [{ role: "user", content: prompt(routes, convo) }] }),
    });
    if (!r.ok) throw new Error(`${r.status} ${(await r.text()).slice(0, 120)}`);
    const j = (await r.json()) as { choices?: { message?: { content?: string } }[] };
    const route = parse(j.choices?.[0]?.message?.content ?? "", new Set(routes.map((x) => x.name)));
    const ms = Date.now() - t0;
    stats.ms.push(ms); if (stats.ms.length > 500) stats.ms.shift();
    if (route) { stats.routed++; stats.byRoute[route] = (stats.byRoute[route] ?? 0) + 1; } else stats.other++;
    if (key) { decided.set(key, { route, at: Date.now() }); if (decided.size > 20_000) decided.delete(decided.keys().next().value!); }
    return route ? { route, why: `intent: ${route} (${id}, ${ms} ms)` } : null;
  } catch (e) {
    stats.failed++; stats.lastError = `${new Date().toISOString()} ${(e as Error).message}`.slice(0, 200);
    return null;
  } finally {
    if (up) release(m.id);
  }
}
