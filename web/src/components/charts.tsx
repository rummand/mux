import type { ReactNode } from "react";
import {
  Area, AreaChart, Bar, BarChart, CartesianGrid, Cell, Line, LineChart, ResponsiveContainer, Scatter, ScatterChart, Tooltip, XAxis, YAxis, ZAxis,
} from "recharts";
import { fmtAxisTime, fmtCompact, fmtTime } from "../format";

/** Categorical slots in fixed order (validated palette); an entity keeps its slot as filters change. */
export const SERIES = [1, 2, 3, 4, 5, 6, 7, 8].map((i) => `var(--series-${i})`);
export const OTHER = "var(--text-muted)";

/** Stable slots: names sorted, first seven get hues, the rest fold into "Other". */
export function slotMap(names: string[]): Map<string, string> {
  const sorted = [...new Set(names)].sort();
  return new Map(sorted.map((n, i) => [n, i < 7 ? SERIES[i] : OTHER]));
}

export interface SeriesDef { key: string; label: string; color: string; format?: (v: number) => string }

function TipBox({ title, rows }: { title: ReactNode; rows: { color: string; label: string; value: string }[] }) {
  return (
    <div className="rounded-md border border-line-strong bg-s1 px-3 py-2 text-[12px] shadow-xl">
      <div className="mb-1 text-[11px] text-ink-3">{title}</div>
      {rows.map((r) => (
        <div key={r.label} className="flex items-center gap-2 py-px">
          <span className="h-0.5 w-3 rounded" style={{ background: r.color }} />
          <span className="font-semibold text-ink num">{r.value}</span>
          <span className="text-ink-3">{r.label}</span>
        </div>
      ))}
    </div>
  );
}

function Legend({ series }: { series: SeriesDef[] }) {
  if (series.length < 2) return null;
  return (
    <div className="mb-2 flex flex-wrap gap-x-3 gap-y-1">
      {series.map((s) => (
        <span key={s.key} className="inline-flex items-center gap-1.5 text-[11px] text-ink-2">
          <span className="h-2 w-2 rounded-sm" style={{ background: s.color }} />{s.label}
        </span>
      ))}
    </div>
  );
}

const axis = { stroke: "var(--grid)", tickLine: false, axisLine: false } as const;

/** Time on X, one Y scale. kind: line (2px), area (stacked, 10% wash), or bar (stacked columns). */
export function TimeChart({ data, series, kind = "line", bucketMs, height = 200, yFormat = fmtCompact, stacked }: {
  data: Record<string, number | null>[]; series: SeriesDef[]; kind?: "line" | "area" | "bar"; bucketMs: number; height?: number; yFormat?: (v: number) => string; stacked?: boolean;
}) {
  const tooltip = (
    <Tooltip
      cursor={kind === "bar" ? { fill: "var(--surface-3)", opacity: 0.5 } : { stroke: "var(--border-strong)", strokeWidth: 1 }}
      content={({ active, payload, label }) => active && payload?.length ? (
        <TipBox title={fmtTime(Number(label), bucketMs >= 3600_000)} rows={series.map((s) => {
          const v = payload.find((p) => p.dataKey === s.key)?.value as number | null | undefined;
          return { color: s.color, label: s.label, value: v == null ? "—" : (s.format ?? yFormat)(v) };
        })} />
      ) : null}
    />
  );
  const x = <XAxis dataKey="t" {...axis} tickFormatter={(t) => fmtAxisTime(t, bucketMs)} minTickGap={36} tick={{ fontSize: 11 }} />;
  const y = <YAxis {...axis} width={44} tickFormatter={(v) => yFormat(v)} tick={{ fontSize: 11 }} allowDecimals={false} />;
  const grid = <CartesianGrid vertical={false} strokeDasharray="0" />;
  return (
    <div>
      <Legend series={series} />
      <ResponsiveContainer width="100%" height={height}>
        {kind === "bar" ? (
          <BarChart data={data} margin={{ top: 4, right: 4, left: 0, bottom: 0 }} barCategoryGap="18%">
            {grid}{x}{y}{tooltip}
            {series.map((s, i) => (
              <Bar key={s.key} dataKey={s.key} stackId={stacked ? "a" : undefined} fill={s.color} maxBarSize={24} isAnimationActive={false}
                stroke="var(--surface-1)" strokeWidth={stacked ? 1 : 0}
                radius={stacked ? (i === series.length - 1 ? [3, 3, 0, 0] : [0, 0, 0, 0]) : [3, 3, 0, 0]} />
            ))}
          </BarChart>
        ) : kind === "area" ? (
          <AreaChart data={data} margin={{ top: 4, right: 4, left: 0, bottom: 0 }}>
            {grid}{x}{y}{tooltip}
            {series.map((s) => (
              <Area key={s.key} type="monotone" dataKey={s.key} stackId={stacked ? "a" : undefined} stroke={s.color} strokeWidth={2} fill={s.color} fillOpacity={0.12} dot={false} activeDot={{ r: 4, stroke: "var(--surface-1)", strokeWidth: 2 }} isAnimationActive={false} connectNulls />
            ))}
          </AreaChart>
        ) : (
          <LineChart data={data} margin={{ top: 4, right: 4, left: 0, bottom: 0 }}>
            {grid}{x}{y}{tooltip}
            {series.map((s) => (
              <Line key={s.key} type="monotone" dataKey={s.key} stroke={s.color} strokeWidth={2} dot={false} activeDot={{ r: 4, stroke: "var(--surface-1)", strokeWidth: 2 }} isAnimationActive={false} connectNulls />
            ))}
          </LineChart>
        )}
      </ResponsiveContainer>
    </div>
  );
}

/** Columns over categories (one series): a histogram or a small distribution. */
export function ColumnChart({ data, x, y, height = 180, color = SERIES[0], yFormat = fmtCompact, label }: { data: Record<string, unknown>[]; x: string; y: string; height?: number; color?: string; yFormat?: (v: number) => string; label: string }) {
  return (
    <ResponsiveContainer width="100%" height={height}>
      <BarChart data={data} margin={{ top: 14, right: 4, left: 0, bottom: 0 }} barCategoryGap="14%">
        <CartesianGrid vertical={false} />
        <XAxis dataKey={x} {...axis} tick={{ fontSize: 11 }} interval={0} />
        <YAxis {...axis} width={40} tickFormatter={(v) => yFormat(v)} tick={{ fontSize: 11 }} allowDecimals={false} />
        <Tooltip cursor={{ fill: "var(--surface-3)", opacity: 0.5 }} content={({ active, payload }) => active && payload?.length ? (
          <TipBox title={String(payload[0].payload[x])} rows={[{ color, label, value: yFormat(Number(payload[0].value)) }]} />
        ) : null} />
        <Bar dataKey={y} fill={color} maxBarSize={24} radius={[4, 4, 0, 0]} isAnimationActive={false} />
      </BarChart>
    </ResponsiveContainer>
  );
}

/** Horizontal magnitude bars with the value at the tip, in text ink. */
export function BarList({ items, format = fmtCompact, max }: { items: { label: ReactNode; value: number; color?: string; sub?: ReactNode }[]; format?: (v: number) => string; max?: number }) {
  const m = max ?? Math.max(1, ...items.map((i) => i.value));
  return (
    <div className="space-y-2">
      {items.map((it, i) => (
        <div key={i} className="grid grid-cols-[minmax(80px,30%)_1fr_auto] items-center gap-3 text-[12px]">
          <div className="truncate text-ink-2">{it.label}</div>
          <div className="h-2.5 rounded-r bg-s3/60">
            <div className="h-full rounded-r" style={{ width: `${Math.max(1, (it.value / m) * 100)}%`, background: it.color ?? SERIES[0], maxWidth: "100%" }} />
          </div>
          <div className="num text-ink text-right min-w-12">{format(it.value)}{it.sub && <span className="ml-1 text-ink-3">{it.sub}</span>}</div>
        </div>
      ))}
    </div>
  );
}

/** Points by two measures on one pair of axes; ≤3 categorical slots validate all-pairs, so one hue plus labels. */
export function ScatterPlot({ data, x, y, xLabel, yLabel, name, height = 260, xFormat = fmtCompact, yFormat = fmtCompact }: {
  data: Record<string, unknown>[]; x: string; y: string; xLabel: string; yLabel: string; name: string; height?: number; xFormat?: (v: number) => string; yFormat?: (v: number) => string;
}) {
  return (
    <ResponsiveContainer width="100%" height={height}>
      <ScatterChart margin={{ top: 10, right: 16, left: 0, bottom: 10 }}>
        <CartesianGrid />
        <XAxis type="number" dataKey={x} name={xLabel} {...axis} tickFormatter={(v) => xFormat(v)} tick={{ fontSize: 11 }} label={{ value: xLabel, position: "insideBottom", offset: -6, fill: "var(--text-muted)", fontSize: 11 }} />
        <YAxis type="number" dataKey={y} name={yLabel} {...axis} width={44} tickFormatter={(v) => yFormat(v)} tick={{ fontSize: 11 }} />
        <ZAxis range={[90, 90]} />
        <Tooltip cursor={false} content={({ active, payload }) => active && payload?.length ? (
          <TipBox title={String(payload[0].payload[name])} rows={[{ color: SERIES[0], label: xLabel, value: xFormat(Number(payload[0].payload[x])) }, { color: SERIES[0], label: yLabel, value: yFormat(Number(payload[0].payload[y])) }]} />
        ) : null} />
        <Scatter data={data} fill={SERIES[0]} stroke="var(--surface-1)" strokeWidth={2} isAnimationActive={false}>
          {data.map((_, i) => <Cell key={i} />)}
        </Scatter>
      </ScatterChart>
    </ResponsiveContainer>
  );
}

/** A 12-point trend line with no axes, in a de-emphasised hue. */
export function Sparkline({ values, height = 28, color = "var(--accent)" }: { values: number[]; height?: number; color?: string }) {
  const data = values.map((v, i) => ({ i, v }));
  return (
    <ResponsiveContainer width="100%" height={height}>
      <LineChart data={data} margin={{ top: 2, right: 2, left: 2, bottom: 2 }}>
        <Line type="monotone" dataKey="v" stroke={color} strokeWidth={1.5} dot={false} isAnimationActive={false} />
      </LineChart>
    </ResponsiveContainer>
  );
}

const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

/** When traffic comes: weekday rows × hour columns, one hue whose strength is the count. */
export function Heatmap({ data, label = "requests" }: { data: number[][]; label?: string }) {
  const max = Math.max(1, ...data.flat());
  return (
    <div className="overflow-x-auto">
      <div className="grid min-w-[520px] gap-[3px]" style={{ gridTemplateColumns: "32px repeat(24, minmax(0, 1fr))" }}>
        <div />
        {Array.from({ length: 24 }, (_, h) => <div key={h} className="text-center text-[10px] text-ink-3 num">{h % 3 === 0 ? h : ""}</div>)}
        {data.map((row, d) => [
          <div key={`d${d}`} className="pr-1 text-right text-[10.5px] leading-[18px] text-ink-3">{DAYS[d]}</div>,
          ...row.map((v, h) => (
            <div key={`${d}-${h}`} title={`${DAYS[d]} ${String(h).padStart(2, "0")}:00 · ${v.toLocaleString("en-US")} ${label}`}
              className="h-[18px] rounded-[3px]"
              style={{ background: v ? "var(--accent)" : "var(--surface-3)", opacity: v ? 0.18 + 0.82 * (v / max) : 0.5 }} />
          )),
        ])}
      </div>
    </div>
  );
}
