#!/usr/bin/env node
/**
 * Move Nexus's models onto mux (run once, after install.sh): the Qwen3.6 and bge-m3 GGUFs Nexus already has are
 * imported (linked, not copied) with the flags Nexus ran them with, Nexus becomes a tenant whose key is the one Caddy
 * already checks, and the routes get their first candidates. Nothing of Nexus's is stopped here; cutover.sh does that.
 *
 *   node deploy/migrate-nexus.mjs
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const env = (file) => Object.fromEntries(readFileSync(file, "utf8").split("\n").filter((l) => /^[A-Z_]+=/.test(l)).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]));
const mux = env(join(homedir(), ".mux/mux.env"));
const nexus = env(join(homedir(), ".nexus/etc/llm.env"));
const BASE = `http://127.0.0.1:${mux.MUX_PORT ?? 7070}/api/admin`;

async function api(method, path, body) {
  const r = await fetch(BASE + path, { method, headers: { authorization: `Bearer ${mux.MUX_ADMIN_TOKEN}`, "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  const text = await r.text();
  if (!r.ok) throw new Error(`${method} ${path}: ${r.status} ${text}`);
  return text ? JSON.parse(text) : null;
}

const models = await api("GET", "/models");
const has = (id) => models.some((m) => m.id === id);

// Qwen3.6-35B-A3B, as com.nexus.llm ran it: Atlas's turns open with the same 8–18k tokens, so context checkpoints and a
// 12 GiB prompt cache keep that work between turns. Pinned: Atlas is live, the model stays loaded.
if (!has("qwen3.6-35b-a3b")) await api("POST", "/local/import", { path: nexus.LLM_GGUF, id: "qwen3.6-35b-a3b", catalogId: "qwen3.6-35b-a3b" });
await api("PATCH", "/models/qwen3.6-35b-a3b", {
  ctx: Number(nexus.LLM_CONTEXT ?? 131072), parallel: 2, reasoning: "off", pinned: true, keep_alive_min: 0,
  extra_args: ["--kv-unified", "--cache-ram", "12288", "--cache-idle-slots", "--ctx-checkpoints", "8", "--checkpoint-min-step", "4096", "--slot-save-path", join(homedir(), ".mux/slots")],
});
console.log("✓ qwen3.6-35b-a3b (pinned, 131k context, Nexus's cache flags)");

if (!has("bge-m3")) await api("POST", "/local/import", { path: nexus.EMBED_GGUF, id: "bge-m3", catalogId: "bge-m3", kind: "embedding" });
await api("PATCH", "/models/bge-m3", { ctx: 8192, parallel: 2, pinned: true, extra_args: ["--pooling", "cls"] });
console.log("✓ bge-m3 (pinned)");

// Nexus: the key Caddy checks on :8091 is the key mux checks too, so Nexus on Railway changes nothing.
const tenants = await api("GET", "/tenants");
if (!tenants.some((t) => t.id === "nexus")) {
  await api("PUT", "/tenants/nexus", { name: "Nexus", description: "Nexus platform: Atlas chat, Finding by meaning (via Caddy :8091 / Tailscale Funnel)", color: "#22c55e", default_route: "agent", max_parallel: 0 });
  await api("POST", "/tenants/nexus/keys", { name: "caddy chat key (from llm.env)", value: nexus.LLM_KEY });
  console.log("✓ tenant nexus, with the Chat key Caddy already checks");
}
if (nexus.LAN_LLM_KEY && !tenants.some((t) => t.id === "lan")) {
  await api("PUT", "/tenants/lan", { name: "Home LAN tools", description: "opencode and other tools on the home network", color: "#f59e0b", default_route: "code" });
  await api("POST", "/tenants/lan/keys", { name: "LAN key (from llm.env)", value: nexus.LAN_LLM_KEY });
  console.log("✓ tenant lan, with the LAN key");
}

// Routes: what is on the Mac now, best first. auto has no list: it scores every chat model per request.
const ids = (await api("GET", "/models")).map((m) => m.id);
const only = (...xs) => xs.filter((x) => ids.includes(x));
const set = async (name, candidates) => { const r = (await api("GET", "/routes")).find((x) => x.name === name); await api("PUT", `/routes/${name}`, { ...r, candidates }); };
await set("agent", only("qwen3.6-35b-a3b", "qwen3.5-4b", "qwen3.5-0.8b"));
await set("smart", only("qwen3.6-35b-a3b"));
await set("code", only("qwen3.6-35b-a3b"));
await set("multilingual", only("qwen3.6-35b-a3b"));
await set("fast", only("qwen3.5-4b", "qwen3.5-0.8b", "qwen3.6-35b-a3b"));
await set("embed", only("bge-m3", "qwen3-embedding-0.6b"));
await set("rerank", only("qwen3-reranker-0.6b"));
await set("systemone", only("laya-gguf", "laya"));
console.log("✓ routes:", ids.join(", "));
