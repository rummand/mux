import { existsSync, readFileSync, rmSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { advise, recommendStack, USE_CASES, type UseCase } from "../advisor.js";
import { benchBus, runBenchmark } from "../bench.js";
import { CATALOG } from "../catalog.js";
import { config } from "../config.js";
import { db, event, json, now, saveSettings, settings } from "../db.js";
import { cancelDownload, downloadsBus, importLocal, listDownloads, repoFiles, scanLocal, searchHf, startDownload } from "../hf.js";
import { listInvestigations, startInvestigation } from "../lens.js";
import { deleteModel, deleteRoute, getModel, listModels, listRoutes, upsertModel, upsertRoute, type Model } from "../models.js";
import { snapshot } from "../router/health.js";
import { decide, features } from "../router/select.js";
import { inflightNow } from "../router/limits.js";
import { live } from "../router/metering.js";
import { estimateGb, failures, isLoaded, status, unload, warm } from "../runtime/manager.js";
import { systemStats } from "../runtime/system.js";
import { createKey, deleteTenant, getTenant, listKeys, listTenants, revokeKey, upsertTenant } from "../tenants.js";
import { overview, requestDetail, requestLog, systemSeries, traces } from "./stats.js";
import { timingSafeEqual } from "node:crypto";

const ok = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

/** Secrets never leave through the admin API: a model's upstream key is shown as set or not. */
const publicModel = (m: Model) => ({ ...m, api_key: m.api_key ? "••••" : null, estimateGb: estimateGb(m) });

const latestBench = db.prepare("SELECT * FROM benchmarks WHERE model_id = ? ORDER BY ts DESC LIMIT 1");

export function registerAdmin(app: FastifyInstance) {
  app.register(async (api) => {
    api.addHook("onRequest", async (req: FastifyRequest, reply: FastifyReply) => {
      const token = (req.headers.authorization ?? "").replace(/^Bearer\s+/i, "") || (req.query as { token?: string }).token || "";
      if (!ok(token, config.adminToken)) return reply.code(401).send({ error: "admin token required" });
    });

    // ── Overview & system ──────────────────────────────────────────────────────────────────────────────────────
    api.get("/overview", async (req) => {
      const q = req.query as { range?: string; tenant?: string; model?: string; agent?: string };
      return overview(q.range, q);
    });
    api.get("/system", async (req) => {
      const [sys, inst] = await Promise.all([systemStats(), status()]);
      const s = settings();
      return {
        system: sys, instances: inst, health: snapshot(), failures: failures(), inflight: inflightNow(),
        budget: { budgetGb: s.memoryBudgetGb, usedGb: inst.reduce((a, i) => a + i.estimateGb, 0), headroomGb: s.memoryHeadroomGb, maxLoaded: s.maxLoaded },
        series: systemSeries((req.query as { range?: string }).range),
        version: process.env.npm_package_version ?? "0.1.0", uptimeS: Math.round(process.uptime()),
      };
    });
    api.get("/events", async (req) => {
      const q = req.query as { limit?: string; level?: string };
      return db.prepare(`SELECT * FROM events ${q.level ? "WHERE level = ?" : ""} ORDER BY ts DESC LIMIT ?`).all(...(q.level ? [q.level] : []), Number(q.limit ?? 200));
    });

    // ── Models ─────────────────────────────────────────────────────────────────────────────────────────────────
    api.get("/models", async () => {
      const inst = await status();
      const usage = db.prepare("SELECT model_id, COUNT(*) n, SUM(CASE WHEN status >= 400 THEN 1 ELSE 0 END) errors, SUM(prompt_tokens + completion_tokens) tokens, AVG(tps) tps FROM requests WHERE ts >= ? GROUP BY model_id").all(now() - 86400_000) as { model_id: string }[];
      return listModels().map((m) => ({ ...publicModel(m), instance: inst.find((i) => i.id === m.id) ?? null, bench: latestBench.get(m.id) ?? null, usage24h: usage.find((u) => u.model_id === m.id) ?? null, onDisk: m.path ? existsSync(m.path) : null }));
    });
    api.post("/models", async (req, reply) => {
      const b = req.body as Partial<Model> & { id: string; backend: Model["backend"] };
      if (!b?.id || !/^[a-z0-9][a-z0-9._-]*$/i.test(b.id)) return reply.code(400).send({ error: "an id of letters, digits, dots and dashes is required" });
      if (getModel(b.id)) return reply.code(409).send({ error: `${b.id} exists` });
      return publicModel(upsertModel(b));
    });
    api.patch("/models/:id", async (req, reply) => {
      const id = (req.params as { id: string }).id;
      const prev = getModel(id);
      if (!prev) return reply.code(404).send({ error: "no such model" });
      const b = req.body as Partial<Model>;
      if (b.api_key === "••••") delete b.api_key;
      const next = upsertModel({ ...prev, ...b, id });
      // Flags that change how the server starts take effect on its next load.
      const restart = ["path", "mmproj", "ctx", "parallel", "extra_args", "reasoning", "backend"].some((k) => k in b && JSON.stringify((b as Record<string, unknown>)[k]) !== JSON.stringify((prev as unknown as Record<string, unknown>)[k]));
      if (restart) await unload(id);
      return publicModel(next);
    });
    api.delete("/models/:id", async (req) => {
      const id = (req.params as { id: string }).id;
      const files = (req.query as { files?: string }).files === "1";
      const m = getModel(id);
      await unload(id);
      if (m && files && m.path) {
        // Only what mux downloaded is deleted; an imported model is a link, and only the link goes.
        const inModels = m.path.startsWith(config.modelsDir);
        if (inModels) {
          const isLink = m.path.includes(`${config.modelsDir}/imported/`);
          if (isLink) { rmSync(m.path, { force: true }); if (m.mmproj) rmSync(m.mmproj, { force: true }); }
          else rmSync(dirname(m.path), { recursive: true, force: true });
        }
      }
      deleteModel(id);
      for (const r of listRoutes()) if (r.candidates.includes(id)) upsertRoute({ ...r, candidates: r.candidates.filter((c) => c !== id) });
      event("info", "models", `removed ${id}${files ? " and its files" : ""}`);
      return { ok: true };
    });
    api.post("/models/:id/load", async (req, reply) => {
      const id = (req.params as { id: string }).id;
      try { await warm(id); return { ok: true }; } catch (e) { return reply.code(503).send({ error: (e as Error).message }); }
    });
    api.post("/models/:id/unload", async (req) => ({ ok: await unload((req.params as { id: string }).id) }));
    api.get("/models/:id/log", async (req) => {
      const p = join(config.logsDir, "models", `${(req.params as { id: string }).id}.log`);
      if (!existsSync(p)) return { log: "" };
      const size = statSync(p).size;
      const text = readFileSync(p, "utf8");
      return { log: text.slice(Math.max(0, text.length - 60_000)), size };
    });

    // ── Catalog, advisor, Hugging Face, downloads, local files ─────────────────────────────────────────────────
    api.get("/catalog", async () => {
      const installed = listModels();
      return CATALOG.map((c) => ({ ...c, installed: installed.find((m) => m.catalog_id === c.id)?.id ?? null }));
    });
    api.get("/advisor/use-cases", async () => Object.entries(USE_CASES).map(([id, u]) => ({ id, label: u.label, weights: u.w })));
    api.get("/advisor", async (req) => {
      const q = req.query as { useCase?: UseCase; priority?: "quality" | "balanced" | "speed" };
      return advise(q.useCase && q.useCase in USE_CASES ? q.useCase : "agent", q.priority);
    });
    api.get("/advisor/stack", async () => recommendStack());
    api.get("/hf/search", async (req) => searchHf((req.query as { q: string }).q ?? ""));
    api.get("/hf/files", async (req) => repoFiles((req.query as { repo: string }).repo));
    api.get("/downloads", async () => listDownloads());
    api.post("/downloads", async (req, reply) => {
      try { return await startDownload(req.body as never); } catch (e) { return reply.code(400).send({ error: (e as Error).message }); }
    });
    api.delete("/downloads/:id", async (req) => { cancelDownload((req.params as { id: string }).id); return { ok: true }; });
    api.get("/local", async () => scanLocal());
    api.post("/local/import", async (req, reply) => {
      const b = req.body as { path: string; id?: string; kind?: Model["kind"]; catalogId?: string; mmproj?: string | null };
      try { return publicModel(importLocal(b.path, b)); } catch (e) { return reply.code(400).send({ error: (e as Error).message }); }
    });

    // ── Routes ─────────────────────────────────────────────────────────────────────────────────────────────────
    api.get("/routes", async () => listRoutes());
    api.put("/routes/:name", async (req) => upsertRoute({ ...(req.body as object), name: (req.params as { name: string }).name }));
    api.delete("/routes/:name", async (req) => { deleteRoute((req.params as { name: string }).name); return { ok: true }; });
    // What the router would do with a request, without sending it: the features it reads and the order it would try.
    api.post("/routes/explain", async (req, reply) => {
      const b = req.body as { tenant?: string; model?: string; messages?: { role: string; content: string }[]; tools?: unknown[]; tool_choice?: unknown; kind?: "chat" | "embedding" | "rerank" | "systemone" };
      const t = getTenant(b.tenant ?? "playground") ?? listTenants()[0];
      if (!t) return reply.code(400).send({ error: "create a tenant first" });
      try {
        const f = features(b as never);
        const d = decide(t, b.model, b.kind ?? "chat", f);
        return { tenant: t.id, features: f, route: d.route?.name ?? null, reason: d.reason, candidates: d.candidates.map((m) => ({ id: m.id, backend: m.backend, loaded: isLoaded(m.id) })) };
      } catch (e) { return reply.code(400).send({ error: (e as Error).message }); }
    });

    // ── Tenants & keys ─────────────────────────────────────────────────────────────────────────────────────────
    api.get("/tenants", async () => {
      const since = now() - 86400_000;
      const usage = db.prepare(`SELECT tenant_id, COUNT(*) n, SUM(CASE WHEN status >= 400 THEN 1 ELSE 0 END) errors, SUM(prompt_tokens + completion_tokens) tokens, MAX(ts) last
        FROM requests WHERE ts >= ? GROUP BY tenant_id`).all(since) as { tenant_id: string }[];
      const month = new Date(); month.setDate(1); month.setHours(0, 0, 0, 0);
      const spent = db.prepare("SELECT tenant_id, SUM(prompt_tokens + completion_tokens) tokens FROM requests WHERE ts >= ? GROUP BY tenant_id").all(month.getTime()) as { tenant_id: string; tokens: number }[];
      return listTenants().map((t) => ({ ...t, keys: listKeys(t.id).filter((k) => !k.revoked_at).length, usage24h: usage.find((u) => u.tenant_id === t.id) ?? null, monthTokens: spent.find((s) => s.tenant_id === t.id)?.tokens ?? 0 }));
    });
    api.get("/tenants/:id", async (req, reply) => {
      const t = getTenant((req.params as { id: string }).id);
      return t ? { ...t, keys: listKeys(t.id) } : reply.code(404).send({ error: "no such tenant" });
    });
    api.put("/tenants/:id", async (req, reply) => {
      const id = (req.params as { id: string }).id;
      if (!/^[a-z0-9][a-z0-9-]*$/.test(id)) return reply.code(400).send({ error: "a tenant id is lowercase letters, digits and dashes" });
      const t = upsertTenant({ ...(req.body as object), id });
      event("info", "tenants", `saved tenant ${id}`);
      return t;
    });
    api.delete("/tenants/:id", async (req) => { deleteTenant((req.params as { id: string }).id); return { ok: true }; });
    api.post("/tenants/:id/keys", async (req, reply) => {
      const id = (req.params as { id: string }).id;
      if (!getTenant(id)) return reply.code(404).send({ error: "no such tenant" });
      const b = (req.body ?? {}) as { name?: string; value?: string; expiresInDays?: number; rpmLimit?: number; monthlyTokenBudget?: number };
      const made = createKey(id, b.name || "key", { value: b.value || undefined, expiresAt: b.expiresInDays ? now() + b.expiresInDays * 86400_000 : null, rpmLimit: b.rpmLimit, monthlyTokenBudget: b.monthlyTokenBudget });
      event("info", "tenants", `new key ${made.record.prefix} for ${id}`);
      return made;
    });
    api.delete("/keys/:id", async (req) => { revokeKey((req.params as { id: string }).id); return { ok: true }; });

    // ── Requests, traces, benchmarks, Lens ─────────────────────────────────────────────────────────────────────
    api.get("/requests", async (req) => {
      const q = req.query as Record<string, string>;
      return requestLog({ ...q, before: q.before ? Number(q.before) : undefined, limit: q.limit ? Number(q.limit) : undefined });
    });
    api.get("/requests/:id", async (req, reply) => requestDetail((req.params as { id: string }).id) ?? reply.code(404).send({ error: "no such request" }));
    api.get("/traces", async (req) => { const q = req.query as { range?: string; tenant?: string }; return traces(q.range, q.tenant); });
    api.get("/benchmarks", async (req) => {
      const m = (req.query as { model?: string }).model;
      return (db.prepare(`SELECT * FROM benchmarks ${m ? "WHERE model_id = ?" : ""} ORDER BY ts DESC LIMIT 200`).all(...(m ? [m] : [])) as { results: string }[]).map((b) => ({ ...b, results: json(b.results, []) }));
    });
    api.post("/benchmarks", async (req, reply) => {
      try { return { id: await runBenchmark((req.body as { model: string }).model) }; } catch (e) { return reply.code(400).send({ error: (e as Error).message }); }
    });
    api.get("/lens", async () => listInvestigations());
    api.post("/lens", async (req) => ({ id: startInvestigation(req.body as never) }));

    // ── Settings & playground ──────────────────────────────────────────────────────────────────────────────────
    api.get("/settings", async () => settings());
    api.patch("/settings", async (req) => {
      const b = req.body as Record<string, unknown>;
      saveSettings(b);
      event("info", "settings", `changed ${Object.keys(b).join(", ")}`);
      return settings();
    });
    api.get("/playground-key", async () => ({ key: playgroundKey() }));

    // ── Live: every finished request, download progress, benchmark and runtime events, as server-sent events ──
    api.get("/live", (req, reply) => {
      reply.hijack();
      reply.raw.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive", "x-accel-buffering": "no" });
      reply.raw.write(": connected\n\n");
      const send = (type: string) => (data: unknown) => reply.raw.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
      const handlers: [typeof live, string, (d: unknown) => void][] = [[live, "request", send("request")], [downloadsBus, "progress", send("download")], [benchBus, "update", send("bench")]];
      for (const [bus, name, fn] of handlers) bus.on(name, fn);
      const ping = setInterval(() => reply.raw.write(": ping\n\n"), 15_000);
      req.raw.on("close", () => { clearInterval(ping); for (const [bus, name, fn] of handlers) bus.off(name, fn); });
    });
  }, { prefix: "/api/admin" });
}

/** The playground's own key, kept for the dashboard: requests from the playground are metered like anyone's. */
function playgroundKey(): string {
  const row = db.prepare("SELECT value FROM settings WHERE key = 'playground_key'").get() as { value: string } | undefined;
  if (row && getTenant("playground")) return JSON.parse(row.value);
  if (!getTenant("playground")) upsertTenant({ id: "playground", name: "Playground", description: "The dashboard's own playground and tests", color: "#94a3b8" });
  const { key } = createKey("playground", "dashboard");
  db.prepare("INSERT INTO settings(key, value) VALUES('playground_key', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(JSON.stringify(key));
  return key;
}
