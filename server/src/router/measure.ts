import { randomBytes } from "node:crypto";
import { db, now } from "../db.js";
import { getModel, getRoute } from "../models.js";
import { acquire, ModelUnavailable, release, upstreamFor } from "../runtime/manager.js";
import type { Tenant } from "../tenants.js";
import { MuxError } from "./errors.js";
import { recordFailure, recordSuccess } from "./health.js";
import type { Ctx } from "./metering.js";
import { decide } from "./select.js";
import { ask, failed, upstreamError } from "./video.js";

/**
 * Measure (Thread's Reference Build, stage 2): routes `depth` and `reconstruct` (kinds of the same names), both answered by
 * the measure server (server/measure/measure_server.py on the Mac, :8314). Depth is one request and answer
 * (router/audio.ts `runDepth`, like images). A reconstruction is an async job, as video is: POST /v1/reconstruct
 * answers 202 with an id; GET /v1/reconstruct/{id} says how it is going and holds the result once it has succeeded;
 * /cancel stops it. On the Railway gateway the job goes to the node that has the model, which keeps its own job of it.
 *
 * Each mux in the way gives the caller an id of its own and remembers, per tenant, which model and which upstream id
 * it stands for: a tenant can only see its own jobs. The photos are never logged.
 */
db.exec(`CREATE TABLE IF NOT EXISTS measure_jobs (
  id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, model_id TEXT NOT NULL, upstream_id TEXT NOT NULL, created_at INTEGER NOT NULL)`);

/** A reconstruction is kept by the measure server for an hour after it ends; its row here a while longer, then it goes. */
const ROW_KEEP_MS = 26 * 3600_000;

interface JobRow { id: string; tenant_id: string; model_id: string; upstream_id: string; created_at: number }

/**
 * The name to route a measure request by: a `model` that names a route or model of this kind is used as it is (a node
 * is asked for its model by name); anything else, or nothing, is the route of the same name as the kind, named
 * outright so the tenant's allowed routes apply. Kinds keep a reconstruction off the depth model and back.
 */
export function measureName(model: unknown, kind: "depth" | "reconstruct"): string {
  const asked = typeof model === "string" ? model.trim().replace(/^mux\//, "") : "";
  if (asked && (getRoute(asked)?.kind === kind || getModel(asked)?.kind === kind)) return asked;
  const route = getRoute(kind);
  if (!route || route.kind !== kind) throw new MuxError(503, "route_missing", `this mux has no route ${kind}: run deploy/measure.sh on the Mac`);
  return kind;
}

/** POST /v1/reconstruct: start the job where the route's model runs, and answer with mux's id for it. */
export async function createReconstruction(ctx: Ctx, body: Record<string, unknown>, signal: AbortSignal): Promise<Record<string, unknown>> {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new MuxError(400, "invalid_request", "the body must be a JSON object");
  const imgs = body.images_b64;
  if (!Array.isArray(imgs) || imgs.length < 2 || imgs.length > 12) throw new MuxError(400, "invalid_request", "images_b64 must be a list of 2 to 12 photos (base64)");
  const requested = measureName(body.model, "reconstruct");
  const d = decide(ctx.tenant, requested, "reconstruct", null);
  ctx.experiment = d.experiment ?? null;
  ctx.route = d.route?.name ?? null;
  ctx.reason = d.reason;
  ctx.requested = requested;
  db.prepare("DELETE FROM measure_jobs WHERE created_at < ?").run(now() - ROW_KEEP_MS);
  let last = "";
  for (const [i, m] of (ctx.noFallback ? d.candidates.slice(0, 1) : d.candidates).entries()) {
    if (i > 0) ctx.fallbacks = i;
    let up;
    try { up = await acquire(m); } catch (e) {
      // This machine resting (presence) is not the model failing: no cooldown for it
      if (!(e instanceof ModelUnavailable && e.type === "node_resting")) recordFailure(m.id);
      last = `${m.id}: ${(e as Error).message}`;
      continue;
    }
    ctx.modelId = m.id;
    const tu = performance.now();
    try {
      const res = await fetch(`${up.baseUrl}/reconstruct`, {
        method: "POST", headers: { ...up.headers, "content-type": "application/json" },
        body: JSON.stringify({ ...body, model: up.model }), signal,
      });
      ctx.upstreamMs = (ctx.upstreamMs ?? 0) + (performance.now() - tu);
      if (res.ok) {
        const job = (await res.json()) as Record<string, unknown>;
        if (typeof job.id !== "string") throw new Error("the measure server answered without an id");
        const id = `recon_${randomBytes(12).toString("hex")}`;
        db.prepare("INSERT INTO measure_jobs(id, tenant_id, model_id, upstream_id, created_at) VALUES(?, ?, ?, ?, ?)").run(id, ctx.tenant.id, m.id, job.id, now());
        recordSuccess(m.id, null, null);
        return { ...job, id, model: job.model ?? m.id };
      }
      const err = await upstreamError(res);
      // The request itself is wrong (or the queue is full there): another model would say the same
      if (res.status < 500 && res.status !== 429) throw new MuxError(res.status, err.type ?? "invalid_request", err.message);
      if (res.status !== 429) recordFailure(m.id);
      last = `${m.id}: HTTP ${res.status} ${err.message.slice(0, 200)}`;
    } catch (e) {
      if (e instanceof MuxError || signal.aborted) throw e;
      recordFailure(m.id);
      last = `${m.id}: ${(e as Error).message}`;
    } finally {
      release(m.id);
    }
  }
  throw new MuxError(503, "all_models_failed", last || "no reconstruction model could take the request");
}

function jobOf(tenant: Tenant, id: string): { row: JobRow; base: string; headers: Record<string, string> } {
  const row = db.prepare("SELECT * FROM measure_jobs WHERE id = ? AND tenant_id = ?").get(id, tenant.id) as JobRow | undefined;
  if (!row) throw new MuxError(404, "not_found", "no such reconstruction (or it expired: they are kept 1 hour)");
  const m = getModel(row.model_id);
  if (!m) throw new MuxError(404, "not_found", `the model that made this reconstruction (${row.model_id}) is gone`);
  const up = upstreamFor(m);
  return { row, base: up.baseUrl, headers: up.headers };
}

/** GET /v1/reconstruct/{id}: the job as the measure server says (with its result once done), under mux's id. */
export async function reconstructionStatus(tenant: Tenant, id: string, signal?: AbortSignal): Promise<Record<string, unknown>> {
  const { row, base, headers } = jobOf(tenant, id);
  // A succeeded job carries its point cloud (megabytes): time enough to bring it across
  const res = await ask(`${base}/reconstruct/${encodeURIComponent(row.upstream_id)}`, { headers }, signal, 120_000);
  if (!res.ok) return failed(res);
  return { ...((await res.json()) as Record<string, unknown>), id };
}

/** POST /v1/reconstruct/{id}/cancel. */
export async function cancelReconstruction(tenant: Tenant, id: string, signal?: AbortSignal): Promise<Record<string, unknown>> {
  const { row, base, headers } = jobOf(tenant, id);
  const res = await ask(`${base}/reconstruct/${encodeURIComponent(row.upstream_id)}/cancel`, { method: "POST", headers }, signal, 15_000);
  if (!res.ok) return failed(res);
  return { ...((await res.json()) as Record<string, unknown>), id };
}
