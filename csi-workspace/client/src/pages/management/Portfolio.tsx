import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useApi, useDebounced } from "../../lib/hooks";
import { useLookups } from "../../lib/app-state";
import { fmtDate } from "../../lib/format";
import { options, statusMeta } from "../../lib/status";
import { Checkbox, EmptyState, ErrorState, Loading, ProgressBar, SelectInput, StatusBadge, Badge } from "../../components/ui";
import { Icon } from "../../components/Icon";

interface Row {
  id: string; name: string; code: string | null; status: string; health: string; owner_name: string | null; programme_name: string | null; target_date: string | null;
  progress: number | null; progress_method: string; progress_explanation: string; next_milestone: string | null; next_milestone_date: string | null;
  outstanding_actions: number; overdue_actions: number; risk_level: string | null; suggested_health: string; health_factors: { level: string; text: string }[]; visibility: string;
}
type SortKey = "name" | "status" | "health" | "progress" | "deadline" | "risk" | "outstanding";

export default function Portfolio() {
  const { lookups } = useLookups();
  const nav = useNavigate();
  const [f, setF] = useState({ status: "", health: "", owner_id: "", programme_id: "", q: "", include_closed: false });
  const [sort, setSort] = useState<{ key: SortKey; dir: "asc" | "desc" }>({ key: "health", dir: "asc" });
  const q = useDebounced(f.q);
  const { data, loading, error, reload } = useApi<{ items: Row[]; today: string }>("/management/portfolio", {
    status: f.status, health: f.health, owner_id: f.owner_id, programme_id: f.programme_id, q, include_closed: f.include_closed ? "1" : "", sort: sort.key, dir: sort.dir,
  });
  const th = (key: SortKey, label: string) => (
    <th aria-sort={sort.key === key ? (sort.dir === "asc" ? "ascending" : "descending") : "none"}>
      <button className="mgt-sort" onClick={() => setSort((s) => ({ key, dir: s.key === key && s.dir === "asc" ? "desc" : "asc" }))}>
        {label}
        {sort.key === key && <Icon name={sort.dir === "asc" ? "chevronDown" : "chevronRight"} size={12} />}
      </button>
    </th>
  );
  const owners = (lookups?.users ?? []).filter((u) => (lookups?.projects ?? []).some((p) => p.owner_id === u.id));
  return (
    <div className="stack">
      <div className="filter-bar">
        <input className="input" type="search" placeholder="Search projects…" aria-label="Search projects" value={f.q} onChange={(e) => setF({ ...f, q: e.target.value })} />
        <select className="select" aria-label="Status" value={f.status} onChange={(e) => setF({ ...f, status: e.target.value })}>
          <option value="">Any status</option>
          {options("project").map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
        <select className="select" aria-label="Health" value={f.health} onChange={(e) => setF({ ...f, health: e.target.value })}>
          <option value="">Any health</option>
          {options("health").map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
        <select className="select" aria-label="Owner" value={f.owner_id} onChange={(e) => setF({ ...f, owner_id: e.target.value })}>
          <option value="">Any owner</option>
          {owners.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
        </select>
        <select className="select" aria-label="Programme" value={f.programme_id} onChange={(e) => setF({ ...f, programme_id: e.target.value })}>
          <option value="">Any programme</option>
          {(lookups?.programmes ?? []).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
        <Checkbox label="Include completed/cancelled" checked={f.include_closed} onChange={(v) => setF({ ...f, include_closed: v })} />
      </div>
      {loading && !data ? (
        <Loading />
      ) : error ? (
        <ErrorState error={error} onRetry={reload} />
      ) : !data?.items.length ? (
        <EmptyState icon="folder" title="No projects match">Adjust the filters to see more projects.</EmptyState>
      ) : (
        <div className="card table-wrap">
          <table className="table table-stack">
            <thead>
              <tr>
                {th("name", "Project")}
                <th>Owner</th>
                {th("status", "Status")}
                {th("health", "Health")}
                {th("progress", "Progress")}
                <th>Next milestone</th>
                {th("deadline", "Deadline")}
                {th("outstanding", "Open actions")}
                {th("risk", "Risk")}
              </tr>
            </thead>
            <tbody>
              {data.items.map((r) => (
                <tr key={r.id} className="clickable" onClick={() => nav(`/projects/${r.id}`)}>
                  <td data-label="Project">
                    <a href={`/projects/${r.id}`} className="strong" onClick={(e) => { e.preventDefault(); nav(`/projects/${r.id}`); }}>{r.name}</a>
                    {r.visibility === "restricted" && <> <Icon name="lock" size={12} title="Restricted project" /></>}
                    {r.programme_name && <div className="tiny muted">{r.programme_name}</div>}
                  </td>
                  <td data-label="Owner" className="small">{r.owner_name ?? "—"}</td>
                  <td data-label="Status"><StatusBadge kind="project" value={r.status} /></td>
                  <td data-label="Health">
                    <StatusBadge kind="health" value={r.health} />
                    {r.suggested_health !== r.health && r.health !== "completed" && (
                      <div className="tiny muted mt-1" title={r.health_factors.map((x) => x.text).join("; ")}>
                        Rules suggest: {statusMeta("health", r.suggested_health).label}
                        <ul className="mgt-factors">{r.health_factors.slice(0, 2).map((x, i) => <li key={i}>{x.text}</li>)}</ul>
                      </div>
                    )}
                  </td>
                  <td data-label="Progress" style={{ minWidth: 120 }} title={r.progress_explanation}>
                    <ProgressBar value={r.progress} label={r.progress_method} />
                  </td>
                  <td data-label="Next milestone" className="small">{r.next_milestone ? <>{r.next_milestone}<div className={`tiny ${r.next_milestone_date && r.next_milestone_date < data.today ? "overdue" : "muted"}`}>{fmtDate(r.next_milestone_date)}</div></> : <span className="muted">—</span>}</td>
                  <td data-label="Deadline" className="small">{fmtDate(r.target_date)}</td>
                  <td data-label="Open actions" className="small">{r.outstanding_actions}{r.overdue_actions ? <span className="overdue"> ({r.overdue_actions} overdue)</span> : ""}</td>
                  <td data-label="Risk">{r.risk_level ? <StatusBadge kind="severity" value={r.risk_level} /> : <Badge tone="ok" icon="check">None open</Badge>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="tiny muted">Progress shows each project's configured method (hover for the calculation). "Rules suggest" is a transparent rule-based indicator; only the project owner sets the actual health.</p>
    </div>
  );
}
