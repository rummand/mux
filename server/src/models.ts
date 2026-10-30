import { db, json, now } from "./db.js";

/** llamacpp, mlx, laya run on this machine; node is a model on another mux; external and jev are APIs elsewhere. */
export type Backend = "llamacpp" | "mlx" | "external" | "laya" | "jev" | "node";
export type Kind = "chat" | "embedding" | "rerank" | "systemone" | "transcription" | "speech";

/** What a model is good at, 0–10, as the catalog estimates it until a benchmark on this Mac says otherwise. */
export interface Caps {
  quality?: number; speed?: number; tools?: number; code?: number; reasoning?: number;
  multilingual?: number; vision?: number; context?: number;
}

export interface Model {
  id: string; display_name: string; kind: Kind; backend: Backend;
  path: string | null; mmproj: string | null;
  base_url: string | null; api_key: string | null; upstream_model: string | null;
  catalog_id: string | null; size_bytes: number;
  ctx: number; parallel: number; extra_args: string[]; reasoning: "off" | "on" | "auto";
  caps: Caps; keep_alive_min: number | null; pinned: boolean; enabled: boolean;
  notes: string; created_at: number;
  /** The provider it is reached through (a mux node or a cloud API); null for this machine's own. */
  provider_id: string | null;
  /** USD per million input / output tokens; 0 for local compute. */
  cost_in: number; cost_out: number;
}

type Row = Omit<Model, "extra_args" | "caps" | "pinned" | "enabled"> & { extra_args: string; caps: string; pinned: number; enabled: number };

const fromRow = (r: Row): Model => ({ ...r, extra_args: json(r.extra_args, []), caps: json(r.caps, {}), pinned: !!r.pinned, enabled: !!r.enabled });

export const listModels = (): Model[] => (db.prepare("SELECT * FROM models ORDER BY kind, id").all() as Row[]).map(fromRow);
export const getModel = (id: string): Model | undefined => {
  const r = db.prepare("SELECT * FROM models WHERE id = ?").get(id) as Row | undefined;
  return r && fromRow(r);
};

export function upsertModel(m: Partial<Model> & Pick<Model, "id" | "backend">): Model {
  const prev = getModel(m.id);
  const next: Model = {
    display_name: m.id, kind: "chat", path: null, mmproj: null, base_url: null, api_key: null, upstream_model: null,
    catalog_id: null, size_bytes: 0, ctx: 32768, parallel: 2, extra_args: [], reasoning: "off", caps: {},
    keep_alive_min: null, pinned: false, enabled: true, notes: "", created_at: now(), provider_id: null, cost_in: 0, cost_out: 0,
    ...prev, ...m,
  } as Model;
  db.prepare(`INSERT INTO models(id, display_name, kind, backend, path, mmproj, base_url, api_key, upstream_model, catalog_id, size_bytes,
      ctx, parallel, extra_args, reasoning, caps, keep_alive_min, pinned, enabled, notes, created_at, provider_id, cost_in, cost_out)
    VALUES(@id, @display_name, @kind, @backend, @path, @mmproj, @base_url, @api_key, @upstream_model, @catalog_id, @size_bytes,
      @ctx, @parallel, @extra_args, @reasoning, @caps, @keep_alive_min, @pinned, @enabled, @notes, @created_at, @provider_id, @cost_in, @cost_out)
    ON CONFLICT(id) DO UPDATE SET display_name=excluded.display_name, kind=excluded.kind, backend=excluded.backend, path=excluded.path,
      mmproj=excluded.mmproj, base_url=excluded.base_url, api_key=excluded.api_key, upstream_model=excluded.upstream_model,
      catalog_id=excluded.catalog_id, size_bytes=excluded.size_bytes, ctx=excluded.ctx, parallel=excluded.parallel,
      extra_args=excluded.extra_args, reasoning=excluded.reasoning, caps=excluded.caps, keep_alive_min=excluded.keep_alive_min,
      pinned=excluded.pinned, enabled=excluded.enabled, notes=excluded.notes, provider_id=excluded.provider_id,
      cost_in=excluded.cost_in, cost_out=excluded.cost_out`)
    .run({ ...next, extra_args: JSON.stringify(next.extra_args), caps: JSON.stringify(next.caps), pinned: next.pinned ? 1 : 0, enabled: next.enabled ? 1 : 0 });
  return next;
}

export const deleteModel = (id: string) => db.prepare("DELETE FROM models WHERE id = ?").run(id);

export interface Route { name: string; description: string; kind: Kind; strategy: "priority" | "auto" | "fastest" | "quality"; candidates: string[]; created_at: number }
type RouteRow = Omit<Route, "candidates"> & { candidates: string };
export const listRoutes = (): Route[] => (db.prepare("SELECT * FROM routes ORDER BY name").all() as RouteRow[]).map((r) => ({ ...r, candidates: json(r.candidates, []) }));
export const getRoute = (name: string): Route | undefined => {
  const r = db.prepare("SELECT * FROM routes WHERE name = ?").get(name) as RouteRow | undefined;
  return r && { ...r, candidates: json(r.candidates, []) };
};
export function upsertRoute(r: Partial<Route> & { name: string }) {
  const prev = getRoute(r.name);
  const next = { description: "", kind: "chat", strategy: "priority", candidates: [], created_at: now(), ...prev, ...r } as Route;
  db.prepare(`INSERT INTO routes(name, description, kind, strategy, candidates, created_at) VALUES(@name, @description, @kind, @strategy, @candidates, @created_at)
    ON CONFLICT(name) DO UPDATE SET description=excluded.description, kind=excluded.kind, strategy=excluded.strategy, candidates=excluded.candidates`)
    .run({ ...next, candidates: JSON.stringify(next.candidates) });
  return next;
}
export const deleteRoute = (name: string) => db.prepare("DELETE FROM routes WHERE name = ?").run(name);
