/**
 * Laya behind mux: a model server mux starts and stops like any other (backend "laya"). Laya (@receptron/laya, ONNX on
 * CPU) answers Jev's System One shape; mux checks the request before it gets here and meters the answer.
 *
 *   GET  /health        → 200 once the weights are loaded, 503 while loading
 *   POST /v1/systemone  → { state, questions } in, Laya's answer out
 *
 * Environment (set by mux): PORT, HOST, LAYA_MODEL, LAYA_CACHE, LAYA_MODEL_DIR, LAYA_REVISION, HF_TOKEN.
 * Passes run one at a time: one pass takes the CPU it is given, so queueing keeps each answer's time honest.
 */
import { createServer } from "node:http";
import { Laya } from "@receptron/laya";

const PORT = Number(process.env.PORT ?? 8200);
const HOST = process.env.HOST ?? "127.0.0.1";
const MODEL = process.env.LAYA_MODEL ?? "laya";

let laya = null;
let loadError = null;

const send = (res, status, body) => {
  const text = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(text) });
  res.end(text);
};

let queue = Promise.resolve();
const oneAtATime = (fn) => { const next = queue.then(fn, fn); queue = next.catch(() => undefined); return next; };

const server = createServer((req, res) => {
  if (req.url === "/health") return laya ? send(res, 200, { ok: true, model: MODEL }) : send(res, 503, { ok: false, error: loadError ?? "loading" });
  if (req.method !== "POST" || req.url !== "/v1/systemone") return send(res, 404, { error: "POST /v1/systemone" });
  if (!laya) return send(res, 503, { error: loadError ?? "loading the weights" });
  let body = "";
  req.on("data", (c) => { body += c; });
  req.on("end", async () => {
    let parsed;
    try { parsed = JSON.parse(body); } catch { return send(res, 400, { error: "not JSON" }); }
    const t0 = Date.now();
    try {
      const result = await oneAtATime(() => laya.systemOne(parsed.state, parsed.questions));
      send(res, 200, { ...result, model: MODEL, ms: Date.now() - t0 });
    } catch (e) {
      send(res, 500, { error: e instanceof Error ? e.message : String(e) });
    }
  });
});

server.listen(PORT, HOST, () => console.log(`laya: listening on ${HOST}:${PORT}`));
Laya.load({
  modelDir: process.env.LAYA_MODEL_DIR || undefined,
  cacheDir: process.env.LAYA_CACHE || undefined,
  revision: process.env.LAYA_REVISION || undefined,
  token: process.env.HF_TOKEN || undefined,
}).then((l) => { laya = l; console.log(`laya: loaded from ${l.modelDir}`); }, (e) => { loadError = e.message; console.error(`laya: could not load: ${e.message}`); });

const stop = async () => { server.close(); if (laya) await laya.close().catch(() => undefined); process.exit(0); };
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
