#!/usr/bin/env node
// Chat latency for a person waiting, under a background load: what Bloom's chat bar feels while batch work runs.
//
//   MUX_KEY=… node deploy/chat-latency.mjs [--url http://127.0.0.1:7070] [--model agent] [--turns 20] [--background 4]
//                                          [--compare] [--admin-token-file ~/.mux/mux.env] [--json out.json]
//
// Starts --background workers that keep asking the same model for long answers (x-mux-priority: background), waits for
// them to fill its slots, then sends --turns short streamed questions as a person would (x-mux-priority: interactive,
// x-mux-trace chat-latency-<run>-<n>, x-mux-stage client;dur=0), one after another, and reports per turn and as
// p50/p90: the client's time to the first token and to the end, and mux's own queue wait (x-mux-queue-ms).
// --compare runs it twice on the same build, priority off then on (PATCH /api/admin/settings priorityEnabled; the
// admin token from MUX_ADMIN_TOKEN or the env file), and puts the setting back as it was. The key is never printed;
// nothing said is kept by mux (turn stats hold no words).
import { readFileSync, writeFileSync } from "node:fs";

const args = Object.fromEntries(process.argv.slice(2).reduce((acc, a, i, all) => {
  if (a.startsWith("--")) acc.push([a.slice(2), all[i + 1] && !all[i + 1].startsWith("--") ? all[i + 1] : "1"]);
  return acc;
}, []));
const BASE = (args.url ?? process.env.MUX_URL ?? "http://127.0.0.1:7070").replace(/\/$/, "");
const KEY = (args["key-file"] ? readFileSync(args["key-file"], "utf8") : process.env.MUX_KEY ?? "").trim();
const MODEL = args.model ?? "agent";
const TURNS = Number(args.turns ?? 20);
const BG = Number(args.background ?? 4);
if (!KEY) { console.error("MUX_KEY (or --key-file): a tenant key that may use the model or route"); process.exit(2); }
function adminToken() {
  if (process.env.MUX_ADMIN_TOKEN) return process.env.MUX_ADMIN_TOKEN;
  const f = (args["admin-token-file"] ?? `${process.env.HOME}/.mux/mux.env`).replace(/^~/, process.env.HOME ?? "");
  try { return /^MUX_ADMIN_TOKEN=(.*)$/m.exec(readFileSync(f, "utf8"))?.[1]?.trim().replace(/^["']|["']$/g, "") ?? ""; } catch { return ""; }
}

const QUESTIONS = ["What should I focus on today?", "Who is Anna Berg?", "How many invoices are overdue?", "Draft a one-line thank you to the plumber.",
  "What was revenue last month?", "Is anything urgent in my inbox?", "Summarise the bank's email in one sentence.", "When is my next meeting?"];
const pct = (xs, p) => { const s = xs.filter((x) => Number.isFinite(x)).sort((a, b) => a - b); return s.length ? Math.round(s[Math.min(s.length - 1, Math.ceil(p * s.length) - 1)]) : null; };

async function stream(body, headers, signal) {
  const t0 = performance.now();
  const r = await fetch(`${BASE}/v1/chat/completions`, { method: "POST", signal, headers: { authorization: `Bearer ${KEY}`, "content-type": "application/json", ...headers }, body: JSON.stringify({ model: MODEL, stream: true, ...body }) });
  if (!r.ok) throw new Error(`${r.status} ${(await r.text()).slice(0, 200)}`);
  const reader = r.body.getReader(); const dec = new TextDecoder();
  let first = null, think = null, buf = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    // The first answer token ("content", or a tool call) is the TTFT, as mux counts it; thinking before it is apart
    if (think === null && /"reasoning_content":"[^"]/.test(buf)) think = performance.now() - t0;
    if (first === null && (/"content":"[^"]/.test(buf) || /"tool_calls":\[\{/.test(buf))) first = performance.now() - t0;
  }
  return { ttft: first, think, total: performance.now() - t0, queue: Number(r.headers.get("x-mux-queue-ms") ?? NaN), model: r.headers.get("x-mux-model"), priority: r.headers.get("x-mux-priority") };
}

async function run(label) {
  const ac = new AbortController();
  let bgDone = 0, bgFail = 0;
  const worker = async (i) => {
    while (!ac.signal.aborted) {
      try { await stream({ max_tokens: 600, messages: [{ role: "user", content: `Write a long, detailed essay (variant ${i}-${bgDone}) about the history of bookkeeping.` }] }, { "x-mux-priority": "background", "x-mux-agent": "chat-latency-background" }, ac.signal); bgDone++; }
      catch (e) { if (ac.signal.aborted) return; bgFail++; await new Promise((r) => setTimeout(r, 1000)); }
    }
  };
  const workers = Array.from({ length: BG }, (_, i) => worker(i));
  if (BG) await new Promise((r) => setTimeout(r, 3000)); // let the load fill the slots
  const runId = `${Date.now().toString(36)}`;
  const rows = [];
  for (let n = 0; n < TURNS; n++) {
    try {
      const r = await stream({ max_tokens: 60, messages: [{ role: "user", content: QUESTIONS[n % QUESTIONS.length] }] },
        { "x-mux-priority": "interactive", "x-mux-trace": `chat-latency-${runId}-${n}`, "x-mux-stage": "client;dur=0", "x-mux-agent": "chat-latency" });
      rows.push(r);
      console.log(`  ${label} turn ${String(n + 1).padStart(2)}: first answer token ${Math.round(r.ttft ?? NaN)} ms${r.think != null ? ` (thinking from ${Math.round(r.think)} ms)` : ""}, total ${Math.round(r.total)} ms, mux queue ${r.queue} ms (${r.model}, ${r.priority})`);
    } catch (e) { console.log(`  ${label} turn ${n + 1}: failed: ${e.message}`); }
  }
  ac.abort();
  await Promise.allSettled(workers);
  const out = { label, turns: rows.length, background: BG, backgroundDone: bgDone, backgroundFailed: bgFail,
    ttft: { p50: pct(rows.map((r) => r.ttft), 0.5), p90: pct(rows.map((r) => r.ttft), 0.9) }, reasoned: rows.filter((r) => r.think != null).length, total: { p50: pct(rows.map((r) => r.total), 0.5), p90: pct(rows.map((r) => r.total), 0.9) },
    queue: { p50: pct(rows.map((r) => r.queue), 0.5), p90: pct(rows.map((r) => r.queue), 0.9) } };
  console.log(`${label}: first token p50 ${out.ttft.p50} · p90 ${out.ttft.p90} ms; total p50 ${out.total.p50} · p90 ${out.total.p90} ms; mux queue p50 ${out.queue.p50} · p90 ${out.queue.p90} ms; ${out.reasoned} of ${out.turns} thought first (${BG} background workers, ${bgDone} done)`);
  return out;
}

async function setPriority(on, token) {
  const r = await fetch(`${BASE}/api/admin/settings`, { method: "PATCH", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ priorityEnabled: on }) });
  if (!r.ok) throw new Error(`settings: ${r.status}`);
  return (await r.json()).priorityEnabled;
}

const results = [];
console.log(`chat latency on ${BASE}, model ${MODEL}, ${TURNS} turns, ${BG} background workers`);
if (args.compare) {
  const token = adminToken();
  if (!token) { console.error("--compare needs the admin token (MUX_ADMIN_TOKEN or --admin-token-file)"); process.exit(2); }
  const was = (await (await fetch(`${BASE}/api/admin/settings`, { headers: { authorization: `Bearer ${token}` } })).json()).priorityEnabled;
  try {
    await setPriority(false, token); results.push(await run("priority off"));
    await setPriority(true, token); results.push(await run("priority on"));
  } finally { await setPriority(was !== false, token).catch(() => undefined); }
  const [off, on] = results;
  console.log(`\nbefore → after: first token p50 ${off.ttft.p50} → ${on.ttft.p50} ms, p90 ${off.ttft.p90} → ${on.ttft.p90} ms; queue p90 ${off.queue.p90} → ${on.queue.p90} ms`);
} else results.push(await run("now"));
if (args.json) writeFileSync(args.json, JSON.stringify({ at: new Date().toISOString(), url: BASE, model: MODEL, results }, null, 2));
