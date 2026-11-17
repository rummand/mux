import { randomBytes } from "node:crypto";
import { db, now } from "../db.js";
import { getModel, getRoute } from "../models.js";
import { acquire, ModelUnavailable, release, upstreamFor } from "../runtime/manager.js";
import type { Tenant } from "../tenants.js";
import { MuxError } from "./errors.js";
import { recordFailure, recordSuccess } from "./health.js";
import type { Ctx } from "./metering.js";
import { decide, RouteError } from "./select.js";
import { ask, failed, upstreamError } from "./video.js";

/**
 * Backdrops (Thread's Sets: a 360° world beyond the set's edge), route and kind `backdrop`, answered by the backdrop
 * server (server/backdrop/backdrop_server.py on the Mac, :8316): an async job, as video is. POST /v1/backdrops answers
 * 202 with an id; GET /v1/backdrops/{id} says how it is going (and, once succeeded, the horizon and the depth's scale);
 * /panorama, /depth and /dome give the three files; /cancel stops it. On the Railway gateway the job goes to the node
 * that has the model, which keeps its own job of it.
 *
 * Each mux in the way gives the caller an id of its own and remembers, per tenant, which model and which upstream id
 * it stands for: a tenant can only see its own jobs. Prompts and images are never logged. When the Mac cannot take a
 * backdrop (its presence, its memory, its queue) the answer is 503 all_models_failed, saying why in words.
 */
db.exec(`CREATE TABLE IF NOT EXISTS backdrop_jobs (
  id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, model_id TEXT NOT NULL, upstream_id TEXT NOT NULL, created_at INTEGER NOT NULL)`);

/** A backdrop is kept by the backdrop server for an hour after it ends; its row here a while longer, then it goes. */
const ROW_KEEP_MS = 26 * 3600_000;

export const BACKDROP_FILES = { panorama: "image/png", depth: "image/png", dome: "model/gltf-binary" } as const;
export type BackdropFile = keyof typeof BACKDROP_FILES;

interface JobRow { id: string; tenant_id: string; model_id: string; upstream_id: string; created_at: number }

/** The route to send a backdrop to: one the caller names if it is a backdrop route or model, else `backdrop`. */
function routeName(model: unknown): string {
  const asked = typeof model === "string" ? model.trim().replace(/^mux\//, "") : "";
  if (asked && (getRoute(asked)?.kind === "backdrop" || getModel(asked)?.kind === "backdrop")) return asked;
  const route = getRoute("backdrop");
  if (!route || route.kind !== "backdrop") throw new MuxError(503, "route_missing", "this mux has no route backdrop: run deploy/backdrop.sh on the Mac");
  return "backdrop";
}

/** POST /v1/backdrops: start the job where the route's model runs, and answer with mux's id for it. */
export async function createBackdrop(ctx: Ctx, body: Record<string, unknown>, signal: AbortSignal): Promise<Record<string, unknown>> {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new MuxError(400, "invalid_request", "the body must be a JSON object");
  if (typeof body.prompt !== "string" || !body.prompt.trim()) throw new MuxError(400, "invalid_request", "prompt is required: words for the place to make");
  if (body.size !== undefined && body.size !== "1920x960") throw new MuxError(400, "invalid_request", 'size must be "1920x960" (the only size: an equirectangular 2:1 panorama)');
  const requested = routeName(body.model);
  let d;
  try { d = decide(ctx.tenant, requested, "backdrop", null); } catch (e) {
    // Every backdrop model out for now (its machine busy or away, cooling down): the contract's 503, in words
    if (e instanceof RouteError && e.status === 503) throw new MuxError(503, "all_models_failed", `no backdrop can be made now: ${e.message}`);
    throw e;
  }
  ctx.experiment = d.experiment ?? null;
  ctx.route = d.route?.name ?? null;
  ctx.reason = d.reason;
  ctx.requested = requested;
  db.prepare("DELETE FROM backdrop_jobs WHERE created_at < ?").run(now() - ROW_KEEP_MS);
  const why: string[] = [];
  for (const [i, m] of (ctx.noFallback ? d.candidates.slice(0, 1) : d.candidates).entries()) {
    if (i > 0) ctx.fallbacks = i;
    let up;
    try { up = await acquire(m); } catch (e) {
      // The machine resting (presence) or short of memory for now is not the model failing: no cooldown for it
      const busy = e instanceof ModelUnavailable && (e.type === "node_resting" || e.type === "memory_busy");
      if (!busy) recordFailure(m.id);
      why.push((e as Error).message);
      continue;
    }
    ctx.modelId = m.id;
    const tu = performance.now();
    try {
      const res = await fetch(`${up.baseUrl}/backdrops`, {
        method: "POST", headers: { ...up.headers, "content-type": "application/json" },
        body: JSON.stringify({ ...body, model: up.model }), signal,
      });
      ctx.upstreamMs = (ctx.upstreamMs ?? 0) + (performance.now() - tu);
      if (res.ok) {
        const job = (await res.json()) as Record<string, unknown>;
        if (typeof job.id !== "string") throw new Error("the backdrop server answered without an id");
        const id = `backdrop_${randomBytes(12).toString("hex")}`;
        db.prepare("INSERT INTO backdrop_jobs(id, tenant_id, model_id, upstream_id, created_at) VALUES(?, ?, ?, ?, ?)").run(id, ctx.tenant.id, m.id, job.id, now());
        recordSuccess(m.id, null, null);
        return { ...job, id, model: "backdrop" };
      }
      const err = await upstreamError(res);
      // The request itself is wrong: another model would say the same
      if (res.status < 500 && res.status !== 429) throw new MuxError(res.status, err.type ?? "invalid_request", err.message);
      // Busy there (its queue, its memory) or a node whose own models could not: not this model failing
      if (res.status !== 429 && err.type !== "all_models_failed") recordFailure(m.id);
      why.push(res.status === 429 || err.type === "all_models_failed" ? err.message : `${m.id}: HTTP ${res.status} ${err.message.slice(0, 200)}`);
    } catch (e) {
      if (e instanceof MuxError || signal.aborted) throw e;
      recordFailure(m.id);
      why.push(`${m.id}: ${(e as Error).message}`);
    } finally {
      release(m.id);
    }
  }
  throw new MuxError(503, "all_models_failed", why.length ? `no backdrop can be made now: ${[...new Set(why)].join("; ")}` : "no backdrop model is set up: run deploy/backdrop.sh on the Mac");
}

function jobOf(tenant: Tenant, id: string): { row: JobRow; base: string; headers: Record<string, string> } {
  const row = db.prepare("SELECT * FROM backdrop_jobs WHERE id = ? AND tenant_id = ?").get(id, tenant.id) as JobRow | undefined;
  if (!row) throw new MuxError(404, "not_found", "no such backdrop (or it expired: backdrops are kept 1 hour)");
  const m = getModel(row.model_id);
  if (!m) throw new MuxError(404, "not_found", `the model that made this backdrop (${row.model_id}) is gone`);
  const up = upstreamFor(m);
  return { row, base: up.baseUrl, headers: up.headers };
}

/** GET /v1/backdrops/{id}: the job as the backdrop server says, under mux's id. */
export async function backdropStatus(tenant: Tenant, id: string, signal?: AbortSignal): Promise<Record<string, unknown>> {
  const { row, base, headers } = jobOf(tenant, id);
  const res = await ask(`${base}/backdrops/${encodeURIComponent(row.upstream_id)}`, { headers }, signal, 15_000);
  if (!res.ok) return failed(res);
  return { ...((await res.json()) as Record<string, unknown>), id, model: "backdrop" };
}

/** GET /v1/backdrops/{id}/panorama | depth | dome: the file, as it came. */
export async function backdropFile(tenant: Tenant, id: string, file: BackdropFile, signal?: AbortSignal): Promise<{ type: string; body: Buffer }> {
  const { row, base, headers } = jobOf(tenant, id);
  const res = await ask(`${base}/backdrops/${encodeURIComponent(row.upstream_id)}/${file}`, { headers }, signal, 120_000);
  if (!res.ok) return failed(res);
  return { type: res.headers.get("content-type") ?? BACKDROP_FILES[file], body: Buffer.from(await res.arrayBuffer()) };
}

/** POST /v1/backdrops/{id}/cancel. */
export async function cancelBackdrop(tenant: Tenant, id: string, signal?: AbortSignal): Promise<Record<string, unknown>> {
  const { row, base, headers } = jobOf(tenant, id);
  const res = await ask(`${base}/backdrops/${encodeURIComponent(row.upstream_id)}/cancel`, { method: "POST", headers }, signal, 15_000);
  if (!res.ok) return failed(res);
  return { ...((await res.json()) as Record<string, unknown>), id };
}
