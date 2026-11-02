import type { FastifyInstance } from "fastify";
import { db, json, now } from "./db.js";
import { assistantKey, gateway } from "./self.js";

/**
 * mux's brain (after Garry Tan's GBrain): pages of memory the assistant and the doctor write as they work — how mux is
 * set up and why, decisions, what the user prefers, runbooks for problems already solved — and recall later. Each page
 * is embedded through mux's own `embed` route; search mixes that meaning with plain word matches, so the brain still
 * works when no embedding model is reachable.
 */
export const KINDS = ["fact", "runbook", "decision", "preference", "incident", "note"] as const;
export type PageKind = (typeof KINDS)[number];

export interface Page {
  id: string; title: string; kind: PageKind; subject: string; body: string; tags: string[]; source: string;
  recalls: number; recalled_at: number | null; created_at: number; updated_at: number; embedded: boolean;
}
export interface Hit extends Page { score: number }

interface Row { id: string; title: string; kind: string; subject: string | null; body: string; tags: string | null; source: string | null; embedding: Buffer | null; embed_model: string | null; recalls: number; recalled_at: number | null; created_at: number; updated_at: number }

const BODY_CHARS = 20_000;
const fromRow = (r: Row): Page => ({
  id: r.id, title: r.title, kind: (KINDS as readonly string[]).includes(r.kind) ? (r.kind as PageKind) : "note", subject: r.subject ?? "", body: r.body,
  tags: json<string[]>(r.tags, []), source: r.source ?? "assistant", recalls: r.recalls ?? 0, recalled_at: r.recalled_at, created_at: r.created_at, updated_at: r.updated_at, embedded: !!r.embedding,
});

/* ── Embeddings ─────────────────────────────────────────────────────────────────────────────────────────────── */

let downUntil = 0;
/** Unit vectors for `texts` from mux's embed route, or null when it is not there (then tried again a minute later). */
async function embed(texts: string[]): Promise<{ model: string; vecs: Float32Array[] } | null> {
  if (!texts.length || Date.now() < downUntil) return null;
  try {
    const res = await fetch(`${gateway}/v1/embeddings`, {
      method: "POST", signal: AbortSignal.timeout(30_000),
      headers: { "content-type": "application/json", authorization: `Bearer ${assistantKey()}`, "x-mux-agent": "brain" },
      body: JSON.stringify({ model: "embed", input: texts.map((t) => t.slice(0, 6000)) }),
    });
    if (!res.ok) throw new Error(`${res.status}`);
    const j = (await res.json()) as { data?: { index: number; embedding: number[] }[]; model?: string };
    const data = [...(j.data ?? [])].sort((a, b) => a.index - b.index);
    if (data.length !== texts.length) throw new Error("wrong number of embeddings");
    return { model: res.headers.get("x-mux-model") ?? j.model ?? "embed", vecs: data.map((d) => unit(d.embedding)) };
  } catch {
    downUntil = Date.now() + 60_000;
    return null;
  }
}

function unit(v: number[]): Float32Array {
  const n = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
  return Float32Array.from(v, (x) => x / n);
}
const toBlob = (v: Float32Array) => Buffer.from(v.buffer, v.byteOffset, v.byteLength);
const fromBlob = (b: Buffer) => new Float32Array(new Uint8Array(b).buffer);
const dot = (a: Float32Array, b: Float32Array) => { let s = 0; for (let i = 0; i < a.length && i < b.length; i++) s += a[i] * b[i]; return s; };
const embedText = (p: { title: string; subject?: string; tags?: string[]; body: string }) => [p.title, p.subject, p.tags?.join(", "), p.body].filter(Boolean).join("\n");

/** Pages written while no embedding model answered, or by another one, get their vectors when one is back. */
async function backfill(model: string) {
  const rows = db.prepare("SELECT * FROM brain_pages WHERE embedding IS NULL OR embed_model IS NOT ? ORDER BY updated_at DESC LIMIT 32").all(model) as Row[];
  if (!rows.length) return;
  const e = await embed(rows.map((r) => embedText(fromRow(r))));
  if (!e || e.model !== model) return;
  const put = db.prepare("UPDATE brain_pages SET embedding = ?, embed_model = ? WHERE id = ?");
  rows.forEach((r, i) => put.run(toBlob(e.vecs[i]), e.model, r.id));
}

/* ── Search ─────────────────────────────────────────────────────────────────────────────────────────────────── */

/** Words that say nothing about what a question is about, in English and Danish. */
const STOP = new Set(("the an and or of to in on at for with is are was were be been it its this that these those what why how when where which who whom does do did doing " +
  "can could should would will shall may might must not no yes there their they them has have had then than so if but just also please about from by as into " +
  "me my we our us you your he she his her any some all more most very again now og på at det der den de en et er var til af med som ikke hvad hvorfor hvordan " +
  "hvornår hvem hvilken hvilke kan skal vil har jeg du vi mig os om fra men så eller nu lige bare også").split(" "));
const words = (s: string) => [...new Set(s.toLowerCase().match(/[\p{L}\p{N}][\p{L}\p{N}._/-]*/gu) ?? [])].filter((w) => w.length > 1 && !STOP.has(w));

/** How many of the query's words a page has: in its title, subject or tags they count fully, in its body a bit less. */
export function wordScore(query: string, p: Pick<Page, "title" | "subject" | "tags" | "body">): number {
  const q = words(query);
  if (!q.length) return 0;
  const head = `${p.title} ${p.subject} ${p.tags.join(" ")}`.toLowerCase();
  const body = p.body.toLowerCase();
  return q.reduce((s, w) => s + (head.includes(w) ? 1 : body.includes(w) ? 0.6 : 0), 0) / q.length;
}

/**
 * How well a page must match to count, by meaning (with bge-m3 a paraphrase scores ~0.35–0.5, an unrelated page ~0.2)
 * or by words alone (the share of the query's words it has).
 */
const LOOSE = { meaning: 0.28, words: 0.2 };
const STRICT = { meaning: 0.34, words: 0.5 };

export async function search(query: string, o: { kind?: string; limit?: number; min?: { meaning: number; words: number }; touch?: boolean } = {}): Promise<Hit[]> {
  const q = query.trim();
  const e = q ? await embed([q]) : null;
  if (e) await backfill(e.model);
  const rows = (o.kind ? db.prepare("SELECT * FROM brain_pages WHERE kind = ?").all(o.kind) : db.prepare("SELECT * FROM brain_pages").all()) as Row[];
  const hits = rows.map((r) => {
    const p = fromRow(r);
    if (!q) return { ...p, score: 0, pass: true };
    const w = wordScore(q, p);
    const v = e && r.embedding && r.embed_model === e.model ? dot(e.vecs[0], fromBlob(r.embedding)) : null;
    const min = o.min ?? LOOSE;
    return v === null ? { ...p, score: w, pass: w >= min.words } : { ...p, score: 0.75 * v + 0.25 * w, pass: 0.75 * v + 0.25 * w >= min.meaning || w >= min.words };
  });
  const out = (q ? hits.filter((h) => h.pass).sort((a, b) => b.score - a.score) : hits.sort((a, b) => b.updated_at - a.updated_at)).map(({ pass: _, ...h }) => h);
  const top = out.slice(0, Math.min(o.limit ?? 8, 50));
  if (o.touch && top.length) {
    const t = db.prepare("UPDATE brain_pages SET recalls = recalls + 1, recalled_at = ? WHERE id = ?");
    for (const h of top) t.run(now(), h.id);
  }
  return top;
}

/** What the brain knows about `text`, for a system prompt: the few pages that match well, in full but short. */
export async function recall(text: string, limit = 4): Promise<{ block: string; pages: Hit[] }> {
  const pages = await search(text, { limit, min: STRICT, touch: true }).catch(() => []);
  if (!pages.length) return { block: "Nothing in the brain matches this yet.", pages };
  const block = pages.map((p) => `### ${p.title} (${p.kind}${p.subject ? ` · ${p.subject}` : ""} · id ${p.id} · updated ${new Date(p.updated_at).toISOString().slice(0, 10)})\n${p.body.slice(0, 1500)}`).join("\n\n");
  return { block, pages };
}

/* ── Pages ──────────────────────────────────────────────────────────────────────────────────────────────────── */

export const getPage = (id: string) => { const r = db.prepare("SELECT * FROM brain_pages WHERE id = ?").get(id) as Row | undefined; return r ? fromRow(r) : undefined; };

const slug = (s: string) => s.toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "page";

/** Write a page: the same id, or else the same title, updates it rather than adding a near-copy. */
export async function writePage(p: { id?: string; title: string; body: string; kind?: string; subject?: string; tags?: string[]; source?: string }): Promise<Page> {
  const title = String(p.title ?? "").trim().slice(0, 200);
  if (!title) throw new Error("a page needs a title");
  const body = String(p.body ?? "").slice(0, BODY_CHARS);
  const kind = (KINDS as readonly string[]).includes(String(p.kind)) ? String(p.kind) : "note";
  const tags = (Array.isArray(p.tags) ? p.tags : []).map(String).map((t) => t.trim()).filter(Boolean).slice(0, 12);
  const existing = (p.id && getPage(p.id)) || fromRowMaybe(db.prepare("SELECT * FROM brain_pages WHERE lower(title) = lower(?)").get(title) as Row | undefined);
  let id = existing?.id ?? p.id ?? slug(title);
  if (!existing) for (let n = 2; getPage(id); n++) id = `${slug(title)}-${n}`;
  const e = await embed([embedText({ title, subject: p.subject, tags, body })]);
  const t = now();
  db.prepare(`INSERT INTO brain_pages(id, title, kind, subject, body, tags, source, embedding, embed_model, created_at, updated_at) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET title = excluded.title, kind = excluded.kind, subject = excluded.subject, body = excluded.body, tags = excluded.tags,
      source = excluded.source, embedding = excluded.embedding, embed_model = excluded.embed_model, updated_at = excluded.updated_at`)
    .run(id, title, kind, String(p.subject ?? "").slice(0, 200), body, JSON.stringify(tags), p.source ?? "assistant", e ? toBlob(e.vecs[0]) : null, e?.model ?? null, existing?.created_at ?? t, t);
  return getPage(id)!;
}
const fromRowMaybe = (r: Row | undefined) => (r ? fromRow(r) : undefined);

export const forgetPage = (id: string) => db.prepare("DELETE FROM brain_pages WHERE id = ?").run(id).changes > 0;

export function brainStats() {
  const s = db.prepare("SELECT COUNT(*) n, SUM(embedding IS NOT NULL) embedded, MAX(updated_at) updated FROM brain_pages").get() as { n: number; embedded: number | null; updated: number | null };
  const kinds = db.prepare("SELECT kind, COUNT(*) n FROM brain_pages GROUP BY kind").all() as { kind: string; n: number }[];
  const models = db.prepare("SELECT embed_model model, COUNT(*) n FROM brain_pages WHERE embed_model IS NOT NULL GROUP BY embed_model").all() as { model: string; n: number }[];
  return { pages: s.n, embedded: s.embedded ?? 0, updated: s.updated, kinds: Object.fromEntries(kinds.map((k) => [k.kind, k.n])), models, embedding: Date.now() >= downUntil };
}

/* ── Admin API ──────────────────────────────────────────────────────────────────────────────────────────────── */

export function registerBrain(api: FastifyInstance) {
  api.get("/brain", async (req) => {
    const q = req.query as { q?: string; kind?: string; limit?: string };
    const pages = await search(q.q ?? "", { kind: q.kind || undefined, limit: Number(q.limit) || 50 });
    return { pages, stats: brainStats() };
  });
  api.get("/brain/:id", async (req, reply) => getPage((req.params as { id: string }).id) ?? reply.code(404).send({ error: "no such page" }));
  api.post("/brain", async (req, reply) => {
    try { return await writePage({ ...(req.body as Parameters<typeof writePage>[0]), source: "user" }); } catch (e) { return reply.code(400).send({ error: (e as Error).message }); }
  });
  api.put("/brain/:id", async (req, reply) => {
    const id = (req.params as { id: string }).id;
    try { return await writePage({ ...(req.body as Parameters<typeof writePage>[0]), id, source: "user" }); } catch (e) { return reply.code(400).send({ error: (e as Error).message }); }
  });
  api.delete("/brain/:id", async (req, reply) => (forgetPage((req.params as { id: string }).id) ? { ok: true } : reply.code(404).send({ error: "no such page" })));
}
