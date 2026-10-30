import { ModelUnavailable } from "../runtime/manager.js";
import { LimitError } from "./limits.js";
import { RouteError } from "./select.js";

/** Every error a caller sees: an HTTP status, a machine-readable type, and a sentence. */
export class MuxError extends Error {
  constructor(public status: number, public type: string, message: string, public retryAfterS?: number) { super(message); }
}

export function toMuxError(e: unknown): MuxError {
  if (e instanceof MuxError) return e;
  if (e instanceof LimitError) return new MuxError(429, e.type, e.message, e.retryAfterS);
  if (e instanceof RouteError || e instanceof ModelUnavailable) return new MuxError(e.status, e.type, e.message);
  if (e instanceof Error && e.name === "AbortError") return new MuxError(499, "client_closed", "the caller went away");
  return new MuxError(500, "internal_error", e instanceof Error ? e.message : String(e));
}
