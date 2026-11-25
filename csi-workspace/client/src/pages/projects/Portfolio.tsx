import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { useApi, useDebounced } from "../../lib/hooks";
import { useLookups } from "../../lib/app-state";
import { fmtDate, money, plural } from "../../lib/format";
import { Badge, Card, EmptyState, ErrorState, LinkButton, Loading, PageHeader, ProgressBar, Segmented, StatusBadge, Button } from "../../components/ui";
import { Icon } from "../../components/Icon";
import { HEALTH_OPTIONS, PRIORITY_OPTIONS, STATUS_OPTIONS, type ProjectSummary } from "./types";
import { ProjectUpdateModal } from "./ProjectUpdateModal";

const SORTS = [
  { value: "name", label: "Name" },
  { value: "target_date", label: "Target date" },
  { value: "health", label: "Health (worst first)" },
  { value: "priority", label: "Priority" },
  { value: "progress", label: "Progress" },
  { value: "updated", label: "Recently updated" },
];

export function riskTone(level: string | null): "neutral" | "warn" | "danger" {
  return level === "high" || level === "critical" ? "danger" : level === "medium" ? "warn" : "neutral";
}

export default function Portfolio() {
  const [params, setParams] = useSearchParams();
  const nav = useNavigate();
  const { lookups } = useLookups();
  const [q, setQ] = useState(params.get("q") ?? "");
  const dq = useDebounced(q);
  const narrow = !!window.matchMedia?.("(max-width: 860px)").matches;
  const [view, setView] = useState<"table" | "cards">(narrow ? "cards" : "table");
  const [showFilters, setShowFilters] = useState(!narrow);
  const get = (k: string) => params.get(k) ?? "";
  const setFilter = (k: string, v: string) => {
    const n = new URLSearchParams(params);
    if (v) n.set(k, v);
    else n.delete(k);
    setParams(n, { replace: true });
  };
  useEffect(() => setFilter("q", dq), [dq]); // eslint-disable-line react-hooks/exhaustive-deps

  const query = {
    owner_id: get("owner_id"), team_id: get("team_id"), programme_id: get("programme_id"), status: get("status"), priority: get("priority"), health: get("health"),
    q: get("q"), sort: get("sort") || "name", mine: get("mine"), active: get("active"),
  };
  const { data, error, loading, reload } = useApi<{ items: ProjectSummary[]; total: number; can_create: boolean }>("/projects", query);
  const updateOpen = params.get("update") === "1";
  const filtersActive = ["owner_id", "team_id", "programme_id", "status", "priority", "health", "q", "mine", "active"].some((k) => get(k));

  const owners = useMemo(() => (lookups?.users ?? []).map((u) => ({ value: u.id, label: u.name })), [lookups]);
  const sel = (k: string, label: string, opts: { value: string; label: string }[]) => (
    <select className="select" aria-label={label} value={get(k)} onChange={(e) => setFilter(k, e.target.value)}>
      <option value="">{label}: all</option>
      {opts.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  );

  return (
    <>
      <PageHeader
        title="Projects & Programmes"
        subtitle="Every project you can see, with progress, health and what needs attention."
        actions={
          <>
            <LinkButton to="/projects/programmes" icon="layers">
              Programmes
            </LinkButton>
            <Button icon="message" onClick={() => setFilter("update", "1")}>
              Post update
            </Button>
            {data?.can_create && (
              <LinkButton to="/projects/new" variant="primary" icon="plus">
                New project
              </LinkButton>
            )}
          </>
        }
      />
      <div className="filter-bar">
        <input className="input" type="search" placeholder="Search projects…" aria-label="Search projects" value={q} onChange={(e) => setQ(e.target.value)} style={{ minWidth: 200 }} />
        <Segmented
          label="Scope"
          value={get("mine") === "1" ? "mine" : "all"}
          onChange={(v) => setFilter("mine", v === "mine" ? "1" : "")}
          options={[{ key: "all", label: "All visible" }, { key: "mine", label: "My projects" }]}
        />
        <Button size="sm" icon="filter" aria-expanded={showFilters} onClick={() => setShowFilters((x) => !x)}>
          Filters{filtersActive ? " (on)" : ""}
        </Button>
        {showFilters && (
          <>
        {sel("status", "Status", STATUS_OPTIONS)}
        {sel("health", "Health", HEALTH_OPTIONS)}
        {sel("priority", "Priority", PRIORITY_OPTIONS)}
        {sel("owner_id", "Owner", owners)}
        {sel("team_id", "Team", (lookups?.teams ?? []).map((t) => ({ value: t.id, label: t.name })))}
        {sel("programme_id", "Programme", (lookups?.programmes ?? []).map((t) => ({ value: t.id, label: t.name })))}
        <select className="select" aria-label="Sort" value={get("sort") || "name"} onChange={(e) => setFilter("sort", e.target.value)}>
          {SORTS.map((s) => (
            <option key={s.value} value={s.value}>
              Sort: {s.label}
            </option>
          ))}
        </select>
        {filtersActive && (
          <Button variant="ghost" size="sm" onClick={() => { setQ(""); setParams(new URLSearchParams(), { replace: true }); }}>
            Clear filters
          </Button>
        )}
        <span className="spacer" />
        <Segmented label="View" value={view} onChange={setView} options={[{ key: "table", label: "Table" }, { key: "cards", label: "Cards" }]} />
      </div>

      {error ? (
        <ErrorState error={error} onRetry={reload} />
      ) : loading && !data ? (
        <Loading />
      ) : !data?.items.length ? (
        <Card>
          <EmptyState
            icon="folder"
            title={filtersActive ? "No projects match these filters" : "No projects yet"}
            action={data?.can_create && !filtersActive ? <LinkButton to="/projects/new" variant="primary" icon="plus">Create the first project</LinkButton> : undefined}
          >
            {filtersActive ? "Try removing a filter." : "Projects you own, belong to, or that are shared with the organisation will appear here."}
          </EmptyState>
        </Card>
      ) : view === "table" ? (
        <div className="card table-wrap">
          <table className="table table-stack">
            <thead>
              <tr>
                <th>Project</th>
                <th>Owner</th>
                <th>Status</th>
                <th>Health</th>
                <th style={{ minWidth: 130 }}>Progress</th>
                <th>Next milestone</th>
                <th>Target</th>
                <th>Open</th>
                <th>Risk</th>
              </tr>
            </thead>
            <tbody>
              {data.items.map((p) => (
                <tr key={p.id} className="clickable" onClick={() => nav(`/projects/${p.id}`)}>
                  <td data-label="Project">
                    <Link to={`/projects/${p.id}`} onClick={(e) => e.stopPropagation()} className="strong">
                      {p.name}
                    </Link>
                    <div className="tiny muted">
                      {[p.programme_name, p.category].filter(Boolean).join(" · ")}
                      {p.visibility === "restricted" && (
                        <>
                          {" "}
                          <Icon name="lock" size={11} title="Restricted" />
                        </>
                      )}
                    </div>
                  </td>
                  <td data-label="Owner">{p.owner_name ?? "—"}</td>
                  <td data-label="Status"><StatusBadge kind="project" value={p.status} /></td>
                  <td data-label="Health"><StatusBadge kind="health" value={p.health} /></td>
                  <td data-label="Progress" title={p.progress.explanation}>
                    <ProgressBar value={p.progress.value} label={p.progress.value === null ? "Not measured" : ""} />
                  </td>
                  <td data-label="Next milestone" className="small">
                    {p.next_milestone ? (
                      <>
                        {p.next_milestone.title}
                        <div className="tiny muted">{fmtDate(p.next_milestone.target_date)}</div>
                      </>
                    ) : (
                      <span className="muted">—</span>
                    )}
                  </td>
                  <td data-label="Target" className="nowrap">{fmtDate(p.target_date)}</td>
                  <td data-label="Open" className="small nowrap">
                    {p.open_actions} actions
                    {p.overdue_actions + p.overdue_milestones + p.overdue_deliverables > 0 && (
                      <div className="overdue tiny">{p.overdue_actions + p.overdue_milestones + p.overdue_deliverables} overdue</div>
                    )}
                  </td>
                  <td data-label="Risk">{p.risk_level ? <Badge tone={riskTone(p.risk_level)} icon="alert">{p.risk_level}</Badge> : <span className="muted">None</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="grid grid-3">
          {data.items.map((p) => (
            <ProjectCard key={p.id} p={p} />
          ))}
        </div>
      )}
      {data && data.items.length > 0 && <p className="muted small mt-2">{plural(data.total, "project")} shown. Hover progress to see how it is calculated.</p>}
      <ProjectUpdateModal open={updateOpen} onClose={() => setFilter("update", "")} onSaved={(id) => nav(`/projects/${id}?tab=updates`)} />
    </>
  );
}

export function ProjectCard({ p }: { p: ProjectSummary }) {
  const nav = useNavigate();
  return (
    <div
      className="card clickable card-pad prj-card"
      role="link"
      tabIndex={0}
      onClick={() => nav(`/projects/${p.id}`)}
      onKeyDown={(e) => e.key === "Enter" && nav(`/projects/${p.id}`)}
      aria-label={`Open project ${p.name}`}
    >
      <div className="row-between">
        <h3 className="truncate">{p.name}</h3>
        <StatusBadge kind="health" value={p.health} />
      </div>
      <div className="tiny muted mt-1">
        {p.owner_name ?? "No owner"} · <StatusBadge kind="project" value={p.status} />
      </div>
      <div className="mt-2" title={p.progress.explanation}>
        <ProgressBar value={p.progress.value} label={p.progress.method === "manual" ? "Owner-reported progress" : `Progress by ${p.progress.method}`} />
      </div>
      <div className="small mt-2">
        <Icon name="milestone" size={13} /> {p.next_milestone ? `${p.next_milestone.title} · ${fmtDate(p.next_milestone.target_date)}` : "No upcoming milestone"}
      </div>
      <div className="row tiny muted mt-1">
        <span>{plural(p.open_actions, "open action")}</span>
        <span>{plural(p.outstanding_deliverables, "deliverable")} outstanding</span>
        {p.risk_level && <Badge tone={riskTone(p.risk_level)} icon="alert">{p.risk_level} risk</Badge>}
        {p.budget_visible && p.budget_amount != null && <span>{money(p.budget_amount, p.budget_currency)}</span>}
      </div>
    </div>
  );
}
