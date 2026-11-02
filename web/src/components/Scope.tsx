import { useEffect, type ComponentType } from "react";
import { setPageScope, type Provider, type SystemInfo } from "../api";
import { machineLabel } from "../format";
import { useApi, usePersisted } from "../hooks";
import { cx } from "./ui";

/**
 * A page about one machine (Models, Advisor, Benchmarks, System): a bar to pick which — this mux, or a node — and the
 * page, remounted per pick, with every call it makes sent to that machine through the gateway.
 */
export function Scoped({ page: Page }: { page: ComponentType }) {
  const [scope, setScope] = usePersisted<string | null>("scope", null);
  const nodes = useApi<Provider[]>("/providers", undefined, 30_000, null);
  const list = (nodes.data ?? []).filter((p) => p.kind === "mux");
  const self = useApi<SystemInfo>("/system", { range: "15m" }, 60_000, null).data?.name;
  const valid = scope && nodes.data && !list.some((p) => p.id === scope) ? null : scope;
  // Set before the page renders, so its first calls already go to the right machine.
  setPageScope(valid);
  useEffect(() => () => setPageScope(null), []);
  return (
    <>
      {list.length > 0 && (
        <div className="mb-4 flex flex-wrap items-center gap-1.5 text-[12px]">
          <span className="mr-1 text-ink-3">Machine</span>
          {[{ id: null as string | null, name: self ? machineLabel(self) : "This mux", status: "online" }, ...list].map((p) => (
            <button key={p.id ?? "self"} onClick={() => setScope(p.id)}
              className={cx("inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1", valid === p.id ? "border-accent bg-accent-soft text-ink font-medium" : "border-line text-ink-2 hover:bg-s2")}>
              <span className={cx("h-1.5 w-1.5 rounded-full", p.status === "online" ? "bg-good" : "bg-bad")} />{p.name}
            </button>
          ))}
        </div>
      )}
      <Page key={valid ?? "self"} />
    </>
  );
}
