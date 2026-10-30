import { useState } from "react";
import { api, type Bench, type Model } from "../api";
import { ScatterPlot } from "../components/charts";
import { Badge, Button, Card, Empty, ErrorNote, PageHeader, Select, Spinner, Table, Td, Th } from "../components/ui";
import { fmtMs, fmtPct, fmtTime } from "../format";
import { useApi, useLive } from "../hooks";

type Check = { name: string; pass: boolean; ms: number; detail: string };
const checksOf = (b: Bench): Check[] => (typeof b.results === "string" ? (() => { try { return JSON.parse(b.results as string); } catch { return []; } })() : b.results);

export default function BenchmarksPage() {
  const runs = useApi<Bench[]>("/benchmarks", undefined, 5000);
  const { data: models } = useApi<Model[]>("/models");
  const [model, setModel] = useState("");
  const [err, setErr] = useState<string | null>(null);
  useLive("bench", () => void runs.reload(true));
  const start = async () => { setErr(null); try { await api("/benchmarks", { body: { model } }); void runs.reload(true); } catch (e) { setErr((e as Error).message); } };
  const latest = new Map<string, Bench>();
  for (const b of runs.data ?? []) if (b.status === "done" && !latest.has(b.model_id)) latest.set(b.model_id, b);
  const points = [...latest.values()].filter((b) => b.tps != null && b.score != null).map((b) => ({ model: b.model_id, tps: b.tps, score: b.score! * 100 }));
  return (
    <>
      <PageHeader title="Benchmarks" subtitle="Measured on this Mac: first token, generation and prompt speed, and checks that matter to agents — exact instructions, JSON, tool calls, arithmetic, Danish, code." />
      <ErrorNote error={err ?? runs.error} />
      <div className="mb-4 flex flex-wrap gap-2">
        <Select className="w-64" value={model} onChange={(e) => setModel(e.target.value)}><option value="">Choose a model…</option>{models?.filter((m) => m.kind !== "systemone").map((m) => <option key={m.id} value={m.id}>{m.id}</option>)}</Select>
        <Button variant="primary" disabled={!model} onClick={start}>Run benchmark</Button>
        <span className="self-center text-[12px] text-ink-3">Loads the model if needed; takes up to a few minutes.</span>
      </div>
      <div className="grid gap-4 xl:grid-cols-[1fr_420px]">
        <Card title="Runs" pad={false}>
          {!runs.data?.length ? <div className="p-4"><Empty>No benchmarks yet.</Empty></div> : (
            <Table>
              <thead><tr><Th>Model</Th><Th>When</Th><Th>Status</Th><Th right>Score</Th><Th right>tok/s</Th><Th right>Prompt tok/s</Th><Th right>First token</Th><Th right>Load</Th><Th>Checks</Th></tr></thead>
              <tbody>{runs.data.map((b) => (
                <tr key={b.id} className="align-top">
                  <Td className="font-medium">{b.model_id}</Td><Td className="text-ink-2 num whitespace-nowrap">{fmtTime(b.ts, true)}</Td>
                  <Td>{b.status === "running" ? <Badge tone="accent"><Spinner /> running</Badge> : b.status === "error" ? <Badge tone="bad" title={b.error ?? ""}>error</Badge> : <Badge tone="good">done</Badge>}{b.error && <div className="mt-0.5 max-w-60 text-[11px] text-bad">{b.error}</div>}</Td>
                  <Td right>{b.score != null ? fmtPct(b.score, 0) : "—"}</Td><Td right>{b.tps ?? "—"}</Td><Td right>{b.prompt_tps ? Math.round(b.prompt_tps) : "—"}</Td>
                  <Td right>{fmtMs(b.ttft_ms)}</Td><Td right>{fmtMs(b.load_ms)}</Td>
                  <Td><div className="flex max-w-96 flex-wrap gap-1">{checksOf(b).map((c) => <Badge key={c.name} tone={c.pass ? "good" : "bad"} title={c.detail}>{c.pass ? "✓" : "✗"} {c.name}</Badge>)}</div></Td>
                </tr>
              ))}</tbody>
            </Table>
          )}
        </Card>
        <Card title="Speed vs. checks passed" subtitle="latest run per model">
          {points.length ? <>
            <ScatterPlot data={points} x="tps" y="score" xLabel="tok/s" yLabel="% checks" name="model" yFormat={(v) => `${Math.round(v)}%`} />
            <ul className="mt-2 space-y-0.5 text-[12px] text-ink-2">{points.sort((a, b) => b.score - a.score).map((p) => <li key={p.model} className="flex justify-between num"><span>{p.model}</span><span>{Math.round(p.score)}% · {p.tps} tok/s</span></li>)}</ul>
          </> : <Empty>Run a benchmark to compare models.</Empty>}
        </Card>
      </div>
    </>
  );
}
