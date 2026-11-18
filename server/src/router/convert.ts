import { settings } from "../db.js";
import { getModel, getRoute } from "../models.js";
import type { Tenant } from "../tenants.js";
import { runDocument } from "./audio.js";
import { MuxError } from "./errors.js";
import type { Ctx } from "./metering.js";

/**
 * Documents to PDF (bloom for business's Desk draws Word and PowerPoint pages from them; the owner, 19 November 2026):
 * POST /v1/convert {file_b64, filename?, model?} on the route `convert`, kind `document`, answered by the converter on
 * the Mac (server/convert/convert_server.mjs, :8318, LibreOffice headless under a macOS sandbox with the network
 * denied). On the Railway gateway the route names the node's model (`mac-studio/libreoffice`) and the call is passed
 * on as the gateway's tenant there, metered on both like any call. The file is never logged.
 *
 * Two gates before anything is sent: the tenant's own allowed routes (as for every route), and `settings.convertTenants`
 * — the route is open to the tenants named there only, also to a tenant whose allowed list is empty (every route).
 */
export const CONVERT_MAX_BYTES = 25 * 1024 * 1024;
/** The JSON body: the file as base64 (4/3 of it) and a little more. */
export const CONVERT_BODY_LIMIT = Math.ceil((CONVERT_MAX_BYTES * 4) / 3) + 1024 * 1024;

/** A `model` that names a route or model of kind document is used as it is (a node is asked for its model by name); else `convert`. */
export function convertName(model: unknown): string {
  const asked = typeof model === "string" ? model.trim().replace(/^mux\//, "") : "";
  if (asked && (getRoute(asked)?.kind === "document" || getModel(asked)?.kind === "document")) return asked;
  const route = getRoute("convert");
  if (!route || route.kind !== "document") throw new MuxError(503, "route_missing", "this mux has no route convert: run deploy/convert.sh on the Mac");
  return "convert";
}

export function convertAllowed(tenant: Tenant): boolean {
  const list = settings().convertTenants;
  return Array.isArray(list) && list.includes(tenant.id);
}

/** The decoded size of a base64 string, without decoding it. */
const decodedSize = (b64: string) => Math.floor((b64.length * 3) / 4) - (b64.endsWith("==") ? 2 : b64.endsWith("=") ? 1 : 0);

export async function runConvert(ctx: Ctx, body: unknown, signal: AbortSignal): Promise<Response> {
  if (!convertAllowed(ctx.tenant)) throw new MuxError(403, "permission_denied", "this key may not use route convert (settings.convertTenants)");
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new MuxError(400, "invalid_request", "the body must be a JSON object");
  const b = body as Record<string, unknown>;
  if (typeof b.file_b64 !== "string" || !b.file_b64) throw new MuxError(400, "invalid_request", "file_b64 (the file, base64) is required");
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(b.file_b64)) throw new MuxError(400, "invalid_request", "file_b64 is not base64");
  const size = decodedSize(b.file_b64);
  if (size > CONVERT_MAX_BYTES) throw new MuxError(413, "file_too_large", `the file is ${size} bytes; at most ${CONVERT_MAX_BYTES} are converted`);
  const requested = convertName(b.model);
  // Only what the converter reads goes on: no name of the file, nothing else the caller sent.
  return runDocument(ctx, requested, Buffer.from(JSON.stringify({ file_b64: b.file_b64 })), signal);
}
