import Fastify from "fastify";
import cors from "@fastify/cors";
import fastifyStatic from "@fastify/static";
import { existsSync } from "node:fs";
import { config } from "./config.js";
import { db, event, now, settings } from "./db.js";
import { getModel, getRoute, listModels, listRoutes, upsertModel, upsertRoute, type Kind } from "./models.js";
import { registerGateway } from "./api/gateway.js";
import { registerAdmin } from "./admin/routes.js";
import { pruneSamples, sampleModels } from "./admin/resources.js";
import { startHealer } from "./healer.js";
import { startLens } from "./lens.js";
import { startSignals } from "./signals.js";
import { startExperiments } from "./experiments.js";
import { loadCounts } from "./quota.js";
import { startPresence } from "./presence.js";
import { startGbrain, stopGbrain } from "./gbrain.js";
import { moveToGbrain } from "./brain.js";
import { adoptDownloaded } from "./hf.js";
import { startCompat } from "./compat.js";
import { startProviderSync } from "./providers.js";
import { freeIdle, startRuntime, status, stopAll } from "./runtime/manager.js";
import { systemStats } from "./runtime/system.js";

/** First boot: the routes every SaaS can name, and Laya for System One. Models are added by download or import. */
function seed() {
  {
    const routes: [string, string, Kind, "priority" | "auto" | "fastest" | "quality"][] = [
      ["auto", "mux picks per request: tools, code, reasoning, Danish, images, length — and what is already loaded", "chat", "auto"],
      ["fast", "Short answers, classification, extraction: the fastest model that can do it", "chat", "fastest"],
      ["agent", "Agents with tools: reliable tool calls first", "chat", "priority"],
      ["smart", "The best answer this Mac can give, at the speed it takes", "chat", "quality"],
      ["code", "Coding agents and code questions", "chat", "priority"],
      ["multilingual", "Danish and other languages, customer-facing", "chat", "priority"],
      ["vision", "Images, screenshots, documents", "chat", "priority"],
      ["embed", "Embeddings for RAG and search", "embedding", "priority"],
      ["rerank", "Reranking for RAG: query + documents → relevance", "rerank", "priority"],
      ["systemone", "Jev's System One: fast closed decisions between agent moves (Laya here, Jev hosted)", "systemone", "priority"],
      ["transcribe", "Speech to text: OpenAI's /v1/audio/transcriptions (Whisper)", "transcription", "priority"],
      ["speak", "Text to speech: OpenAI's /v1/audio/speech", "speech", "priority"],
    ];
    // Any route missing (a first boot, or one added in a newer mux) is created empty; existing ones are left as they are.
    for (const [name, description, kind, strategy] of routes) if (!getRoute(name)) upsertRoute({ name, description, kind, strategy, candidates: [] });
  }
  if (config.role !== "gateway" && !getModel("laya")) {
    upsertModel({ id: "laya", display_name: "Laya (System One)", backend: "laya", kind: "systemone", caps: { speed: 9, quality: 4 },
      notes: "convaiinnovations/laya over ONNX on the CPU (~1.8 GB): Jev-compatible /v1/systemone. The base checkpoint is near chance on real questions until it is trained.", keep_alive_min: 60 });
    upsertRoute({ ...listRoutes().find((r) => r.name === "systemone")!, candidates: ["laya"] });
  }
}

/** Every 30 s: a sample of the Mac's memory for the System page; once an hour: retention. */
function samplers() {
  const put = db.prepare("INSERT OR REPLACE INTO system_samples(ts, mem_total_gb, mem_used_gb, mem_free_gb, swap_gb, pressure, mux_gb, loaded, cpu, disk_free_gb) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
  const sample = async () => {
    const [s, inst] = await Promise.all([systemStats(), status()]);
    put.run(now(), s.memTotalGb, s.memUsedGb, s.memFreeGb, s.swapGb, s.pressure, inst.reduce((a, i) => a + (i.rssGb ?? i.estimateGb), 0), JSON.stringify(inst.map((i) => i.id)), s.load1, s.diskFreeGb);
  };
  setInterval(() => { void sample().catch(() => undefined); void sampleModels().catch(() => undefined); }, 30_000).unref();
  void sample().catch(() => undefined);
  const retain = () => {
    const days = settings().retentionDays;
    const r = db.prepare("DELETE FROM requests WHERE ts < ?").run(now() - days * 86400_000);
    db.prepare("DELETE FROM system_samples WHERE ts < ?").run(now() - 14 * 86400_000);
    pruneSamples();
    db.prepare("DELETE FROM events WHERE ts < ?").run(now() - 30 * 86400_000);
    if (r.changes) event("info", "retention", `removed ${r.changes} requests older than ${days} days`);
  };
  setInterval(retain, 3600_000).unref();
  retain();
}

const app = Fastify({ logger: false, bodyLimit: 64 * 1024 * 1024, trustProxy: true, keepAliveTimeout: 75_000, requestTimeout: 0 });
await app.register(cors, { origin: true, exposedHeaders: ["x-mux-request-id", "x-mux-model", "x-mux-route", "x-mux-fallbacks", "x-mux-cold-start"] });

app.get("/health", async () => ({ ok: true, models: listModels().length, loaded: (await status()).filter((i) => i.state === "ready").map((i) => i.id) }));
registerGateway(app);
registerAdmin(app);

if (existsSync(config.webDir)) {
  await app.register(fastifyStatic, { root: config.webDir, wildcard: false });
  // The dashboard is a single page: any path that is not the API is the page.
  app.setNotFoundHandler((req, reply) => {
    if (req.url.startsWith("/v1/") || req.url.startsWith("/api/")) return reply.code(404).send({ error: { message: `no route ${req.method} ${req.url}`, type: "not_found" } });
    return reply.sendFile("index.html");
  });
}

seed();
// A gateway holds no models of its own; everything it routes to is a provider's.
if (config.role !== "gateway") { adoptDownloaded(); startRuntime(); startPresence(freeIdle); }
startProviderSync();
samplers();
await app.listen({ port: config.port, host: config.host });
startHealer(app);
startLens();
startSignals();
startExperiments();
loadCounts();
void startGbrain().then(() => moveToGbrain()).catch((e) => event("warn", "gbrain", (e as Error).message));
if (config.role !== "gateway") startCompat();
event("info", "mux", `${config.role} \"${config.name}\" listening on ${config.host}:${config.port}; models in ${config.modelsDir}; dashboard ${existsSync(config.webDir) ? "served" : "not built"}`);

const stop = async (sig: string) => {
  event("info", "mux", `${sig}: stopping the model servers`);
  await app.close().catch(() => undefined);
  stopGbrain();
  await stopAll();
  process.exit(0);
};
process.on("SIGTERM", () => void stop("SIGTERM"));
process.on("SIGINT", () => void stop("SIGINT"));
