import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { useApi } from "../../lib/hooks";
import { fmtDate, humanize } from "../../lib/format";
import { Button, Card, EmptyState, ErrorState, Loading, PageHeader, Segmented, StatusBadge } from "../../components/ui";
import { Icon } from "../../components/Icon";
import { Highlight } from "./Highlight";
import "./knowledge.css";

interface Result { type: string; id: string; title: string; snippet: string; date: string | null; project_name: string | null; status: string | null; url: string | null; score: number }
interface SearchResponse { q: string; terms: string[]; results: Result[]; counts: Record<string, number> }

const TYPE_META: Record<string, { label: string; icon: string; statusKind?: string }> = {
  project: { label: "Projects", icon: "folder", statusKind: "project" },
  programme: { label: "Programmes", icon: "layers" },
  task: { label: "Tasks", icon: "tasks", statusKind: "task" },
  meeting: { label: "Meetings", icon: "meeting", statusKind: "meeting" },
  report: { label: "Reports", icon: "report", statusKind: "report" },
  knowledge: { label: "Knowledge", icon: "book", statusKind: "knowledge" },
  procedure: { label: "Procedures", icon: "tasks", statusKind: "knowledge" },
  deliverable: { label: "Deliverables", icon: "package", statusKind: "deliverable" },
  milestone: { label: "Milestones", icon: "milestone", statusKind: "milestone" },
  decision: { label: "Decisions", icon: "flag", statusKind: "decision" },
  risk: { label: "Risks & issues", icon: "alert", statusKind: "risk" },
  opportunity: { label: "Opportunities", icon: "target", statusKind: "opportunity" },
  learning: { label: "Learning", icon: "lightbulb" },
  improvement: { label: "Improvements", icon: "trending", statusKind: "improvement" },
  person: { label: "People", icon: "user" },
};
const ORDER = Object.keys(TYPE_META);

export default function SearchPage() {
  const [params, setParams] = useSearchParams();
  const nav = useNavigate();
  const q = (params.get("q") ?? "").trim();
  const [text, setText] = useState(q);
  const [type, setType] = useState<string>("all");
  useEffect(() => {
    setText(q);
    setType("all");
  }, [q]);
  const valid = q.length >= 2;
  const { data, error, loading, reload } = useApi<SearchResponse>(valid ? "/search" : null, { q, limit: 15 });

  const groups = useMemo(() => {
    const g: Record<string, Result[]> = {};
    for (const r of data?.results ?? []) (g[r.type] ??= []).push(r);
    return ORDER.filter((t) => g[t]?.length).map((t) => ({ type: t, items: g[t] }));
  }, [data]);
  const total = data?.results.length ?? 0;
  const shown = type === "all" ? groups : groups.filter((g) => g.type === type);

  return (
    <>
      <PageHeader title="Search" subtitle={valid ? <>Results for “{q}” — only records you are allowed to see are shown.</> : "Search across projects, tasks, meetings, reports, knowledge and more."} />
      <form
        className="kno-hero"
        role="search"
        onSubmit={(e) => {
          e.preventDefault();
          const t = text.trim();
          if (t) setParams({ q: t });
        }}
      >
        <label htmlFor="search-page-input" className="sr-only">Search</label>
        <input id="search-page-input" className="input" type="search" value={text} onChange={(e) => setText(e.target.value)} placeholder="Search CSI Workspace…" maxLength={200} />
        <Button type="submit" variant="primary" icon="search">Search</Button>
      </form>

      {!valid ? (
        <EmptyState icon="search" title={q ? "Type at least 2 characters" : "What are you looking for?"}>
          Try a project name, a person, a procedure such as “supplier”, or a topic like “change readiness”.
        </EmptyState>
      ) : loading && !data ? (
        <Loading label="Searching…" />
      ) : error ? (
        <ErrorState error={error} onRetry={reload} />
      ) : !total ? (
        <EmptyState icon="search" title={`No results for “${q}”`} action={<Button onClick={() => nav(`/knowledge?q=${encodeURIComponent(q)}`)}>Search the Knowledge Hub</Button>}>
          Check the spelling, use fewer or more general words, or ask the Knowledge assistant. Restricted records never appear for people without access.
        </EmptyState>
      ) : (
        <>
          <div className="mb-2" style={{ overflowX: "auto" }}>
            <Segmented
              label="Filter by type"
              value={type}
              onChange={setType}
              options={[{ key: "all", label: "All", count: total }, ...groups.map((g) => ({ key: g.type, label: TYPE_META[g.type].label, count: g.items.length }))]}
            />
          </div>
          <div aria-live="polite" className="sr-only">{total} results</div>
          {shown.map((g) => (
            <div className="srch-group" key={g.type}>
              <Card
                pad={false}
                title={
                  <h2 className="row">
                    <Icon name={TYPE_META[g.type].icon} size={16} /> {TYPE_META[g.type].label} <span className="muted small">({g.items.length})</span>
                  </h2>
                }
              >
                {g.items.map((r) => {
                  const inner = (
                    <>
                      <div className="row-between">
                        <span className="t">
                          <Highlight text={r.title} terms={data!.terms} />
                        </span>
                        {r.status && TYPE_META[g.type].statusKind && <StatusBadge kind={TYPE_META[g.type].statusKind!} value={r.status} />}
                        {r.status && !TYPE_META[g.type].statusKind && <span className="tiny muted">{humanize(r.status)}</span>}
                      </div>
                      {r.snippet && (
                        <div className="s">
                          <Highlight text={r.snippet} terms={data!.terms} />
                        </div>
                      )}
                      {(r.date || r.project_name) && (
                        <div className="tiny muted mt-1">
                          {r.project_name && <span>{r.project_name}</span>}
                          {r.project_name && r.date && " · "}
                          {r.date && <span>{fmtDate(r.date)}</span>}
                        </div>
                      )}
                    </>
                  );
                  return r.url ? (
                    <Link key={r.type + r.id} to={r.url} className="srch-result">
                      {inner}
                    </Link>
                  ) : (
                    <div key={r.type + r.id} className="srch-result">
                      {inner}
                    </div>
                  );
                })}
              </Card>
            </div>
          ))}
          <p className="tiny muted">Showing up to 15 best matches per type. Refine your search to narrow results.</p>
        </>
      )}
    </>
  );
}
