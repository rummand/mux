import type { Model } from "../models.js";
import { getProvider, presenceOf } from "../providers.js";

/**
 * Data borders: which machines a tenant's requests may run on. A SaaS whose customers' data may not leave our own
 * machines is "own"; one that should not run on a machine someone works at (a desktop, a laptop) is "servers".
 *
 *   any      anywhere: our machines and paid cloud APIs.
 *   own      our machines only: this one, our nodes, and model servers on our own network — never a cloud API.
 *   servers  our always-on machines only: this one and always-on nodes — not a desktop or laptop someone uses.
 *
 * The border is about where the model runs. A request still passes through the gateway that routes it.
 */
export type Border = "any" | "own" | "servers";
export const BORDERS: Border[] = ["any", "own", "servers"];

/** Where a model runs. */
export type Place = "here" | "server" | "shared" | "cloud";

/** Loopback, private networks, the tailnet and .local names: our own network. */
export const ownNetwork = (url: string) => {
  try {
    const h = new URL(url).hostname.replace(/^\[|\]$/g, "");
    return h === "localhost" || h === "::1" || /^127\./.test(h) || /^10\./.test(h) || /^192\.168\./.test(h) || /^172\.(1[6-9]|2\d|3[01])\./.test(h)
      || /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(h) || /\.local$/.test(h) || /\.ts\.net$/.test(h) || /^fd[0-9a-f]{2}:/i.test(h);
  } catch { return false; }
};

export function placeOf(m: Model): Place {
  if (["llamacpp", "mlx", "laya"].includes(m.backend)) return "here";
  if (m.backend === "node") {
    const cls = presenceOf(m.provider_id)?.class;
    return cls === "desktop" || cls === "laptop" ? "shared" : "server"; // a node from before presence is a server
  }
  if (m.backend === "jev") return "cloud";
  // external: an OpenAI-compatible server — ours if it is on our own network (Ollama, LM Studio, vLLM in the house).
  const base = m.base_url || (m.provider_id ? getProvider(m.provider_id)?.base_url : "") || "";
  return ownNetwork(base) ? "server" : "cloud";
}

/** Why a model is outside a tenant's border, or null when it is inside. */
export function outside(border: string | undefined, m: Model): string | null {
  if (!border || border === "any") return null;
  const p = placeOf(m);
  if (p === "cloud") return "a cloud API, outside the tenant's data border";
  if (border === "servers" && p === "shared") return "a machine someone works at, outside the tenant's data border (servers only)";
  return null;
}
