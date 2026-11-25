import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { useState } from "react";
import { useApi, useDebounced } from "../../lib/hooks";
import { useAuth, useLookups } from "../../lib/app-state";
import { Badge, Button, EmptyState, ErrorState, Loading, PageHeader, StatusBadge, Tabs } from "../../components/ui";
import { Icon } from "../../components/Icon";
import { fmtDate, plural } from "../../lib/format";
import { timeRange, type MeetingListItem } from "./types";

type View = "upcoming" | "past" | "needs_review" | "all";
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export default function MeetingsList() {
  const { can } = useAuth();
  const { lookups } = useLookups();
  const nav = useNavigate();
  const [params, setParams] = useSearchParams();
  const view = (params.get("view") as View) || "upcoming";
  const [q, setQ] = useState(params.get("q") ?? "");
  const project = params.get("project_id") ?? "";
  const dq = useDebounced(q);
  const { data, loading, error, reload } = useApi<{ items: MeetingListItem[]; today: string }>("/meetings", { view, q: dq, project_id: project });
  const setParam = (k: string, v: string) => {
    const p = new URLSearchParams(params);
    if (v) p.set(k, v);
    else p.delete(k);
    setParams(p, { replace: true });
  };

  return (
    <>
      <PageHeader
        title="Meetings"
        subtitle="Capture what was discussed and decided, and turn it into confirmed actions."
        actions={can("meeting.create") && <Button variant="primary" icon="plus" onClick={() => nav("/meetings/new")}>New meeting</Button>}
      />
      <Tabs<View>
        value={view}
        onChange={(v) => setParam("view", v)}
        tabs={[
          { key: "upcoming", label: "Upcoming" },
          { key: "past", label: "Past" },
          { key: "needs_review", label: "Needs review" },
          { key: "all", label: "All" },
        ]}
      />
      <div className="filter-bar">
        <label className="sr-only" htmlFor="mtg-q">Search meetings</label>
        <input id="mtg-q" className="input" type="search" placeholder="Search title, purpose or notes…" value={q} onChange={(e) => setQ(e.target.value)} />
        <label className="sr-only" htmlFor="mtg-project">Project</label>
        <select id="mtg-project" className="select" value={project} onChange={(e) => setParam("project_id", e.target.value)}>
          <option value="">All projects</option>
          {(lookups?.projects ?? []).map((p) => (
            <option key={p.id} value={p.id}>{p.name}</option>
          ))}
        </select>
      </div>
      {error ? (
        <ErrorState error={error} onRetry={reload} />
      ) : loading && !data ? (
        <Loading />
      ) : !data?.items.length ? (
        <div className="card">
          <EmptyState
            icon="meeting"
            title={view === "needs_review" ? "Nothing waiting for review" : view === "upcoming" ? "No upcoming meetings" : "No meetings found"}
            action={can("meeting.create") && view !== "needs_review" ? <Button icon="plus" onClick={() => nav("/meetings/new")}>Record a meeting</Button> : undefined}
          >
            {view === "needs_review" ? "Meetings with submitted notes or pending suggestions will appear here." : "Meetings you organise, attend, or that belong to your projects appear here."}
          </EmptyState>
        </div>
      ) : (
        <div className="card list">
          {data.items.map((m) => {
            const [, mo, d] = m.meeting_date.split("-");
            return (
              <div className="list-item" key={m.id}>
                <div className="mtg-date" aria-hidden>
                  <div className="m">{MONTHS[Number(mo) - 1]}</div>
                  <div className="d">{Number(d)}</div>
                </div>
                <div style={{ minWidth: 0, flex: 1 }}>
                  <div className="row">
                    <Link className="title" to={`/meetings/${m.id}`}>{m.title}</Link>
                    {m.confidential ? <Badge tone="neutral" icon="lock">Confidential</Badge> : null}
                    <StatusBadge kind="meeting" value={m.status} />
                    {m.pending_suggestions > 0 && <Badge tone="ai" icon="sparkles">{plural(m.pending_suggestions, "suggestion")} to review</Badge>}
                  </div>
                  <div className="meta">
                    <span>{fmtDate(m.meeting_date, { year: true })}{timeRange(m) ? ` · ${timeRange(m)}` : ""}</span>
                    <span>{m.meeting_type}</span>
                    {m.project_name && <Link to={`/projects/${m.project_id}`}>{m.project_name}</Link>}
                    <span><Icon name="users" size={12} /> {m.participant_count}</span>
                    {m.open_actions > 0 && <span>{plural(m.open_actions, "open action")}</span>}
                    {m.preparation_required ? <span className="due-today">Preparation required</span> : null}
                  </div>
                </div>
                <div className="row desktop-only">
                  {m.meeting_link && m.meeting_date >= (data.today ?? "") && (
                    <a className="btn btn-sm" href={m.meeting_link} target="_blank" rel="noopener noreferrer"><Icon name="external" size={14} /> Join</a>
                  )}
                  {m.pending_suggestions > 0 && <Button size="sm" variant="ai" onClick={() => nav(`/meetings/${m.id}/review`)}>Review</Button>}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </>
  );
}
