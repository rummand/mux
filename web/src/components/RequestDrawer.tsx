import type { RequestRow } from "../api";
import { fmtInt, fmtMs, fmtTime } from "../format";
import { useApi } from "../hooks";
import { Badge, Drawer, KeyValue, Spinner } from "./ui";

const pretty = (s: string | null | undefined) => {
  if (!s) return null;
  try { return JSON.stringify(JSON.parse(s), null, 2); } catch { return s; }
};

export function statusTone(status: number) { return status < 400 ? "good" : status === 429 ? "warn" : "bad"; }

/** One request in full: who, what was asked, how it was routed, where the time went, and the bodies when kept. */
export function RequestDrawer({ id, onClose }: { id: string | null; onClose: () => void }) {
  const { data } = useApi<RequestRow>(id ? `/requests/${id}` : null);
  const r = data && data.id === id ? data : null;
  const upstream = r ? Math.max(0, r.latency_ms - (r.queue_ms ?? 0) - (r.overhead_ms ?? 0)) : 0;
  return (
    <Drawer open={!!id} onClose={onClose} title={<span className="font-mono">{id}</span>}>
      {!r ? <Spinner /> : (
        <div className="space-y-5">
          <div className="flex flex-wrap gap-1.5">
            <Badge tone={statusTone(r.status)}>{r.status}{r.error_type ? ` ${r.error_type}` : ""}</Badge>
            <Badge>{r.endpoint}</Badge>
            {r.stream ? <Badge tone="accent">stream</Badge> : null}
            {r.tools ? <Badge tone="accent">{r.forced_tool ? "forced tool" : "tools"}</Badge> : null}
            {r.cold_start ? <Badge tone="warn">cold start</Badge> : null}
            {r.fallbacks ? <Badge tone="warn">{r.fallbacks} fallback{r.fallbacks > 1 ? "s" : ""}</Badge> : null}
            {r.finish_reason && <Badge tone={r.finish_reason === "length" ? "warn" : "muted"}>finish: {r.finish_reason}</Badge>}
          </div>
          {r.error && <div className="rounded-md bg-[var(--critical-soft)] px-3 py-2 text-[12.5px] text-bad">{r.error}</div>}
          <KeyValue items={[
            ["Time", fmtTime(r.ts, true)], ["Tenant", r.tenant_id], ["Key", <span className="font-mono">{r.key_id}</span>],
            ["Asked for", <span className="font-mono">{r.requested_model || "(none)"}</span>], ["Route", r.route ?? "—"], ["Answered by", <b>{r.model_id ?? "—"}</b>],
            ["Agent", r.agent ?? "—"], ["Trace", r.trace_id ? <span className="font-mono">{r.trace_id}</span> : "—"], ["End user", r.end_user ?? "—"], ["Tags", r.tags ?? "—"],
            ["Tokens", `${fmtInt(r.prompt_tokens)} in (${fmtInt(r.cached_tokens)} cached) · ${fmtInt(r.completion_tokens)} out`],
            ["Speed", r.tps ? `${r.tps} tok/s` : "—"], ["Client", `${r.ip ?? ""} ${r.user_agent ?? ""}`],
          ]} />
          <div>
            <h4 className="mb-2 text-[12px] font-semibold text-ink-2">Where the time went · {fmtMs(r.latency_ms)}</h4>
            <div className="flex h-5 w-full overflow-hidden rounded bg-s3">
              {[
                { v: r.queue_ms ?? 0, c: "var(--series-4)", l: "load / queue" },
                { v: upstream, c: "var(--series-1)", l: "model" },
                { v: r.overhead_ms ?? 0, c: "var(--series-7)", l: "mux" },
              ].map((s) => <div key={s.l} title={`${s.l}: ${fmtMs(s.v)}`} style={{ width: `${r.latency_ms ? (s.v / r.latency_ms) * 100 : 0}%`, background: s.c, minWidth: s.v ? 2 : 0 }} className="border-r-2 border-s1 last:border-r-0" />)}
            </div>
            <div className="mt-1.5 flex flex-wrap gap-x-4 text-[11.5px] text-ink-3">
              <span><span className="mr-1 inline-block h-2 w-2 rounded-sm" style={{ background: "var(--series-4)" }} />load / queue {fmtMs(r.queue_ms)}</span>
              <span><span className="mr-1 inline-block h-2 w-2 rounded-sm" style={{ background: "var(--series-1)" }} />model {fmtMs(upstream)}</span>
              <span><span className="mr-1 inline-block h-2 w-2 rounded-sm" style={{ background: "var(--series-7)" }} />mux {r.overhead_ms ?? "—"} ms</span>
              <span>first token {fmtMs(r.ttft_ms)}</span>
            </div>
          </div>
          {r.route_reason && <div><h4 className="mb-1 text-[12px] font-semibold text-ink-2">Routing decision</h4><pre className="code rounded-md bg-s2 p-3 text-ink-2">{r.route_reason}</pre></div>}
          <div>
            <h4 className="mb-1 text-[12px] font-semibold text-ink-2">Request body</h4>
            {r.body_req ? <pre className="code max-h-96 overflow-auto rounded-md bg-s2 p-3">{pretty(r.body_req)}</pre> : <p className="text-[12px] text-ink-3">Not kept. Bodies are kept for failed requests, or for every request when the tenant (or Settings) has body logging on.</p>}
          </div>
          {r.body_res && <div><h4 className="mb-1 text-[12px] font-semibold text-ink-2">Response</h4><pre className="code max-h-96 overflow-auto rounded-md bg-s2 p-3">{pretty(r.body_res)}</pre></div>}
        </div>
      )}
    </Drawer>
  );
}
