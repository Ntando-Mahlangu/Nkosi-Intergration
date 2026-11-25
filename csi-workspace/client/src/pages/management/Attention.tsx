import { useMemo } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { useApi } from "../../lib/hooks";
import { Badge, EmptyState, ErrorState, Loading, Segmented, SelectInput } from "../../components/ui";
import { Icon } from "../../components/Icon";
import { TYPE_ICON, TYPE_LABEL, type AttentionItem } from "./types";

const SEV_TONE = { critical: "danger", high: "warn", medium: "neutral" } as const;

export default function Attention() {
  const { data, loading, error, reload } = useApi<{ items: AttentionItem[]; counts: Record<string, number> }>("/management/attention");
  const [params, setParams] = useSearchParams();
  const sev = (params.get("severity") ?? "all") as "all" | "critical" | "high" | "medium";
  const type = params.get("type") ?? "";
  const update = (k: string, v: string) => {
    const n = new URLSearchParams(params);
    if (v && v !== "all") n.set(k, v);
    else n.delete(k);
    setParams(n, { replace: true });
  };
  const items = useMemo(() => (data?.items ?? []).filter((i) => (sev === "all" || i.severity === sev) && (!type || i.type === type)), [data, sev, type]);
  if (loading && !data) return <Loading />;
  if (error) return <ErrorState error={error} onRetry={reload} />;
  const c = data?.counts ?? { critical: 0, high: 0, medium: 0 };
  return (
    <div className="stack">
      <div className="filter-bar">
        <Segmented
          label="Severity"
          value={sev}
          onChange={(v) => update("severity", v)}
          options={[
            { key: "all", label: "All", count: data?.items.length },
            { key: "critical", label: "Critical", count: c.critical },
            { key: "high", label: "High", count: c.high },
            { key: "medium", label: "Medium", count: c.medium },
          ]}
        />
        <div style={{ minWidth: 200 }}>
          <SelectInput label="Type" value={type} onChange={(v) => update("type", v)} placeholder="All types" options={Object.entries(TYPE_LABEL).map(([value, label]) => ({ value, label }))} />
        </div>
      </div>
      {items.length === 0 ? (
        <EmptyState icon="checkCircle" title="Nothing needs intervention">{data?.items.length ? "No items match these filters." : "No blocked projects, overdue milestones, unresolved high risks or pending decisions."}</EmptyState>
      ) : (
        <div className="card list">
          {items.map((i) => (
            <div className="list-item" key={`${i.type}${i.id}`} style={{ alignItems: "stretch" }}>
              <span className={`mgt-sev ${i.severity}`} aria-hidden />
              <Icon name={TYPE_ICON[i.type] ?? "dot"} />
              <div style={{ minWidth: 0, flex: 1 }}>
                <Link to={i.link} className="title">{i.title}</Link>
                <div className="small" style={{ color: "var(--text-2)" }}>
                  <strong>Why: </strong>
                  {i.why}
                </div>
                <div className="meta">
                  <span>{TYPE_LABEL[i.type] ?? i.type}</span>
                  {i.project && <span>{i.project}</span>}
                </div>
              </div>
              <Badge tone={SEV_TONE[i.severity]} icon={i.severity === "medium" ? "info" : "alert"}>{i.severity[0].toUpperCase() + i.severity.slice(1)}</Badge>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
