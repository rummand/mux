import { useEffect, useState, type ReactNode, type InputHTMLAttributes, type SelectHTMLAttributes, type ButtonHTMLAttributes, type TextareaHTMLAttributes } from "react";

const cx = (...c: (string | false | null | undefined)[]) => c.filter(Boolean).join(" ");
export { cx };

export function Card({ title, subtitle, actions, children, className, pad = true }: { title?: ReactNode; subtitle?: ReactNode; actions?: ReactNode; children: ReactNode; className?: string; pad?: boolean }) {
  return (
    <section className={cx("rounded-lg border border-line bg-s1 min-w-0", className)}>
      {(title || actions) && (
        <header className="flex items-center justify-between gap-3 border-b border-line px-4 py-2.5">
          <div className="min-w-0">
            {title && <h3 className="text-[13px] font-semibold text-ink truncate">{title}</h3>}
            {subtitle && <p className="text-[11.5px] text-ink-3 truncate">{subtitle}</p>}
          </div>
          {actions && <div className="flex items-center gap-2 shrink-0">{actions}</div>}
        </header>
      )}
      <div className={pad ? "p-4" : ""}>{children}</div>
    </section>
  );
}

export function PageHeader({ title, subtitle, actions }: { title: string; subtitle?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
      <div>
        <h1 className="text-xl font-semibold tracking-tight text-ink">{title}</h1>
        {subtitle && <p className="mt-0.5 text-[12.5px] text-ink-3">{subtitle}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

export function Stat({ label, value, sub, tone }: { label: string; value: ReactNode; sub?: ReactNode; tone?: "good" | "bad" | "warn" }) {
  return (
    <div className="rounded-lg border border-line bg-s1 px-3.5 py-3 min-w-0">
      <div className="text-[11px] font-medium uppercase tracking-wide text-ink-3 truncate">{label}</div>
      <div className={cx("mt-1 text-[20px] font-semibold leading-tight num truncate", tone === "bad" ? "text-bad" : tone === "warn" ? "text-warn" : "text-ink")}>{value}</div>
      {sub && <div className="mt-0.5 text-[11.5px] text-ink-3 truncate num">{sub}</div>}
    </div>
  );
}

type Tone = "neutral" | "good" | "bad" | "warn" | "accent" | "muted";
const toneCls: Record<Tone, string> = {
  neutral: "bg-s3 text-ink-2 border-line-strong",
  good: "bg-[var(--good-soft)] text-good border-transparent",
  bad: "bg-[var(--critical-soft)] text-bad border-transparent",
  warn: "bg-[var(--warning-soft)] text-warn border-transparent",
  accent: "bg-accent-soft text-accent border-transparent",
  muted: "bg-transparent text-ink-3 border-line",
};
export function Badge({ tone = "neutral", children, title, className }: { tone?: Tone; children: ReactNode; title?: string; className?: string }) {
  return <span title={title} className={cx("inline-flex items-center gap-1 rounded border px-1.5 py-px text-[11px] font-medium whitespace-nowrap", toneCls[tone], className)}>{children}</span>;
}

/** A status dot with its word: color never alone. */
export function StatusDot({ tone, label, pulse }: { tone: Tone; label: string; pulse?: boolean }) {
  const color = tone === "good" ? "bg-good" : tone === "bad" ? "bg-bad" : tone === "warn" ? "bg-warn" : tone === "accent" ? "bg-accent" : "bg-ink-3";
  return <span className="inline-flex items-center gap-1.5 text-[12px] text-ink-2"><span className={cx("h-2 w-2 rounded-full", color, pulse && "pulse")} />{label}</span>;
}

export function Button({ variant = "default", size = "md", className, ...p }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: "default" | "primary" | "ghost" | "danger"; size?: "sm" | "md" }) {
  return (
    <button
      {...p}
      className={cx(
        "inline-flex items-center justify-center gap-1.5 rounded-md border font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed whitespace-nowrap",
        size === "sm" ? "h-7 px-2.5 text-[12px]" : "h-8 px-3 text-[12.5px]",
        variant === "primary" && "border-transparent bg-accent text-white hover:brightness-110",
        variant === "default" && "border-line-strong bg-s2 text-ink hover:bg-s3",
        variant === "ghost" && "border-transparent bg-transparent text-ink-2 hover:bg-s2 hover:text-ink",
        variant === "danger" && "border-transparent bg-[var(--critical-soft)] text-bad hover:brightness-125",
        className,
      )}
    />
  );
}

const field = "h-8 rounded-md border border-line-strong bg-s2 px-2.5 text-[12.5px] text-ink placeholder:text-ink-3 focus:border-accent focus:outline-none";
/** Full width unless the caller sets a width. */
const width = (c?: string) => (c && /(^|\s)(w-|max-w-|flex-1)/.test(c) ? "" : "w-full");
export const Input = ({ className, ...p }: InputHTMLAttributes<HTMLInputElement>) => <input {...p} className={cx(field, width(className), className)} />;
export const Select = ({ className, children, ...p }: SelectHTMLAttributes<HTMLSelectElement>) => <select {...p} className={cx(field, width(className), "pr-7", className)}>{children}</select>;
export const Textarea = ({ className, ...p }: TextareaHTMLAttributes<HTMLTextAreaElement>) => <textarea {...p} className={cx(field, width(className), "h-auto py-2 font-mono text-[12px]", className)} />;

export function Field({ label, hint, children, className }: { label: string; hint?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <label className={cx("block min-w-0", className)}>
      <span className="mb-1 block text-[11.5px] font-medium text-ink-2">{label}</span>
      {children}
      {hint && <span className="mt-1 block text-[11px] text-ink-3">{hint}</span>}
    </label>
  );
}

export function Toggle({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label?: ReactNode }) {
  return (
    <button type="button" role="switch" aria-checked={checked} onClick={() => onChange(!checked)} className="inline-flex items-center gap-2 text-[12.5px] text-ink-2">
      <span className={cx("relative h-[18px] w-8 rounded-full transition-colors", checked ? "bg-accent" : "bg-s3 border border-line-strong")}>
        <span className={cx("absolute top-[2px] h-3.5 w-3.5 rounded-full bg-white shadow transition-all", checked ? "left-[16px]" : "left-[2px]")} />
      </span>
      {label}
    </button>
  );
}

export function Segmented<T extends string>({ value, options, onChange }: { value: T; options: { value: T; label: ReactNode }[]; onChange: (v: T) => void }) {
  return (
    <div className="inline-flex rounded-md border border-line-strong bg-s2 p-0.5">
      {options.map((o) => (
        <button key={o.value} type="button" onClick={() => onChange(o.value)} className={cx("h-6 rounded px-2.5 text-[12px] font-medium", value === o.value ? "bg-s3 text-ink shadow-sm" : "text-ink-3 hover:text-ink")}>{o.label}</button>
      ))}
    </div>
  );
}

export function Tabs<T extends string>({ value, tabs, onChange }: { value: T; tabs: { value: T; label: ReactNode; count?: number }[]; onChange: (v: T) => void }) {
  return (
    <div className="mb-4 flex gap-1 border-b border-line overflow-x-auto">
      {tabs.map((t) => (
        <button key={t.value} onClick={() => onChange(t.value)} className={cx("-mb-px border-b-2 px-3 py-2 text-[12.5px] font-medium whitespace-nowrap", value === t.value ? "border-accent text-ink" : "border-transparent text-ink-3 hover:text-ink")}>
          {t.label}{t.count != null && <span className="ml-1.5 rounded bg-s3 px-1.5 text-[11px] text-ink-2 num">{t.count}</span>}
        </button>
      ))}
    </div>
  );
}

export function Modal({ open, onClose, title, children, wide, footer }: { open: boolean; onClose: () => void; title: ReactNode; children: ReactNode; wide?: boolean; footer?: ReactNode }) {
  useEffect(() => {
    if (!open) return;
    const k = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/55 p-4 pt-[8vh]" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={cx("w-full rounded-xl border border-line-strong bg-s1 shadow-2xl", wide ? "max-w-4xl" : "max-w-lg")}>
        <header className="flex items-center justify-between border-b border-line px-5 py-3">
          <h2 className="text-[14px] font-semibold">{title}</h2>
          <button onClick={onClose} className="text-ink-3 hover:text-ink text-lg leading-none" aria-label="Close">×</button>
        </header>
        <div className="p-5">{children}</div>
        {footer && <footer className="flex justify-end gap-2 border-t border-line px-5 py-3">{footer}</footer>}
      </div>
    </div>
  );
}

export function Drawer({ open, onClose, title, children }: { open: boolean; onClose: () => void; title: ReactNode; children: ReactNode }) {
  useEffect(() => {
    if (!open) return;
    const k = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-black/45" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <aside className="h-full w-full max-w-2xl overflow-y-auto border-l border-line-strong bg-s1 shadow-2xl">
        <header className="sticky top-0 z-10 flex items-center justify-between border-b border-line bg-s1 px-5 py-3">
          <h2 className="text-[14px] font-semibold truncate">{title}</h2>
          <button onClick={onClose} className="text-ink-3 hover:text-ink text-lg leading-none" aria-label="Close">×</button>
        </header>
        <div className="p-5">{children}</div>
      </aside>
    </div>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="flex min-h-24 items-center justify-center rounded-md border border-dashed border-line px-4 py-6 text-center text-[12.5px] text-ink-3">{children}</div>;
}

export function ErrorNote({ error }: { error: string | null | undefined }) {
  if (!error) return null;
  return <div className="mb-3 rounded-md border border-transparent bg-[var(--critical-soft)] px-3 py-2 text-[12.5px] text-bad">{error}</div>;
}

export function CopyButton({ text, label = "Copy" }: { text: string; label?: string }) {
  const [done, setDone] = useState(false);
  return (
    <Button size="sm" onClick={() => { void navigator.clipboard?.writeText(text); setDone(true); setTimeout(() => setDone(false), 1500); }}>
      {done ? "Copied" : label}
    </Button>
  );
}

/** A horizontal meter: value against a max, with an optional marker. */
export function Meter({ value, max, tone = "accent", height = 6, marker }: { value: number; max: number; tone?: "accent" | "good" | "warn" | "bad"; height?: number; marker?: number }) {
  const pct = max > 0 ? Math.min(100, (value / max) * 100) : 0;
  const color = tone === "good" ? "var(--good)" : tone === "warn" ? "var(--warning)" : tone === "bad" ? "var(--critical)" : "var(--accent)";
  return (
    <div className="relative w-full rounded-full bg-s3" style={{ height }}>
      <div className="absolute inset-y-0 left-0 rounded-full" style={{ width: `${pct}%`, background: color }} />
      {marker != null && max > 0 && <div className="absolute -top-0.5 -bottom-0.5 w-0.5 bg-ink-2" style={{ left: `${Math.min(100, (marker / max) * 100)}%` }} />}
    </div>
  );
}

export function Table({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cx("overflow-x-auto", className)}><table className="w-full border-collapse text-[12.5px]">{children}</table></div>;
}
export const Th = ({ children, right, className }: { children?: ReactNode; right?: boolean; className?: string }) => (
  <th className={cx("sticky top-0 border-b border-line bg-s1 px-3 py-2 text-[11px] font-medium uppercase tracking-wide text-ink-3 whitespace-nowrap", right ? "text-right" : "text-left", className)}>{children}</th>
);
export const Td = ({ children, right, className, mono, title }: { children?: ReactNode; right?: boolean; className?: string; mono?: boolean; title?: string }) => (
  <td title={title} className={cx("border-b border-line px-3 py-2 align-middle", right && "text-right num whitespace-nowrap", mono && "font-mono text-[11.5px]", className)}>{children}</td>
);

export function Spinner() {
  return <span className="inline-block h-3.5 w-3.5 animate-spin rounded-full border-2 border-line-strong border-t-accent" />;
}

export function KeyValue({ items }: { items: [ReactNode, ReactNode][] }) {
  return (
    <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1.5 text-[12.5px]">
      {items.map(([k, v], i) => (
        <div key={i} className="contents">
          <dt className="text-ink-3">{k}</dt>
          <dd className="min-w-0 break-words text-ink">{v}</dd>
        </div>
      ))}
    </dl>
  );
}
