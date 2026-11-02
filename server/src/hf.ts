import { randomBytes } from "node:crypto";
import { createWriteStream, existsSync, mkdirSync, readdirSync, realpathSync, renameSync, statSync, symlinkSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { EventEmitter } from "node:events";
import { config } from "./config.js";
import { CATALOG, catalogEntry, type CatalogEntry } from "./catalog.js";
import { db, event, now, settings } from "./db.js";
import { getModel, listModels, upsertModel, type Kind } from "./models.js";
import { systemStats } from "./runtime/system.js";
import { journal } from "./journal.js";

const HF = "https://huggingface.co";
const GB = 1024 ** 3;
const headers = (): Record<string, string> => (config.hfToken ? { authorization: `Bearer ${config.hfToken}` } : {});
export const downloadsBus = new EventEmitter();

export interface RepoFile { path: string; size: number }
export async function repoFiles(repo: string): Promise<RepoFile[]> {
  const r = await fetch(`${HF}/api/models/${repo}/tree/main?recursive=true`, { headers: headers() });
  if (!r.ok) throw new Error(`Hugging Face: ${repo}: ${r.status}`);
  return ((await r.json()) as { path: string; size?: number; lfs?: { size: number } }[]).filter((f) => f.path.endsWith(".gguf")).map((f) => ({ path: f.path, size: f.lfs?.size ?? f.size ?? 0 }));
}

/** GGUF repos on Hugging Face matching a search, most downloaded first, for models the catalog does not have. */
export async function searchHf(q: string) {
  const r = await fetch(`${HF}/api/models?search=${encodeURIComponent(q)}&filter=gguf&sort=downloads&direction=-1&limit=30&expand[]=gguf&expand[]=downloads&expand[]=likes&expand[]=lastModified&expand[]=pipeline_tag`, { headers: headers() });
  if (!r.ok) throw new Error(`Hugging Face search: ${r.status}`);
  return ((await r.json()) as { id: string; downloads?: number; likes?: number; lastModified?: string; pipeline_tag?: string; gguf?: { architecture?: string; context_length?: number; total?: number } }[])
    .map((m) => ({ repo: m.id, downloads: m.downloads ?? 0, likes: m.likes ?? 0, updated: m.lastModified, pipeline: m.pipeline_tag, arch: m.gguf?.architecture, ctx: m.gguf?.context_length, params: m.gguf?.total }));
}

/** The files one GGUF quant is made of: a single file, or every part of a split one. */
export function partsOf(files: RepoFile[], file: string): RepoFile[] {
  const split = /-(\d{5})-of-(\d{5})\.gguf$/.exec(file);
  if (!split) return files.filter((f) => f.path === file);
  const stem = file.slice(0, split.index);
  return files.filter((f) => f.path.startsWith(stem) && /-\d{5}-of-\d{5}\.gguf$/.test(f.path)).sort((a, b) => a.path.localeCompare(b.path));
}

export interface DownloadRow { id: string; catalog_id: string | null; repo: string; files: string; quant: string | null; model_id: string | null; total_bytes: number; done_bytes: number; status: string; error: string | null; bps: number; started_at: number; finished_at: number | null }
export const listDownloads = () => db.prepare("SELECT * FROM downloads ORDER BY started_at DESC LIMIT 50").all() as DownloadRow[];
const update = (id: string, patch: Partial<DownloadRow>) => {
  const sets = Object.keys(patch).map((k) => `${k} = @${k}`).join(", ");
  db.prepare(`UPDATE downloads SET ${sets} WHERE id = @id`).run({ ...patch, id });
  downloadsBus.emit("progress", db.prepare("SELECT * FROM downloads WHERE id = ?").get(id));
};

const active = new Map<string, AbortController>();
let queue: Promise<void> = Promise.resolve();

export interface DownloadRequest { catalogId?: string; repo?: string; file?: string; mmproj?: string | null; modelId?: string; kind?: Kind }

/** Queue a download (one at a time); the model is registered when its files are on disk. */
export async function startDownload(req: DownloadRequest): Promise<DownloadRow> {
  if (process.env.MUX_NO_DOWNLOADS) throw new Error("downloads are off here (MUX_NO_DOWNLOADS)");
  journal({ kind: "download", ref: req.catalogId ?? req.repo, title: `Download ${req.catalogId ?? `${req.repo}/${req.file}`}` });
  const entry = req.catalogId ? catalogEntry(req.catalogId) : undefined;
  const repo = req.repo ?? entry?.repo;
  const file = req.file ?? entry?.file;
  if (!repo || !file) throw new Error("a catalog id, or a repo and a file, is required");
  const files = await repoFiles(repo);
  const parts = partsOf(files, file);
  if (!parts.length) throw new Error(`${repo} has no ${file}`);
  const mmprojName = req.mmproj === null ? undefined : req.mmproj ?? entry?.mmproj;
  const mm = mmprojName ? files.find((f) => f.path === mmprojName) : undefined;
  const all = mm ? [...parts, mm] : parts;
  const total = all.reduce((a, f) => a + f.size, 0);
  const sys = await systemStats();
  const reserve = settings().diskReserveGb;
  if (sys.diskFreeGb - total / GB < reserve) throw new Error(`not enough disk: ${(total / GB).toFixed(1)} GB needed, ${sys.diskFreeGb.toFixed(1)} GB free, ${reserve} GB kept free`);
  const modelId = req.modelId ?? entry?.id ?? basename(file, ".gguf").toLowerCase().replace(/-\d{5}-of-\d{5}$/, "").replace(/[^a-z0-9.]+/g, "-");
  const row: DownloadRow = { id: randomBytes(6).toString("hex"), catalog_id: entry?.id ?? null, repo, files: JSON.stringify(all.map((f) => f.path)), quant: /(Q\d\w*|BF16|F16|MXFP4)/i.exec(file)?.[1] ?? null, model_id: modelId, total_bytes: total, done_bytes: 0, status: "queued", error: null, bps: 0, started_at: now(), finished_at: null };
  db.prepare("INSERT INTO downloads(id, catalog_id, repo, files, quant, model_id, total_bytes, done_bytes, status, started_at) VALUES(@id, @catalog_id, @repo, @files, @quant, @model_id, @total_bytes, 0, 'queued', @started_at)").run(row);
  event("info", "download", `queued ${repo}/${file} (${(total / GB).toFixed(1)} GB) as ${modelId}`);
  queue = queue.then(() => run(row, all, parts[0].path, mm?.path, entry, req.kind)).catch(() => undefined);
  return row;
}

async function fetchFile(dl: DownloadRow, repo: string, f: RepoFile, dest: string, ac: AbortController, base: number) {
  if (existsSync(dest) && statSync(dest).size === f.size) return;
  mkdirSync(dirname(dest), { recursive: true });
  const part = dest + ".part";
  const have = existsSync(part) ? statSync(part).size : 0;
  const res = await fetch(`${HF}/${repo}/resolve/main/${f.path}`, { headers: { ...headers(), ...(have ? { range: `bytes=${have}-` } : {}) }, signal: ac.signal, redirect: "follow" });
  if (!res.ok && res.status !== 206) throw new Error(`${f.path}: HTTP ${res.status}`);
  const resumed = res.status === 206 ? have : 0;
  const out = createWriteStream(part, { flags: resumed ? "a" : "w" });
  let got = resumed, last = Date.now(), lastBytes = got;
  const reader = res.body!.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!out.write(value)) await new Promise<void>((r) => out.once("drain", () => r()));
    got += value.length;
    if (Date.now() - last > 1000) {
      update(dl.id, { done_bytes: base + got, bps: ((got - lastBytes) * 1000) / (Date.now() - last) });
      last = Date.now(); lastBytes = got;
    }
  }
  await new Promise<void>((res2, rej) => out.end((e?: Error | null) => (e ? rej(e) : res2())));
  if (statSync(part).size !== f.size) throw new Error(`${f.path}: got ${statSync(part).size} of ${f.size} bytes`);
  renameSync(part, dest);
}

async function run(dl: DownloadRow, files: RepoFile[], main: string, mmproj: string | undefined, entry: CatalogEntry | undefined, kind?: Kind) {
  const ac = new AbortController();
  active.set(dl.id, ac);
  update(dl.id, { status: "running" });
  const dir = join(config.modelsDir, dl.repo.replace("/", "--"));
  try {
    let base = 0;
    for (const f of files) {
      await fetchFile(dl, dl.repo, f, join(dir, f.path), ac, base);
      base += f.size;
      update(dl.id, { done_bytes: base });
    }
    const size = files.filter((f) => f.path !== mmproj).reduce((a, f) => a + f.size, 0);
    upsertModel({
      id: dl.model_id!, display_name: entry?.name ?? dl.model_id!, backend: "llamacpp", kind: entry?.kind ?? kind ?? "chat",
      path: join(dir, main), mmproj: mmproj ? join(dir, mmproj) : null, catalog_id: entry?.id ?? null, size_bytes: size,
      ctx: entry?.defaultCtx ?? 32768, extra_args: entry?.extraArgs ?? [], caps: entry?.caps ?? {}, notes: entry?.notes ?? "",
    });
    update(dl.id, { status: "done", finished_at: now(), done_bytes: dl.total_bytes, bps: 0 });
    event("info", "download", `downloaded ${dl.repo} → model ${dl.model_id}`);
  } catch (e) {
    const cancelled = ac.signal.aborted;
    update(dl.id, { status: cancelled ? "cancelled" : "error", error: cancelled ? null : (e as Error).message, finished_at: now(), bps: 0 });
    if (!cancelled) event("error", "download", `${dl.repo}: ${(e as Error).message}`);
  } finally {
    active.delete(dl.id);
  }
}

export function cancelDownload(id: string) {
  const ac = active.get(id);
  if (ac) ac.abort();
  else db.prepare("UPDATE downloads SET status = 'cancelled', finished_at = ? WHERE id = ? AND status = 'queued'").run(now(), id);
}

/** GGUFs already on this Mac (Nexus's Hugging Face cache, LM Studio, llama.cpp's cache) that mux could serve without a download. */
export function scanLocal() {
  const known = new Map(listModels().filter((m) => m.path).map((m) => [safeReal(m.path!), m.id]));
  const out: { path: string; real: string; name: string; sizeGb: number; repo: string | null; registeredAs: string | null; mmproj: string | null }[] = [];
  const walk = (dir: string, depth: number) => {
    if (depth > 7) return;
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = join(dir, e.name);
      if (e.isDirectory()) { if (e.name !== "blobs" && !e.name.startsWith(".")) walk(p, depth + 1); continue; }
      if (!e.name.endsWith(".gguf") || /mmproj/i.test(e.name) || /-0000[2-9]-of-|-000[1-9]\d-of-/.test(e.name) || /^mtp-|^dflash-|eagle/i.test(e.name)) continue;
      const real = safeReal(p);
      let size = 0;
      try { size = statSync(real).size; } catch { continue; }
      if (size < 50 * 1024 * 1024) continue;
      const repo = /models--([^/]+)--([^/]+)/.exec(p);
      const mm = entries.find((x) => /mmproj.*f16/i.test(x.name) || /mmproj/i.test(x.name));
      out.push({ path: p, real, name: e.name, sizeGb: Math.round((size / GB) * 100) / 100, repo: repo ? `${repo[1]}/${repo[2]}` : null, registeredAs: known.get(real) ?? null, mmproj: mm ? join(dir, mm.name) : null });
    }
  };
  for (const d of config.scanDirs) if (existsSync(d)) walk(d, 0);
  return out;
}

function safeReal(p: string) { try { return realpathSync(p); } catch { return p; } }

/** Serve a GGUF that is already on disk: linked into mux's models folder, never copied. */
export function importLocal(path: string, opts: { id?: string; kind?: Kind; catalogId?: string; mmproj?: string | null }) {
  const real = safeReal(path);
  const size = statSync(real).size;
  const repo = /models--([^/]+)--([^/]+)/.exec(path);
  const entry = opts.catalogId ? catalogEntry(opts.catalogId) : undefined;
  const id = opts.id ?? entry?.id ?? basename(path, ".gguf").toLowerCase().replace(/[^a-z0-9.]+/g, "-");
  if (getModel(id)) throw new Error(`a model named ${id} already exists`);
  const dir = join(config.modelsDir, "imported");
  mkdirSync(dir, { recursive: true });
  const link = join(dir, `${id}.gguf`);
  if (!existsSync(link)) symlinkSync(real, link);
  let mmLink: string | null = null;
  if (opts.mmproj) {
    mmLink = join(dir, `${id}.mmproj.gguf`);
    if (!existsSync(mmLink)) symlinkSync(safeReal(opts.mmproj), mmLink);
  }
  const m = upsertModel({
    id, display_name: entry?.name ?? id, backend: "llamacpp", kind: entry?.kind ?? opts.kind ?? "chat", path: link, mmproj: mmLink,
    catalog_id: entry?.id ?? null, size_bytes: size, ctx: entry?.defaultCtx ?? 32768, extra_args: entry?.extraArgs ?? [], caps: entry?.caps ?? {},
    notes: `${entry?.notes ?? ""}${entry?.notes ? " " : ""}Imported from ${repo ? `${repo[1]}/${repo[2]}` : path}.`.trim(),
  });
  event("info", "models", `imported ${path} as ${id}`);
  return m;
}

/** Files mux downloaded earlier whose model is not registered (a new database, a deleted row): register them again. */
export function adoptDownloaded() {
  const registered = new Set(listModels().map((m) => m.catalog_id).filter(Boolean));
  for (const c of CATALOG) {
    if (registered.has(c.id) || getModel(c.id)) continue;
    const dir = join(config.modelsDir, c.repo.replace("/", "--"));
    const path = join(dir, c.file);
    if (!existsSync(path)) continue;
    const parts = partsOf(readdirSync(join(dir, dirname(c.file)), { recursive: false }).map((f) => ({ path: join(dirname(c.file), String(f)).replace(/^\.\//, ""), size: 0 })), c.file);
    const size = parts.reduce((a, p) => a + statSync(join(dir, p.path)).size, 0);
    const mm = c.mmproj && existsSync(join(dir, c.mmproj)) ? join(dir, c.mmproj) : null;
    upsertModel({ id: c.id, display_name: c.name, backend: "llamacpp", kind: c.kind, path, mmproj: mm, catalog_id: c.id, size_bytes: size, ctx: c.defaultCtx, extra_args: c.extraArgs ?? [], caps: c.caps, notes: c.notes });
    event("info", "models", `found ${c.id} already downloaded in ${dir}; registered it`);
  }
}
