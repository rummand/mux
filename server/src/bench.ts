import { randomBytes } from "node:crypto";
import { EventEmitter } from "node:events";
import { db, event, now } from "./db.js";
import { getModel, type Model } from "./models.js";
import { acquire, release } from "./runtime/manager.js";
import { sse } from "./router/chat.js";
import { countRequest, freePlan } from "./quota.js";
import { journal } from "./journal.js";

/**
 * A benchmark run on this Mac: speed (time to first token, generation and prompt tokens a second) and a handful of
 * checks that matter for SaaS agents — following an exact instruction, JSON, a tool call, arithmetic, Danish, code.
 * The advisor ranks with its results; the Models page charts them.
 */
export const benchBus = new EventEmitter();

interface Check { name: string; pass: boolean; ms: number; detail: string }
type Msg = { role: string; content: string };

async function complete(base: string, model: string, headers: Record<string, string>, body: Record<string, unknown>) {
  const t0 = performance.now();
  const r = await fetch(`${base}/chat/completions`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify({ model, temperature: 0, ...body }), signal: AbortSignal.timeout(180_000) });
  if (!r.ok) throw new Error(`${r.status} ${(await r.text()).slice(0, 200)}`);
  const j = (await r.json()) as { choices: { message: { content?: string; tool_calls?: { function: { name: string; arguments: string } }[] } }[]; timings?: { prompt_per_second?: number; predicted_per_second?: number } };
  return { j, ms: performance.now() - t0 };
}

const user = (content: string): Msg[] => [{ role: "user", content }];
const strip = (s: string) => s.replace(/<think>[\s\S]*?<\/think>/g, "").replace(/^```\w*\n?|```$/gm, "").trim();

const CHECKS: { name: string; body: Record<string, unknown>; judge: (c: string, calls?: { function: { name: string; arguments: string } }[]) => [boolean, string] }[] = [
  { name: "exact instruction", body: { messages: user("Reply with exactly the word PONG and nothing else."), max_tokens: 20 }, judge: (c) => [strip(c).replace(/[."']/g, "").toUpperCase() === "PONG", strip(c).slice(0, 40)] },
  { name: "json", body: { messages: user('Return only a JSON object with keys "name" (string) and "age" (integer) for this sentence: "Mette is 34 years old." No prose.'), max_tokens: 80 },
    judge: (c) => { try { const o = JSON.parse(strip(c)); return [o.name === "Mette" && o.age === 34, JSON.stringify(o)]; } catch { return [false, strip(c).slice(0, 60)]; } } },
  { name: "tool call", body: { messages: user("What's the weather in Copenhagen right now?"), max_tokens: 200, tools: [{ type: "function", function: { name: "get_weather", description: "Current weather for a city", parameters: { type: "object", properties: { city: { type: "string" } }, required: ["city"] } } }] },
    judge: (_c, calls) => { const a = calls?.[0]?.function; return [!!a && a.name === "get_weather" && /copenhagen|københavn/i.test(a.arguments), a ? `${a.name}(${a.arguments})` : "no tool call"]; } },
  { name: "arithmetic", body: { messages: user("Pens cost 7 kr each. Anna buys 13 pens and pays with a 100 kr note. How much change does she get? Answer with just the number."), max_tokens: 300 },
    judge: (c) => [/\b9\b/.test(strip(c).split("\n").pop() ?? ""), strip(c).slice(-40)] },
  { name: "danish", body: { messages: user("Svar kun på dansk i én sætning: Hvad er hovedstaden i Danmark, og hvilken flod eller havn ligger den ved?"), max_tokens: 120 },
    judge: (c) => [/københavn/i.test(c) && /[æøå]/i.test(c), strip(c).slice(0, 80)] },
  { name: "code", body: { messages: user("Write a Python function is_prime(n) that returns True if n is prime. Output only the code."), max_tokens: 300 },
    judge: (c) => [/def is_prime\s*\(/.test(c) && /return/.test(c), /def is_prime[^\n]*/.exec(c)?.[0] ?? strip(c).slice(0, 40)] },
];

async function speed(base: string, model: string, headers: Record<string, string>) {
  const t0 = performance.now();
  const r = await fetch(`${base}/chat/completions`, { method: "POST", headers: { "content-type": "application/json", ...headers }, signal: AbortSignal.timeout(300_000),
    body: JSON.stringify({ model, temperature: 0.7, stream: true, max_tokens: 400, messages: user("Write a 300-word story about a lighthouse keeper who finds a message in a bottle.") }) });
  if (!r.ok) throw new Error(`${r.status} ${(await r.text()).slice(0, 200)}`);
  let first: number | null = null, n = 0, tps: number | null = null;
  for await (const ev of sse(r)) {
    const c = ev as { choices?: { delta?: { content?: string; reasoning_content?: string } }[]; timings?: { predicted_per_second?: number } };
    const d = c.choices?.[0]?.delta;
    if (d && (d.content || d.reasoning_content)) { first ??= performance.now(); n++; }
    if (c.timings?.predicted_per_second) tps = c.timings.predicted_per_second;
  }
  const end = performance.now();
  return { ttftMs: first ? first - t0 : end - t0, tps: tps ?? (first && n > 1 ? n / ((end - first) / 1000) : 0) };
}

async function prefill(base: string, model: string, headers: Record<string, string>) {
  const filler = Array.from({ length: 220 }, (_, i) => `Record ${i}: order ${1000 + i} shipped to warehouse ${i % 7} on day ${i % 28}.`).join(" ");
  const { j } = await complete(base, model, headers, { messages: user(`${filler}\n\nHow many records are there? Answer with a number.`), max_tokens: 8, cache_prompt: false });
  return j.timings?.prompt_per_second ?? null;
}

async function benchEmbedding(base: string, model: string, headers: Record<string, string>) {
  const post = async (input: string[]) => {
    const r = await fetch(`${base}/embeddings`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify({ model, input }) });
    if (!r.ok) throw new Error(`${r.status} ${(await r.text()).slice(0, 200)}`);
    return ((await r.json()) as { data: { embedding: number[] }[] }).data.map((d) => d.embedding);
  };
  const cos = (a: number[], b: number[]) => { let d = 0, x = 0, y = 0; for (let i = 0; i < a.length; i++) { d += a[i] * b[i]; x += a[i] ** 2; y += b[i] ** 2; } return d / Math.sqrt(x * y); };
  const t0 = performance.now();
  const batch = Array.from({ length: 64 }, (_, i) => `Customer ${i} asks how to reset their password and change the billing email on the account.`);
  await post(batch);
  const ms = performance.now() - t0;
  const [dog, puppy, invoice, hund] = await post(["The dog is playing in the garden.", "A puppy runs around the yard.", "Please pay the attached invoice by Friday.", "Hunden leger i haven."]);
  const checks: Check[] = [
    { name: "similarity", pass: cos(dog, puppy) > cos(dog, invoice), ms: 0, detail: `dog~puppy ${cos(dog, puppy).toFixed(2)} vs dog~invoice ${cos(dog, invoice).toFixed(2)}` },
    { name: "danish ↔ english", pass: cos(dog, hund) > cos(dog, invoice), ms: 0, detail: `dog~hund ${cos(dog, hund).toFixed(2)}` },
  ];
  return { checks, tps: (64 / ms) * 1000, ttftMs: ms / 64, dims: dog.length };
}

export async function runBenchmark(modelId: string): Promise<string> {
  const m = getModel(modelId);
  if (!m) throw new Error(`no model ${modelId}`);
  const id = randomBytes(6).toString("hex");
  db.prepare("INSERT INTO benchmarks(id, model_id, ts, status) VALUES(?, ?, ?, 'running')").run(id, modelId, now());
  journal({ kind: "benchmark", ref: modelId, title: `Benchmark ${modelId}` });
  benchBus.emit("update", { id, modelId, status: "running" });
  void execute(id, m);
  return id;
}

async function execute(id: string, m: Model) {
  const t0 = performance.now();
  let up;
  try {
    up = await acquire(m);
    const load = Math.round(performance.now() - t0);
    const results: Check[] = [];
    let tps = 0, ttft = 0, ptps: number | null = null;
    // A free tier's model is benchmarked at its pace (under its per-minute limit), and every call counts on its quota.
    const free = freePlan(m);
    const rpm = free ? { ...free.limits.default, ...free.limits.per_model?.[m.upstream_model ?? ""] }.rpm : undefined;
    const pace = async () => { if (!free) return; if (rpm) await new Promise((r) => setTimeout(r, Math.ceil(60_000 / rpm) + 500)); countRequest(m.id, 0); };
    if (m.kind === "embedding") {
      await pace();
      const r = await benchEmbedding(up.baseUrl, up.model, up.headers);
      results.push(...r.checks);
      tps = r.tps; ttft = r.ttftMs;
    } else {
      await pace();
      const s = await speed(up.baseUrl, up.model, up.headers);
      tps = s.tps; ttft = s.ttftMs;
      results.push({ name: "speed", pass: tps >= 15, ms: Math.round(ttft), detail: `${tps.toFixed(1)} tok/s, first token ${Math.round(ttft)} ms` });
      ptps = free ? null : await prefill(up.baseUrl, up.model, up.headers).catch(() => null); // a cloud's prefill says nothing about ours
      for (const c of CHECKS) {
        try {
          await pace();
          // A hosted model may think before it answers (Qwen3.8 on a free tier does): room for that, the answer judged.
          const body = free ? { ...c.body, max_tokens: Math.max(Number(c.body.max_tokens ?? 0) * 8, 1024) } : c.body;
          const { j, ms } = await complete(up.baseUrl, up.model, up.headers, body);
          const msg = j.choices[0]?.message ?? {};
          const [pass, detail] = c.judge(msg.content ?? "", msg.tool_calls);
          results.push({ name: c.name, pass, ms: Math.round(ms), detail });
        } catch (e) { results.push({ name: c.name, pass: false, ms: 0, detail: (e as Error).message.slice(0, 120) }); }
        benchBus.emit("update", { id, modelId: m.id, status: "running", results });
      }
    }
    const score = results.filter((r) => r.pass).length / results.length;
    db.prepare("UPDATE benchmarks SET status = 'done', results = ?, score = ?, tps = ?, prompt_tps = ?, ttft_ms = ?, load_ms = ? WHERE id = ?")
      .run(JSON.stringify(results), score, Math.round(tps * 10) / 10, ptps, Math.round(ttft), up.coldStartMs || load, id);
    event("info", "bench", `${m.id}: ${(score * 100).toFixed(0)}% of checks, ${tps.toFixed(1)} tok/s`);
    benchBus.emit("update", { id, modelId: m.id, status: "done", score, tps });
  } catch (e) {
    db.prepare("UPDATE benchmarks SET status = 'error', error = ? WHERE id = ?").run((e as Error).message, id);
    event("error", "bench", `${m.id}: ${(e as Error).message}`);
    benchBus.emit("update", { id, modelId: m.id, status: "error", error: (e as Error).message });
  } finally {
    if (up) release(m.id);
  }
}
