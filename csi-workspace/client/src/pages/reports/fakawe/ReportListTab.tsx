import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useApi } from "../../../lib/hooks";
import { fmtDate, relTime, humanize } from "../../../lib/format";
import { EmptyState, ErrorState, Loading, Segmented, StatusBadge } from "../../../components/ui";
import { asRows, type ReportRow } from "./shared";

const FINAL = ["final", "published", "archived", "approved"];

export default function ReportListTab({ type, archive, emptyText }: { type?: string; archive?: boolean; emptyText: string }) {
  const { data, loading, error, reload } = useApi<unknown>("/reports", type ? { type } : undefined);
  const nav = useNavigate();
  const [filter, setFilter] = useState<"all" | "open" | "final">("all");
  const [q, setQ] = useState("");
  const rows = useMemo(() => {
    let r = asRows<ReportRow>(data);
    if (archive) r = r.filter((x) => FINAL.includes(x.status));
    if (!archive && filter === "open") r = r.filter((x) => !FINAL.includes(x.status));
    if (!archive && filter === "final") r = r.filter((x) => FINAL.includes(x.status));
    if (q.trim()) {
      const s = q.toLowerCase();
      r = r.filter((x) => `${x.title} ${x.project_name ?? ""} ${x.meeting_title ?? ""}`.toLowerCase().includes(s));
    }
    return r.sort((a, b) => (b.updated_at ?? "").localeCompare(a.updated_at ?? ""));
  }, [data, archive, filter, q]);

  if (loading && !data) return <Loading />;
  if (error) return <ErrorState error={error} onRetry={reload} />;
  return (
    <div className="stack">
      <div className="filter-bar">
        <input className="input" type="search" placeholder="Filter by title or project…" aria-label="Filter reports" value={q} onChange={(e) => setQ(e.target.value)} />
        {!archive && (
          <Segmented
            label="Report status"
            value={filter}
            onChange={setFilter}
            options={[
              { key: "all", label: "All" },
              { key: "open", label: "In progress" },
              { key: "final", label: "Approved & final" },
            ]}
          />
        )}
      </div>
      {rows.length === 0 ? (
        <EmptyState icon="report" title="No reports">{emptyText}</EmptyState>
      ) : (
        <div className="card table-wrap">
          <table className="table table-stack">
            <thead>
              <tr>
                <th>Report</th>
                {!type && <th>Type</th>}
                <th>Related to</th>
                <th>Status</th>
                <th>Updated</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} className="clickable" onClick={() => nav(`/reports/${r.id}`)}>
                  <td data-label="Report">
                    <a href={`/reports/${r.id}`} onClick={(e) => { e.preventDefault(); nav(`/reports/${r.id}`); }} className="strong">{r.title}</a>
                  </td>
                  {!type && <td data-label="Type">{r.report_type === "fakawe" ? "Fakawe digest" : humanize(r.report_type)}</td>}
                  <td data-label="Related to" className="small">
                    {r.meeting_title ? `${r.meeting_title}${r.meeting_date ? ` (${fmtDate(r.meeting_date)})` : ""}` : r.project_name ?? <span className="muted">—</span>}
                  </td>
                  <td data-label="Status"><StatusBadge kind="report" value={r.status} /></td>
                  <td data-label="Updated" className="small muted">{relTime(r.updated_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
