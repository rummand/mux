import { closeSync, existsSync, openSync, readFileSync, readSync, rmSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { advise, insights, recommendStack, usageTable, USE_CASES, type UseCase } from "../advisor.js";
import { refreshSignals, signalsAge, trendingNotInCatalog } from "../signals.js";
import { benchBus, runBenchmark } from "../bench.js";
import { CATALOG } from "../catalog.js";
import { config } from "../config.js";
import { db, event, json, now, saveSettings, settings } from "../db.js";
import { cancelDownload, downloadsBus, importLocal, listDownloads, repoFiles, scanLocal, searchHf, startDownload } from "../hf.js";
import { registerLens } from "../lens.js";
import { deleteModel, deleteRoute, getModel, listModels, listRoutes, upsertModel, upsertRoute, type Model } from "../models.js";
import { snapshot } from "../router/health.js";
import { addCloudModel, getProvider, joinNode, listProviders, PRESETS, remoteModels, removeProvider, saveProvider, syncNode, type Provider } from "../providers.js";
import { decide, features } from "../router/select.js";
import { inflightNow } from "../router/limits.js";
import { live } from "../router/metering.js";
import { estimateGb, failures, isLoaded, status, unload, warm } from "../runtime/manager.js";
import { systemStats } from "../runtime/system.js";
import { createKey, deleteTenant, getTenant, listKeys, listTenants, revokeKey, upsertTenant } from "../tenants.js";
import { overview, requestDetail, requestLog, systemSeries, traces } from "./stats.js";
import { timingSafeEqual } from "node:crypto";
import { registerAssistant } from "../assistant.js";
import { registerHealer } from "../healer.js";
import { registerBrain } from "../brain.js";
import { presence, registerPresence } from "../presence.js";
import { registerJoin } from "../join.js";
import { registerExperiments } from "../experiments.js";
import { quotaReport } from "../quota.js";
import { BORDERS, type Border } from "../router/border.js";
import { modelResources, providerResources, tenantResources } from "./resources.js";

const ok = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

/** Secrets never leave through the admin API: a model's upstream key is shown as set or not. */
const publicModel = (m: Model) => ({ ...m, api_key: m.api_key ? "••••" : null, estimateGb: estimateGb(m) });
const publicProvider = (p: Provider) => ({ ...p, api_key: p.api_key ? "••••" : null, admin_token: p.admin_token ? "••••" : null });

const latestBench = db.prepare("SELECT * FROM benchmarks WHERE model_id = ? ORDER BY ts DESC LIMIT 1");

export function registerAdmin(app: FastifyInstance) {
  app.register(async (api) => {
    api.addHook("onRequest", async (req: FastifyRequest, reply: FastifyReply) => {
      const token = (req.headers.authorization ?? "").replace(/^Bearer\s+/i, "") || (req.query as { token?: string }).token || "";
      const signals = req.method === "POST" && req.url.split("?")[0] === "/api/admin/presence/signals";
      if (signals && config.presenceToken && ok(token, config.presenceToken)) return;
      if (!ok(token, config.adminToken)) return reply.code(401).send({ error: "admin token required" });
    });

    // ── Overview & system ──────────────────────────────────────────────────────────────────────────────────────
    api.get("/overview", async (req) => {
      const q = req.query as { range?: string; tenant?: string; model?: string; agent?: string; provider?: string; route?: string; tz?: string };
      return overview(q.range, q);
    });
    api.get("/system", async (req) => {
      const [sys, inst] = await Promise.all([systemStats(), status()]);
      const s = settings();
      return {
        system: sys, instances: inst, health: snapshot(), failures: failures(), inflight: inflightNow(),
        budget: { budgetGb: s.memoryBudgetGb, usedGb: inst.reduce((a, i) => a + i.estimateGb, 0), headroomGb: s.memoryHeadroomGb, maxLoaded: s.maxLoaded },
        series: systemSeries((req.query as { range?: string }).range),
        version: process.env.npm_package_version ?? "0.1.0", uptimeS: Math.round(process.uptime()), role: config.role, name: config.name,
        presence: config.role === "gateway" ? null : presence(),
      };
    });
    api.get("/events", async (req) => {
      const q = req.query as { limit?: string; level?: string };
      return db.prepare(`SELECT * FROM events ${q.level ? "WHERE level = ?" : ""} ORDER BY ts DESC LIMIT ?`).all(...(q.level ? [q.level] : []), Math.min(Math.max(Math.floor(Number(q.limit)) || 200, 1), 1000));
    });

    // ── Models ─────────────────────────────────────────────────────────────────────────────────────────────────
    api.get("/models", async () => {
      const inst = await status();
      const usage = db.prepare("SELECT model_id, COUNT(*) n, SUM(CASE WHEN status >= 400 THEN 1 ELSE 0 END) errors, SUM(prompt_tokens + completion_tokens) tokens, AVG(tps) tps FROM requests WHERE ts >= ? GROUP BY model_id").all(now() - 86400_000) as { model_id: string }[];
      const providers = new Map(listProviders().map((p) => [p.id, p]));
      return listModels().map((m) => ({ ...publicModel(m), instance: inst.find((i) => i.id === m.id) ?? remoteInstance(m, providers.get(m.provider_id ?? "")), provider: m.provider_id ? providers.get(m.provider_id)?.name ?? m.provider_id : null, bench: latestBench.get(m.id) ?? null, usage24h: usage.find((u) => u.model_id === m.id) ?? null, onDisk: m.path ? existsSync(m.path) : null }));
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

    // ── Providers: mux nodes and cloud APIs ─────────────────────────────────────────────────────────────────────
    api.get("/providers", async () => {
      const usage = db.prepare("SELECT provider_id, COUNT(*) n, SUM(CASE WHEN status >= 400 THEN 1 ELSE 0 END) errors, SUM(prompt_tokens + completion_tokens) tokens, SUM(cost_usd) usd FROM requests WHERE ts >= ? GROUP BY provider_id").all(now() - 86400_000) as { provider_id: string }[];
      const models = listModels();
      return listProviders().map((p) => ({ ...publicProvider(p), models: models.filter((m) => m.provider_id === p.id).map((m) => m.id), usage24h: usage.find((u) => u.provider_id === p.id) ?? null }));
    });
    api.get("/providers/presets", async () => PRESETS);
    api.put("/providers/:id", async (req, reply) => {
      const id = (req.params as { id: string }).id;
      if (!/^[a-z0-9][a-z0-9-]*$/.test(id)) return reply.code(400).send({ error: "a provider id is lowercase letters, digits and dashes" });
      const raw = (req.body ?? {}) as Record<string, unknown>;
      const b = Object.fromEntries(["name", "kind", "base_url", "api_key", "admin_token", "enabled", "plan", "limits", "trains_on_data"].filter((k) => k in raw).map((k) => [k, raw[k]])) as Partial<Provider>;
      if (b.limits !== undefined && typeof b.limits !== "string") b.limits = JSON.stringify(b.limits);
      const prev = getProvider(id);
      if (b.api_key === "••••") b.api_key = prev?.api_key ?? null;
      if (b.admin_token === "••••") b.admin_token = prev?.admin_token ?? null;
      const kind = b.kind ?? prev?.kind ?? "custom";
      const base_url = b.base_url || prev?.base_url || PRESETS[kind]?.base_url || "";
      if (!base_url) return reply.code(400).send({ error: "a base URL is required" });
      const p = saveProvider({ ...prev, ...b, id, kind, base_url });
      try {
        // A new mux node, or one whose token changed: join it (become its tenant) and read its models.
        if (kind === "mux" && (!prev || b.admin_token || b.base_url)) return publicProvider(await joinNode(p, config.name));
      } catch (e) {
        saveProvider({ ...p, status: "error", error: (e as Error).message });
        return reply.code(400).send({ error: (e as Error).message });
      }
      event("info", "providers", `saved provider ${id} (${kind})`);
      return publicProvider(p);
    });
    api.delete("/providers/:id", async (req) => { removeProvider((req.params as { id: string }).id); return { ok: true }; });
    api.post("/providers/:id/sync", async (req, reply) => {
      const p = getProvider((req.params as { id: string }).id);
      if (!p) return reply.code(404).send({ error: "no such provider" });
      if (p.kind === "mux") await syncNode(p);
      return publicProvider(getProvider(p.id)!);
    });
    api.get("/providers/:id/remote-models", async (req, reply) => {
      const p = getProvider((req.params as { id: string }).id);
      if (!p) return reply.code(404).send({ error: "no such provider" });
      try { return await remoteModels(p); } catch (e) { return reply.code(502).send({ error: (e as Error).message }); }
    });
    api.post("/providers/:id/models", async (req, reply) => {
      const p = getProvider((req.params as { id: string }).id);
      if (!p || p.kind === "mux") return reply.code(400).send({ error: "add models to a cloud provider; a node's models come from the node" });
      return publicModel(addCloudModel(p, req.body as never));
    });
    // A node's own admin API, through the gateway: the dashboard manages a node's models, downloads and benchmarks
    // with the same pages it uses for this machine.
    api.all("/providers/:id/proxy/*", async (req, reply) => {
      const p = getProvider((req.params as { id: string }).id);
      if (!p || p.kind !== "mux" || !p.admin_token) return reply.code(404).send({ error: "no such node" });
      const rest = (req.params as { "*": string })["*"];
      const qs = req.url.includes("?") ? req.url.slice(req.url.indexOf("?")) : "";
      try {
        const r = await fetch(`${p.base_url}/api/admin/${rest}${qs}`, {
          method: req.method, signal: AbortSignal.timeout(120_000),
          headers: { authorization: `Bearer ${p.admin_token}`, ...(req.body !== undefined ? { "content-type": "application/json" } : {}) },
          body: req.body !== undefined && req.method !== "GET" ? JSON.stringify(req.body) : undefined,
        });
        reply.code(r.status).header("content-type", r.headers.get("content-type") ?? "application/json");
        return reply.send(Buffer.from(await r.arrayBuffer()));
      } catch (e) { return reply.code(502).send({ error: `${p.name}: ${(e as Error).message}` }); }
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
    api.get("/advisor/insights", async () => ({ ...(await insights()), signalsAt: signalsAge() }));
    api.get("/advisor/trending", async () => trendingNotInCatalog(30));
    api.get("/advisor/usage", async (req) => usageTable(Math.min(Number((req.query as { days?: string }).days) || 30, 365)));
    api.post("/advisor/signals", async () => refreshSignals());
    api.get("/hf/search", async (req) => searchHf((req.query as { q: string }).q ?? ""));
    api.get("/hf/files", async (req) => repoFiles((req.query as { repo: string }).repo));
    api.get("/downloads", async () => listDownloads());
    api.post("/downloads", async (req, reply) => {
      if (config.role === "gateway") return reply.code(400).send({ error: "a gateway runs no models: download or import on a node (Providers → the node → Models)" });
      try { return await startDownload(req.body as never); } catch (e) { return reply.code(400).send({ error: (e as Error).message }); }
    });
    api.delete("/downloads/:id", async (req) => { cancelDownload((req.params as { id: string }).id); return { ok: true }; });
    api.get("/local", async () => scanLocal());
    api.post("/local/import", async (req, reply) => {
      if (config.role === "gateway") return reply.code(400).send({ error: "a gateway runs no models: download or import on a node (Providers → the node → Models)" });
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
      const border = (req.body as { data_border?: string })?.data_border;
      if (border !== undefined && !BORDERS.includes(border as Border)) return reply.code(400).send({ error: "data_border is any, own or servers" });
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
      return requestLog({ ...q, before: q.before ? Number(q.before) : undefined, limit: Number(q.limit) > 0 ? Math.floor(Number(q.limit)) : undefined });
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
    registerLens(api);

    // ── Settings & playground ──────────────────────────────────────────────────────────────────────────────────
    api.get("/settings", async () => settings());
    api.patch("/settings", async (req) => {
      const b = req.body as Record<string, unknown>;
      saveSettings(b);
      event("info", "settings", `changed ${Object.keys(b).join(", ")}`);
      return settings();
    });
    api.get("/playground-key", async () => ({ key: playgroundKey() }));
    registerAssistant(api, app);
    registerHealer(api);
    registerBrain(api);
    registerPresence(api);
    registerJoin(api);
    registerExperiments(api);
    api.get("/quota", async () => quotaReport());

    // ── Resource data per tenant, provider and model (ids may hold a slash: a node's model is <node>/<model>) ────
    const stat = (fn: (id: string, range?: string) => unknown) => async (req: FastifyRequest, reply: FastifyReply) =>
      fn((req.params as { "*": string })["*"], (req.query as { range?: string }).range) ?? reply.code(404).send({ error: "not found" });
    api.get("/stats/model/*", stat(modelResources));
    api.get("/stats/provider/*", stat(providerResources));
    api.get("/stats/tenant/*", stat(tenantResources));

    // ── Logs: the end of mux's own log or a model server's, filtered ───────────────────────────────────────────
    api.get("/logs", async (req, reply) => {
      const q = req.query as { source?: string; model?: string; grep?: string; lines?: string };
      if (q.source === "model" && !/^[a-z0-9][a-z0-9._/-]*$/i.test(q.model ?? "")) return reply.code(400).send({ error: "a model id is required" });
      if (q.model?.includes("..")) return reply.code(400).send({ error: "a model id is required" });
      const p = q.source === "model" ? join(config.logsDir, "models", `${q.model}.log`) : join(config.logsDir, "mux.log");
      if (!existsSync(p)) return { log: "", note: q.source === "model" ? "this model has no log here (it has not run on this machine)" : "no mux.log on this machine: here mux logs to stdout (on Railway, see the service's logs); GET /events has what mux recorded" };
      return { log: tail(p, Math.min(Number(q.lines) || 120, 400), q.grep), path: p };
    });

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

/** A node model's state on its node, as of the last sync, in the shape of a local instance. */
function remoteInstance(m: Model, p: Provider | undefined) {
  if (m.backend !== "node" || !p?.info?.instances) return null;
  const i = p.info.instances.find((x) => x.id === m.upstream_model);
  return i ? { ...i, remote: true } : null;
}

/** The last `lines` lines of a file (from its last 4 MB), only those containing `grep` when given. */
function tail(path: string, lines: number, grep?: string): string {
  const size = statSync(path).size;
  const start = Math.max(0, size - 4 * 1024 * 1024);
  const fd = openSync(path, "r");
  const buf = Buffer.alloc(size - start);
  try { readSync(fd, buf, 0, buf.length, start); } finally { closeSync(fd); }
  let all = buf.toString("utf8").split("\n");
  if (start > 0) all = all.slice(1);
  if (grep) { const g = grep.toLowerCase(); all = all.filter((l) => l.toLowerCase().includes(g)); }
  return all.slice(-lines).join("\n");
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
