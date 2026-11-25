import { useState } from "react";
import { Link } from "react-router-dom";
import { useApi, useDebounced, localToday } from "../../lib/hooks";
import { useAuth } from "../../lib/app-state";
import { fmtDate } from "../../lib/format";
import { EmptyState, ErrorState, LinkButton, Loading, PageHeader, PersonChip, StatusBadge } from "../../components/ui";
import { Highlight, termsOf } from "./Highlight";
import type { KnowledgeListItem } from "./types";
import "./knowledge.css";

/** Institutional procedures: operational "how we do things" with owner, version and review dates. */
export default function ProceduresPage() {
  const { can } = useAuth();
  const [q, setQ] = useState("");
  const dq = useDebounced(q.trim(), 250);
  const { data, error, loading, reload } = useApi<{ items: (KnowledgeListItem & { owner_name?: string })[]; total: number }>("/knowledge", { item_type: "procedure", q: dq, sort: dq ? "relevance" : "title", limit: 100 });
  const today = localToday();
  const terms = termsOf(dq);
  return (
    <>
      <PageHeader
        breadcrumbs={[{ label: "Knowledge Hub", to: "/knowledge" }, { label: "Procedures" }]}
        title="Procedures"
        subtitle="How CSI does recurring work — each procedure has an owner, a version and a review date."
        actions={can("knowledge.contribute") && <LinkButton to="/knowledge/new?type=procedure" variant="primary" icon="plus">Add procedure</LinkButton>}
      />
      <div className="kno-hero" role="search">
        <label htmlFor="proc-search" className="sr-only">Search procedures</label>
        <input id="proc-search" className="input" type="search" placeholder="Search procedures, e.g. supplier, call report…" value={q} onChange={(e) => setQ(e.target.value)} />
      </div>
      {loading && !data ? (
        <Loading />
      ) : error ? (
        <ErrorState error={error} onRetry={reload} />
      ) : data && data.items.length ? (
        <div className="card table-wrap">
          <table className="table table-stack">
            <thead>
              <tr>
                <th>Procedure</th>
                <th>Owner</th>
                <th>Version</th>
                <th>Last reviewed</th>
                <th>Review due</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {data.items.map((p) => {
                const overdue = !!p.review_date && p.review_date < today;
                return (
                  <tr key={p.id}>
                    <td data-label="Procedure">
                      <Link to={`/knowledge/${p.id}`} className="strong">
                        <Highlight text={p.title} terms={terms} />
                      </Link>
                      {p.summary && <div className="tiny muted">{p.summary}</div>}
                    </td>
                    <td data-label="Owner"><PersonChip name={p.owner_name ?? p.author_name} /></td>
                    <td data-label="Version">v{p.version}</td>
                    <td data-label="Last reviewed">{fmtDate(p.last_reviewed_date)}</td>
                    <td data-label="Review due" className={overdue ? "overdue" : ""}>{p.review_date ? `${fmtDate(p.review_date)}${overdue ? " (overdue)" : ""}` : "—"}</td>
                    <td data-label="Status"><StatusBadge kind="knowledge" value={p.status} /></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : (
        <EmptyState icon="tasks" title={dq ? "No procedures match" : "No procedures yet"} action={can("knowledge.contribute") ? <LinkButton to="/knowledge/new?type=procedure" icon="plus">Add a procedure</LinkButton> : undefined}>
          {dq ? "Try another word, or ask the Knowledge assistant." : "Document recurring CSI workflows so they don't depend on one person."}
        </EmptyState>
      )}
    </>
  );
}
