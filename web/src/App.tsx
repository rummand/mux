import { useEffect, useState, type ReactNode } from "react";
import { BrowserRouter, NavLink, Navigate, Route, Routes, useLocation } from "react-router-dom";
import { api, getToken, setToken, setUnauthorizedHandler, type SystemInfo } from "./api";
import { Button, cx, Input, Meter } from "./components/ui";
import { fmtGb } from "./format";
import { useApi, useLiveStatus, usePersisted } from "./hooks";
import HomePage from "./pages/Home";
import BrainPage from "./pages/Brain";
import OverviewPage from "./pages/Overview";
import TenantsPage from "./pages/Tenants";
import TenantDetailPage from "./pages/TenantDetail";
import ModelsPage from "./pages/Models";
import AdvisorPage from "./pages/Advisor";
import ExperimentsPage from "./pages/Experiments";
import JournalPage from "./pages/Journal";
import RoutesPage from "./pages/RoutesPage";
import RequestsPage from "./pages/Requests";
import TracesPage from "./pages/Traces";
import LensPage from "./pages/Lens";
import BenchmarksPage from "./pages/Benchmarks";
import SystemPage from "./pages/System";
import PlaygroundPage from "./pages/Playground";
import ProvidersPage from "./pages/Providers";
import AgentsPage from "./pages/Agents";
import ServicesPage from "./pages/Services";
import HealthPage from "./pages/Health";
import ModelDetailPage from "./pages/ModelDetail";
import ProviderDetailPage from "./pages/ProviderDetail";
import { Scoped } from "./components/Scope";
import { ASK_EVENT, AssistantPanel, brainIcon, sparkle } from "./components/Assistant";

const icon = (d: string) => <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d={d} /></svg>;
const NAV: { to: string; label: string; icon: ReactNode; group?: string }[] = [
  { to: "/", label: "Ask mux", icon: <span className="text-accent">{sparkle}</span> },
  { to: "/brain", label: "Brain", icon: brainIcon },
  { to: "/agents", label: "Agents", icon: icon("M12 3v3M7 9h10a2 2 0 0 1 2 2v6a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2v-6a2 2 0 0 1 2-2zM9.5 13h.01M14.5 13h.01M3 13v2M21 13v2") },
  { to: "/journal", label: "What mux changed", icon: icon("M12 8v4l3 2M3 12a9 9 0 1 0 3-6.7L3 8M3 3v5h5") },
  { to: "/overview", label: "Overview", group: "Traffic", icon: icon("M3 13h4v8H3zM10 9h4v12h-4zM17 4h4v17h-4z") },
  { to: "/tenants", label: "Tenants", icon: icon("M4 20v-1a5 5 0 0 1 5-5h0a5 5 0 0 1 5 5v1M9 10a3 3 0 1 0 0-6 3 3 0 0 0 0 6M17 11a2.5 2.5 0 1 0 0-5M20 20v-1a4 4 0 0 0-3-3.9") },
  { to: "/requests", label: "Requests", icon: icon("M4 6h16M4 12h16M4 18h10") },
  { to: "/traces", label: "Traces", icon: icon("M4 5h6v4H4zM14 15h6v4h-6zM7 9v4a2 2 0 0 0 2 2h5") },
  { to: "/health", label: "Health", icon: icon("M3 12h4l3-8 4 16 3-8h4") },
  { to: "/lens", label: "Lens", icon: icon("M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14zM21 21l-5-5") },
  { to: "/providers", label: "Providers", group: "Compute", icon: icon("M4 6h16v5H4zM4 13h16v5H4zM8 8.5h.01M8 15.5h.01") },
  { to: "/services", label: "Services", icon: icon("M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18M12 3a9 9 0 1 0 0 18a9 9 0 0 0 0-18") },
  { to: "/models", label: "Models", icon: icon("M12 3l8 4.5v9L12 21l-8-4.5v-9zM12 12l8-4.5M12 12v9M12 12L4 7.5") },
  { to: "/advisor", label: "Advisor", icon: icon("M9 18h6M10 21h4M12 3a6 6 0 0 0-3.5 10.9V16h7v-2.1A6 6 0 0 0 12 3z") },
  { to: "/experiments", label: "Experiments", icon: icon("M9 3h6M10 3v6l-5 9a2 2 0 0 0 1.8 3h10.4a2 2 0 0 0 1.8-3l-5-9V3M7.5 15h9") },
  { to: "/routes", label: "Routes", icon: icon("M6 3v12a3 3 0 0 0 3 3h9M15 15l3 3-3 3M6 7a2 2 0 1 0 0-4 2 2 0 0 0 0 4") },
  { to: "/benchmarks", label: "Benchmarks", icon: icon("M12 13l4-4M3.5 17a9 9 0 1 1 17 0") },
  { to: "/playground", label: "Playground", icon: icon("M5 4l14 8-14 8z") },
  { to: "/system", label: "System", icon: icon("M4 5h16v11H4zM8 20h8M12 16v4") },
];

function Login({ onDone }: { onDone: () => void }) {
  const [t, setT] = useState("");
  const [err, setErr] = useState("");
  const submit = async () => {
    setToken(t.trim());
    try { await api("/settings"); onDone(); } catch { setErr("That token was not accepted."); setToken(""); }
  };
  return (
    <div className="flex min-h-full items-center justify-center p-6">
      <form onSubmit={(e) => { e.preventDefault(); void submit(); }} className="w-full max-w-sm rounded-xl border border-line bg-s1 p-6 shadow-xl">
        <Wordmark />
        <p className="mt-3 mb-5 text-[12.5px] text-ink-3">The model router and control plane: local nodes and cloud APIs behind one API. Sign in with the admin token (MUX_ADMIN_TOKEN in ~/.mux/mux.env).</p>
        <Input type="password" autoFocus placeholder="Admin token" value={t} onChange={(e) => setT(e.target.value)} />
        {err && <p className="mt-2 text-[12px] text-bad">{err}</p>}
        <Button variant="primary" className="mt-4 w-full" type="submit" disabled={!t.trim()}>Sign in</Button>
      </form>
    </div>
  );
}

function Wordmark({ small }: { small?: boolean }) {
  return (
    <div className="flex items-center gap-2">
      <img src="/favicon.svg" alt="" className={small ? "h-6 w-6" : "h-8 w-8"} />
      <div className="leading-none">
        <div className={cx("font-semibold tracking-tight", small ? "text-[15px]" : "text-xl")}>mux</div>
        {!small && <div className="mt-0.5 text-[11px] text-ink-3">model router</div>}
      </div>
    </div>
  );
}

function TopBar({ onMenu, onAssistant, home }: { onMenu: () => void; onAssistant: () => void; home: boolean }) {
  const live = useLiveStatus();
  const { data } = useApi<SystemInfo>("/system", { range: "15m" }, 10_000, null);
  const loaded = data?.instances.filter((i) => i.state === "ready").length ?? 0;
  const loading = data?.instances.filter((i) => i.state === "loading").length ?? 0;
  const b = data?.budget;
  const pressure = data?.system.pressure ?? 1;
  return (
    <header className="sticky top-0 z-30 flex h-12 items-center gap-4 border-b border-line bg-bg/90 px-4 backdrop-blur">
      <button className="lg:hidden text-ink-2" onClick={onMenu} aria-label="Menu">{icon("M4 6h16M4 12h16M4 18h16")}</button>
      {data?.role && <span className="text-[12px] text-ink-3">{data.role === "gateway" ? "gateway" : data.role === "node" ? "node" : "gateway + models"} · <span className="text-ink-2">{data.name}</span></span>}
      <div className="flex-1" />
      <span className="inline-flex items-center gap-1.5 text-[12px] text-ink-2" title="Live updates from mux">
        <span className={cx("h-2 w-2 rounded-full", live ? "bg-good pulse" : "bg-ink-3")} />{live ? "Live" : "Connecting…"}
      </span>
      <span className="hidden sm:inline text-[12px] text-ink-2 num">{loaded} loaded{loading ? ` · ${loading} loading` : ""}</span>
      {pressure > 1 && <span className="text-[12px] text-warn">▲ memory pressure {pressure === 4 ? "critical" : "warn"}</span>}
      {b && data?.role !== "gateway" && (
        <div className="hidden w-48 md:block" title={`mux models use ~${fmtGb(b.usedGb)} of a ${fmtGb(b.budgetGb, 0)} budget`}>
          <div className="mb-0.5 flex justify-between text-[10.5px] text-ink-3 num"><span>Model memory</span><span>{b.usedGb.toFixed(1)} / {b.budgetGb} GB</span></div>
          <Meter value={b.usedGb} max={b.budgetGb} tone={b.usedGb / b.budgetGb > 0.9 ? "bad" : b.usedGb / b.budgetGb > 0.7 ? "warn" : "accent"} height={5} />
        </div>
      )}
      {!home && <Button size="sm" onClick={onAssistant} title="Ask mux (⌘J)"><span className="inline-flex items-center gap-1.5"><span className="text-accent">{sparkle}</span>Ask mux</span></Button>}
      <Button size="sm" variant="ghost" onClick={() => { setToken(""); location.reload(); }}>Sign out</Button>
    </header>
  );
}

function Shell() {
  const [open, setOpen] = useState(false);
  const [assistant, setAssistant] = usePersisted("assistant.open", false);
  // The assistant is the home page; everywhere else it is a panel beside the page, in the same conversation.
  const home = useLocation().pathname === "/";
  const panel = assistant && !home;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "j" && !home) { e.preventDefault(); setAssistant(!assistant); } };
    const onAsk = () => { if (!home) setAssistant(true); };
    window.addEventListener("keydown", onKey);
    window.addEventListener(ASK_EVENT, onAsk);
    return () => { window.removeEventListener("keydown", onKey); window.removeEventListener(ASK_EVENT, onAsk); };
  }, [assistant, setAssistant, home]);
  return (
    <div className="flex min-h-full">
      <aside className={cx("fixed inset-y-0 left-0 z-40 w-56 shrink-0 border-r border-line bg-s1 transition-transform lg:sticky lg:top-0 lg:h-screen lg:translate-x-0", open ? "translate-x-0" : "-translate-x-full")}>
        <div className="flex h-12 items-center px-4 border-b border-line"><Wordmark small /></div>
        <nav className="p-2">
          {NAV.map((n) => (
            <div key={n.to}>
              {n.group && <div className="mt-4 mb-1 px-2.5 text-[10.5px] font-semibold uppercase tracking-wider text-ink-3">{n.group}</div>}
              <NavLink to={n.to} end={n.to === "/"} onClick={() => setOpen(false)}
                className={({ isActive }) => cx("flex items-center gap-2.5 rounded-md px-2.5 py-1.5 text-[13px]", isActive ? "bg-accent-soft text-ink font-medium" : "text-ink-2 hover:bg-s2 hover:text-ink")}>
                <span className="text-ink-3">{n.icon}</span>{n.label}
              </NavLink>
            </div>
          ))}
        </nav>
        <div className="absolute bottom-0 inset-x-0 border-t border-line p-3 text-[11px] text-ink-3">
          OpenAI <span className="font-mono">/v1/chat/completions</span><br />Anthropic <span className="font-mono">/v1/messages</span><br />System One <span className="font-mono">/v1/systemone</span>
        </div>
      </aside>
      {open && <div className="fixed inset-0 z-30 bg-black/40 lg:hidden" onClick={() => setOpen(false)} />}
      <div className={cx("flex min-w-0 flex-1 flex-col transition-[padding]", panel && "xl:pr-[460px]")}>
        <TopBar onMenu={() => setOpen(true)} onAssistant={() => setAssistant(!assistant)} home={home} />
        <main className="mx-auto w-full max-w-[1500px] flex-1 p-4 md:p-6">
          <Routes>
            <Route path="/" element={<HomePage />} />
            <Route path="/brain" element={<BrainPage />} />
            <Route path="/overview" element={<OverviewPage />} />
            <Route path="/tenants" element={<TenantsPage />} />
            <Route path="/tenants/:id" element={<TenantDetailPage />} />
            <Route path="/requests" element={<RequestsPage />} />
            <Route path="/traces" element={<TracesPage />} />
            <Route path="/lens" element={<LensPage />} />
            <Route path="/health" element={<Scoped page={HealthPage} />} />
            <Route path="/models" element={<Scoped page={ModelsPage} />} />
            <Route path="/models/*" element={<ModelDetailPage />} />
            <Route path="/advisor" element={<Scoped page={AdvisorPage} />} />
            <Route path="/routes" element={<RoutesPage />} />
            <Route path="/experiments" element={<ExperimentsPage />} />
            <Route path="/journal" element={<JournalPage />} />
            <Route path="/providers" element={<ProvidersPage />} />
            <Route path="/services" element={<ServicesPage />} />
            <Route path="/agents" element={<AgentsPage />} />
            <Route path="/providers/*" element={<ProviderDetailPage />} />
            <Route path="/benchmarks" element={<Scoped page={BenchmarksPage} />} />
            <Route path="/playground" element={<PlaygroundPage />} />
            <Route path="/system" element={<Scoped page={SystemPage} />} />
            <Route path="*" element={<Navigate to="/" />} />
          </Routes>
        </main>
      </div>
      {!home && <AssistantPanel open={panel} onClose={() => setAssistant(false)} />}
    </div>
  );
}

export default function App() {
  const [authed, setAuthed] = useState(!!getToken());
  useEffect(() => { setUnauthorizedHandler(() => { setToken(""); setAuthed(false); }); }, []);
  if (!authed) return <Login onDone={() => setAuthed(true)} />;
  return <BrowserRouter><Shell /></BrowserRouter>;
}
