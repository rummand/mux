import { createServer, request } from "node:http";
import { config } from "./config.js";
import { db, event } from "./db.js";
import { createKey, getTenant, upsertTenant } from "./tenants.js";

/**
 * Old local ports, kept answering after mux replaced what listened on them: MUX_COMPAT="8099=nexus-build,8094=nexus"
 * opens each port on 127.0.0.1 only and passes every request to mux as that tenant (its own key, kept here), so a
 * service that called llama-server directly without a key keeps working and shows up in mux's numbers.
 */
function keyFor(tenantId: string, port: number): string {
  const name = `compat_key:${tenantId}:${port}`;
  const row = db.prepare("SELECT value FROM settings WHERE key = ?").get(name) as { value: string } | undefined;
  if (row) {
    const still = db.prepare("SELECT 1 FROM api_keys WHERE tenant_id = ? AND name = ? AND revoked_at IS NULL").get(tenantId, `localhost :${port}`);
    if (still) return JSON.parse(row.value);
  }
  const { key } = createKey(tenantId, `localhost :${port}`);
  db.prepare("INSERT INTO settings(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(name, JSON.stringify(key));
  return key;
}

export function startCompat() {
  const spec = process.env.MUX_COMPAT ?? "";
  for (const pair of spec.split(",").map((s) => s.trim()).filter(Boolean)) {
    const [portStr, tenantId] = pair.split("=");
    const port = Number(portStr);
    if (!port || !tenantId) continue;
    if (!getTenant(tenantId)) upsertTenant({ id: tenantId, name: tenantId, description: `Local callers of 127.0.0.1:${port}`, default_route: "auto" });
    const key = keyFor(tenantId, port);
    const server = createServer((req, res) => {
      const headers: Record<string, string | string[] | undefined> = { ...req.headers, authorization: `Bearer ${key}`, host: `127.0.0.1:${config.port}` };
      delete headers["x-api-key"];
      const up = request({ host: "127.0.0.1", port: config.port, method: req.method, path: req.url, headers }, (r) => {
        res.writeHead(r.statusCode ?? 502, r.headers);
        r.pipe(res);
      });
      up.on("error", (e) => { res.writeHead(502, { "content-type": "application/json" }); res.end(JSON.stringify({ error: { message: e.message } })); });
      req.pipe(up);
      res.on("close", () => { if (!res.writableFinished) up.destroy(); });
    });
    // A port still held by what mux replaces is tried again until it is free.
    let warned = false;
    server.on("error", (e: NodeJS.ErrnoException) => {
      if (e.code === "EADDRINUSE") {
        if (!warned) event("warn", "compat", `127.0.0.1:${port} is still in use; trying every 10 s`);
        warned = true;
        setTimeout(() => server.listen(port, "127.0.0.1"), 10_000).unref();
      } else event("error", "compat", `127.0.0.1:${port} (${tenantId}): ${e.message}`);
    });
    server.on("listening", () => event("info", "compat", `127.0.0.1:${port} answers as tenant ${tenantId}`));
    server.listen(port, "127.0.0.1");
  }
}
