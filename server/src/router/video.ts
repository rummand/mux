import { randomBytes } from "node:crypto";
import { db, now } from "../db.js";
import { getModel, getRoute, listModels, type Kind } from "../models.js";
import { acquire, ModelUnavailable, release, upstreamFor } from "../runtime/manager.js";
import type { Tenant } from "../tenants.js";
import { MuxError } from "./errors.js";
import { recordFailure, recordSuccess } from "./health.js";
import type { Ctx } from "./metering.js";
import { decide } from "./select.js";

/**
 * Video as async jobs (routes `video`, `video-depth`, `video-camera` and `video-subject`): POST /v1/videos/generations starts one and
 * answers 202 with an id; GET /v1/videos/{id} says how it is going, /content gives the mp4, /cancel stops it. The
 * video server (server/video/video_server.py on the Mac, :8313) does the work, and for `video-camera` the camera
 * server (server/video/camera_server.py, :8315, its models of kind "video-camera"), for `video-subject` the subject
 * server (server/video/subject_server.py, :8317, Phantom-Wan, kind "video-subject"); on the Railway gateway the job
 * goes to the node that has the model, which keeps its own job of it.
 *
 * `video-camera` is a kind of its own so that the two never stand in for each other: a route that lists no models
 * takes every model of its kind, and a Wan model would otherwise make a take while ignoring its camera, or a camera
 * model refuse a plain request. `video-subject` (a subject from reference pictures, no first frame or control) is its
 * own kind for the same reason.
 *
 * Each mux in the way gives the caller an id of its own and remembers, per tenant, which model and which upstream id
 * it stands for: a tenant can only see its own jobs, and the status and content are read from where the job runs
 * even when that machine's presence would take nothing new. Prompts and media are never logged.
 */
db.exec(`CREATE TABLE IF NOT EXISTS video_jobs (
  id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, model_id TEXT NOT NULL, upstream_id TEXT NOT NULL, created_at INTEGER NOT NULL)`);

/** A job is kept by the video server for an hour after it ends; its row here a while longer, then it goes. */
const ROW_KEEP_MS = 26 * 3600_000;

interface JobRow { id: string; tenant_id: string; model_id: string; upstream_id: string; created_at: number }

/** The upstream's error message, from its JSON when it has one. */
export async function upstreamError(res: Response): Promise<{ message: string; type?: string }> {
  const text = (await res.text()).slice(0, 1000);
  try {
    const e = (JSON.parse(text) as { error?: { message?: string; type?: string } }).error;
    if (e?.message) return { message: e.message, type: e.type };
  } catch { /* plain text */ }
  return { message: text.slice(0, 300) || `HTTP ${res.status}` };
}

/** Whether the caller named a route or model of this kind (after its aliases, with or without "mux/"). */
function asksForKind(tenant: Tenant, requested: string | undefined, kind: Kind): boolean {
  if (!requested) return false;
  const named = (tenant.aliases[requested.trim()] ?? requested.trim()).replace(/^mux\//, "");
  return getRoute(named)?.kind === kind || getModel(named)?.kind === kind
    || listModels().some((m) => m.kind === kind && m.upstream_model === named);
}

/** Whether the caller named the camera route or a camera model. */
export function asksForCamera(tenant: Tenant, requested: string | undefined): boolean {
  return asksForKind(tenant, requested, "video-camera");
}

/** POST /v1/videos/generations: pick a video model, start the job there, and answer with mux's id for it. */
export async function createVideo(ctx: Ctx, body: Record<string, unknown>, signal: AbortSignal): Promise<Record<string, unknown>> {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new MuxError(400, "invalid_request", "the body must be a JSON object");
  const requested = typeof body.model === "string" ? body.model : undefined;
  if (requested === "video-depth" && !body.control) throw new MuxError(400, "invalid_request", "video-depth needs control: {type: \"depth\", video_b64, format}");
  const kind: Kind = asksForCamera(ctx.tenant, requested) ? "video-camera" : asksForKind(ctx.tenant, requested, "video-subject") ? "video-subject" : "video";
  if (kind === "video-subject") {
    const refs = body.reference_images_b64;
    if (!Array.isArray(refs) || !refs.length || refs.some((r) => typeof r !== "string" || !r)) throw new MuxError(400, "invalid_request", "video-subject needs reference_images_b64: 1 to 4 pictures of the subject, on white");
  }
  if (kind === "video-camera") {
    // Checked here so a request that can never work does not wake the Mac; the camera server checks the rest
    const cam = body.camera as Record<string, unknown> | undefined;
    if (!cam || typeof cam !== "object" || !Array.isArray(cam.frames) || !cam.frames.length) throw new MuxError(400, "invalid_request", "video-camera needs camera: {convention: \"sets\", sensorMm, aspect, frames: [{t, pos, quat, focalMm}]}");
    if (typeof body.image_b64 !== "string" || !body.image_b64) throw new MuxError(400, "invalid_request", "video-camera needs image_b64: the first frame of the take");
  }
  const d = decide(ctx.tenant, requested, kind, null);
  ctx.experiment = d.experiment ?? null;
  ctx.route = d.route?.name ?? null;
  ctx.reason = d.reason;
  ctx.requested = requested;
  db.prepare("DELETE FROM video_jobs WHERE created_at < ?").run(now() - ROW_KEEP_MS);
  let last = "";
  for (const [i, m] of (ctx.noFallback ? d.candidates.slice(0, 1) : d.candidates).entries()) {
    if (i > 0) ctx.fallbacks = i;
    let up;
    try { up = await acquire(m); } catch (e) {
      // This machine resting (presence) or short of memory is not the model failing: no cooldown for it
      if (!(e instanceof ModelUnavailable && (e.type === "node_resting" || e.type === "memory_busy"))) recordFailure(m.id);
      last = `${m.id}: ${(e as Error).message}`;
      continue;
    }
    ctx.modelId = m.id;
    const tu = performance.now();
    try {
      // The route the caller named goes on as the model's own name; video-depth's control and video-camera's camera
      // are checked above
      const res = await fetch(`${up.baseUrl}/videos/generations`, {
        method: "POST", headers: { ...up.headers, "content-type": "application/json" },
        body: JSON.stringify({ ...body, model: up.model }), signal,
      });
      ctx.upstreamMs = (ctx.upstreamMs ?? 0) + (performance.now() - tu);
      if (res.ok) {
        const job = (await res.json()) as Record<string, unknown>;
        if (typeof job.id !== "string") throw new Error("the video server answered without an id");
        const id = `video_${randomBytes(12).toString("hex")}`;
        db.prepare("INSERT INTO video_jobs(id, tenant_id, model_id, upstream_id, created_at) VALUES(?, ?, ?, ?, ?)").run(id, ctx.tenant.id, m.id, job.id, now());
        recordSuccess(m.id, null, null);
        return { ...job, id, model: job.model ?? m.id };
      }
      const err = await upstreamError(res);
      // The request itself is wrong (or the queue is full there): another model would say the same
      if (res.status < 500 && res.status !== 429) throw new MuxError(res.status, err.type ?? "invalid_request", err.message);
      if (res.status !== 429 && err.type !== "memory_busy") recordFailure(m.id);   // busy or short of memory is not failing
      last = `${m.id}: HTTP ${res.status} ${err.message.slice(0, 200)}`;
    } catch (e) {
      if (e instanceof MuxError || signal.aborted) throw e;
      recordFailure(m.id);
      last = `${m.id}: ${(e as Error).message}`;
    } finally {
      release(m.id);
    }
  }
  throw new MuxError(503, "all_models_failed", last || "no video model could take the request");
}

function jobOf(tenant: Tenant, id: string): { row: JobRow; base: string; headers: Record<string, string> } {
  const row = db.prepare("SELECT * FROM video_jobs WHERE id = ? AND tenant_id = ?").get(id, tenant.id) as JobRow | undefined;
  if (!row) throw new MuxError(404, "not_found", "no such video (or it expired: videos are kept 1 hour)");
  const m = getModel(row.model_id);
  if (!m) throw new MuxError(404, "not_found", `the model that made this video (${row.model_id}) is gone`);
  const up = upstreamFor(m);
  return { row, base: up.baseUrl, headers: up.headers };
}

export async function ask(url: string, init: RequestInit & { headers: Record<string, string> }, signal: AbortSignal | undefined, timeoutMs: number): Promise<Response> {
  try {
    return await fetch(url, { ...init, signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs) });
  } catch (e) {
    throw new MuxError(502, "upstream_unreachable", `the machine doing this job did not answer: ${(e as Error).message}`);
  }
}

export async function failed(res: Response): Promise<never> {
  const err = await upstreamError(res);
  throw new MuxError(res.status, err.type ?? (res.status === 404 ? "not_found" : "upstream_error"), err.message);
}

/** GET /v1/videos/{id}: the job as the video server says, under mux's id. */
export async function videoStatus(tenant: Tenant, id: string, signal?: AbortSignal): Promise<Record<string, unknown>> {
  const { row, base, headers } = jobOf(tenant, id);
  const res = await ask(`${base}/videos/${encodeURIComponent(row.upstream_id)}`, { headers }, signal, 15_000);
  if (!res.ok) return failed(res);
  return { ...((await res.json()) as Record<string, unknown>), id };
}

/** GET /v1/videos/{id}/content: the mp4. */
export async function videoContent(tenant: Tenant, id: string, signal?: AbortSignal): Promise<{ type: string; body: Buffer }> {
  const { row, base, headers } = jobOf(tenant, id);
  const res = await ask(`${base}/videos/${encodeURIComponent(row.upstream_id)}/content`, { headers }, signal, 300_000);
  if (!res.ok) return failed(res);
  return { type: res.headers.get("content-type") ?? "video/mp4", body: Buffer.from(await res.arrayBuffer()) };
}

/** POST /v1/videos/{id}/cancel. */
export async function cancelVideo(tenant: Tenant, id: string, signal?: AbortSignal): Promise<Record<string, unknown>> {
  const { row, base, headers } = jobOf(tenant, id);
  const res = await ask(`${base}/videos/${encodeURIComponent(row.upstream_id)}/cancel`, { method: "POST", headers }, signal, 15_000);
  if (!res.ok) return failed(res);
  return { ...((await res.json()) as Record<string, unknown>), id };
}
