import { execFile } from "node:child_process";
import { hostname } from "node:os";
import { promisify } from "node:util";
import type { FastifyInstance } from "fastify";
import { config } from "./config.js";
import { db, event } from "./db.js";

/**
 * Joining a cluster from the machine itself (the menu bar's "Join the cluster"): what deploy/join-node.sh does, as an
 * API. The node tells the gateway how to reach it and hands it its admin token; the gateway checks it can, becomes a
 * tenant here and routes to this machine from then on.
 */
const run = promisify(execFile);
const out = (cmd: string, args: string[]) => run(cmd, args, { timeout: 4000 }).then((r) => r.stdout).catch(() => "");
const TAILSCALE = ["tailscale", "/Applications/Tailscale.app/Contents/MacOS/Tailscale"];

const slug = (s: string) => s.toLowerCase().replace(/\.local$/, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "node";

/** How a gateway could reach this machine: Tailscale Funnel (from anywhere, as the Mac Studio joins Railway), the tailnet, or the home network. */
async function ways(): Promise<{ label: string; url: string; note: string }[]> {
  const list: { label: string; url: string; note: string }[] = [];
  for (const bin of TAILSCALE) {
    const j = await out(bin, ["status", "--json"]);
    if (!j) continue;
    try {
      const self = (JSON.parse(j) as { Self?: { DNSName?: string; TailscaleIPs?: string[] } }).Self;
      const dns = self?.DNSName?.replace(/\.$/, "");
      if (dns) list.push({ label: "Tailscale Funnel", url: `https://${dns}/mux`, note: "from anywhere, a gateway on Railway too; publish first: tailscale funnel --bg --https=443 --set-path=/mux http://127.0.0.1:" + config.port });
      if (dns) list.push({ label: "Tailnet", url: `http://${dns}:${config.port}`, note: "for a gateway on the same tailnet" });
    } catch { /* not running */ }
    break;
  }
  const local = (await out("scutil", ["--get", "LocalHostName"])).trim() || hostname().replace(/\.local$/, "");
  list.push({ label: "Home network", url: `http://${local}.local:${config.port}`, note: "for a gateway in the same house" });
  return list;
}

export function registerJoin(api: FastifyInstance) {
  api.get("/join", async () => {
    const name = (await out("scutil", ["--get", "ComputerName"])).trim() || hostname();
    // Gateways that joined this node are its tenants named gateway-*.
    const gateways = db.prepare("SELECT t.id, t.name, MAX(k.last_used_at) last_used FROM tenants t LEFT JOIN api_keys k ON k.tenant_id = t.id AND k.revoked_at IS NULL WHERE t.id LIKE 'gateway-%' GROUP BY t.id").all();
    return { role: config.role, name, id: slug(name), ways: await ways(), gateways };
  });

  api.post("/join", async (req, reply) => {
    const b = (req.body ?? {}) as { gatewayUrl?: string; gatewayToken?: string; nodeUrl?: string; id?: string; name?: string };
    if (config.role === "gateway") return reply.code(400).send({ error: "this mux is a gateway: it routes to nodes, it does not join one" });
    if (!b.gatewayUrl || !b.gatewayToken || !b.nodeUrl) return reply.code(400).send({ error: "gatewayUrl, gatewayToken and nodeUrl are required" });
    const name = b.name?.trim() || hostname();
    const id = slug(b.id || name);
    const gw = b.gatewayUrl.replace(/\/+$/, "");
    // Can this machine be reached the way the gateway is told to? (From here; the gateway checks again from where it is.)
    const self = await fetch(`${b.nodeUrl.replace(/\/+$/, "")}/health`, { signal: AbortSignal.timeout(8000) }).then((r) => r.ok).catch(() => false);
    if (!self) return reply.code(400).send({ error: `${b.nodeUrl}/health does not answer from this machine: publish mux there first` });
    const r = await fetch(`${gw}/api/admin/providers/${encodeURIComponent(id)}`, {
      method: "PUT", signal: AbortSignal.timeout(30_000),
      headers: { authorization: `Bearer ${b.gatewayToken}`, "content-type": "application/json" },
      body: JSON.stringify({ kind: "mux", name, base_url: b.nodeUrl.replace(/\/+$/, ""), admin_token: config.adminToken }),
    }).catch((e: Error) => ({ ok: false, status: 0, text: async () => e.message }) as Response);
    const text = await r.text();
    if (!r.ok) return reply.code(502).send({ error: `the gateway answered ${r.status || "nothing"}: ${text.slice(0, 300)}` });
    const p = JSON.parse(text) as { id: string; name: string; status: string; error?: string | null; info?: { models?: number; latencyMs?: number } };
    event("info", "join", `joined ${gw} as ${p.id} (${p.status})`);
    return { ok: p.status === "online", provider: { id: p.id, name: p.name, status: p.status, error: p.error ?? null, models: p.info?.models ?? null, latencyMs: p.info?.latencyMs ?? null } };
  });
}
