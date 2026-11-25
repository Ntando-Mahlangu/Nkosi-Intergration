import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { api } from "../../../lib/api";
import { useApi } from "../../../lib/hooks";
import { useToast } from "../../../lib/app-state";
import { fmtDate, relTime } from "../../../lib/format";
import { AIBadge, Badge, Button, Callout, Card, EmptyState, ErrorState, Loading, SelectInput, StatusBadge } from "../../../components/ui";
import { recordPath } from "../../../components/records";
import { Icon } from "../../../components/Icon";
import { SOURCE_LABELS, type PeriodRow } from "./shared";

interface Dashboard {
  period: PeriodRow;
  today: string;
  deadline_days: number | null;
  report: { id: string; status: string; title: string; version: number; generated_by: string; updated_at: string; quality_flags: string[]; minutes_saved_estimate: number | null; approved_at: string | null } | null;
  source_counts: Record<string, number>;
  missing_updates: { id: string; name: string; owner_name: string | null }[];
  review_items: { type: string; id: string; title: string; reason: string }[];
  previous: { id: string; title: string; status: string; start_date: string | null; end_date: string | null; approved_at: string | null }[];
  estimated_minutes_saved: number;
  minutes_saved_basis: string;
  can_manage: boolean;
  can_approve: boolean;
}

export default function FakaweTab({ onCreatePeriod }: { onCreatePeriod: () => void }) {
  const periods = useApi<{ items: PeriodRow[]; today: string }>("/fakawe");
  const [selected, setSelected] = useState<string>("");
  const list = (periods.data?.items ?? []).filter((p) => p.status !== "archived");
  const today = periods.data?.today ?? "";
  // Default: the period containing today, else the most recent open one.
  const current = selected || list.find((p) => p.start_date <= today && p.end_date >= today)?.id || list[0]?.id || "";

  if (periods.loading && !periods.data) return <Loading />;
  if (periods.error) return <ErrorState error={periods.error} onRetry={periods.reload} />;
  if (!list.length)
    return (
      <EmptyState icon="calendar" title="No open reporting period" action={<Button variant="primary" icon="plus" onClick={onCreatePeriod}>Create reporting period</Button>}>
        Create a weekly, biweekly or monthly Fakawe period to start compiling a digest.
      </EmptyState>
    );
  return (
    <div className="stack">
      {list.length > 1 && (
        <div style={{ maxWidth: 420 }}>
          <SelectInput label="Reporting period" value={current} onChange={setSelected} options={list.map((p) => ({ value: p.id, label: `${p.name} (${fmtDate(p.start_date)} – ${fmtDate(p.end_date)})` }))} />
        </div>
      )}
      {current && <PeriodDashboard id={current} onChanged={periods.reload} />}
    </div>
  );
}

function PeriodDashboard({ id, onChanged }: { id: string; onChanged: () => void }) {
  const { data, loading, error, reload } = useApi<Dashboard>(`/fakawe/${id}/dashboard`);
  const toast = useToast();
  const nav = useNavigate();
  const [busy, setBusy] = useState(false);
  if (loading && !data) return <Loading />;
  if (error) return <ErrorState error={error} onRetry={reload} />;
  if (!data) return null;
  const { period, report } = data;
  const canGenerate = data.can_manage && (!report || report.status === "draft");
  const generate = async () => {
    setBusy(true);
    try {
      const r = await api.post<{ report_id: string; source_count: number; quality_flags: string[] }>(`/fakawe/${id}/generate`);
      toast.success(`Draft ${report ? "regenerated" : "generated"} from ${r.source_count} source records${r.quality_flags.length ? ` — ${r.quality_flags.length} quality note(s)` : ""}.`);
      reload();
      onChanged();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const totalSources = Object.values(data.source_counts).reduce((a, b) => a + b, 0);
  const dd = data.deadline_days;

  return (
    <div className="stack">
      <Card>
        <div className="fkw-period-head">
          <div>
            <h2>{period.name}</h2>
            <div className="muted small">
              {fmtDate(period.start_date, { year: true })} – {fmtDate(period.end_date, { year: true })} · {period.frequency}
              {period.owner_name ? ` · Owner ${period.owner_name}` : ""}
              {period.approver_name ? ` · Approver ${period.approver_name}` : ""}
            </div>
            {period.submission_deadline && (
              <div className={`small mt-1 fkw-deadline ${dd !== null && dd < 0 && (!report || !["approved", "final", "published"].includes(report.status)) ? "overdue" : ""}`}>
                <Icon name="clock" size={14} /> Deadline {fmtDate(period.submission_deadline)}
                {dd !== null && (dd > 0 ? ` (in ${dd} day${dd === 1 ? "" : "s"})` : dd === 0 ? " (today)" : ` (${-dd} day${dd === -1 ? "" : "s"} ago)`)}
              </div>
            )}
          </div>
          <div className="row">
            {report ? (
              <>
                <StatusBadge kind="report" value={report.status} />
                <AIBadge engine={report.generated_by} />
              </>
            ) : (
              <Badge tone="neutral" icon="file">No draft yet</Badge>
            )}
          </div>
        </div>
        <div className="row mt-2">
          {canGenerate && (
            <Button variant="primary" icon={report ? "refresh" : "sparkles"} loading={busy} onClick={generate}>
              {report ? "Regenerate draft" : "Generate draft"}
            </Button>
          )}
          {report && (
            <Button icon="report" onClick={() => nav(`/reports/${report.id}`)}>
              {report.status === "draft" ? "Review & edit draft" : "Open report"}
            </Button>
          )}
          {report && report.status !== "draft" && data.can_manage && <span className="small muted">Regeneration is only possible while the report is a draft.</span>}
          {!data.can_manage && <span className="small muted">Only reporting coordinators can generate drafts.</span>}
        </div>
        {report && (
          <p className="small muted mt-2">
            Version {report.version}, updated {relTime(report.updated_at)}. The digest stays a draft until it is approved through the report review workflow.
          </p>
        )}
      </Card>

      {report && report.quality_flags.length > 0 && (
        <Callout tone="warn" icon="alert">
          <strong>Quality notes for the current draft</strong>
          <ul className="fkw-flags mt-1">
            {report.quality_flags.map((f, i) => (
              <li key={i}>{f}</li>
            ))}
          </ul>
        </Callout>
      )}

      <div className="grid grid-2">
        <Card title="Source records in this period" actions={<span className="small muted">{totalSources} total</span>}>
          {totalSources === 0 ? (
            <p className="muted small">No qualifying records yet. Approved meetings, project updates, completed actions and decisions will appear here.</p>
          ) : (
            <div className="fkw-counts">
              {Object.entries(data.source_counts).map(([k, n]) => (
                <div className="fkw-count" key={k}>
                  <span className="n">{n}</span>
                  <span className="l">{SOURCE_LABELS[k] ?? k}</span>
                </div>
              ))}
            </div>
          )}
          <p className="tiny muted mt-2">
            Only records you are permitted to see are counted. Restricted projects, confidential meetings, personal tasks and private learning are never included in a digest.
          </p>
        </Card>
        <Card title="Missing project updates" actions={<Badge tone={data.missing_updates.length ? "warn" : "ok"}>{data.missing_updates.length}</Badge>}>
          {data.missing_updates.length ? (
            <ul className="stack-sm" style={{ listStyle: "none", padding: 0, margin: 0 }}>
              {data.missing_updates.map((p) => (
                <li key={p.id} className="row-between small">
                  <Link to={`/projects/${p.id}`}>{p.name}</Link>
                  <span className="muted">{p.owner_name ?? "No owner"}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="muted small">Every active project has posted an update this period.</p>
          )}
        </Card>
      </div>

      <div className="grid grid-2">
        <Card title="Needs review before inclusion">
          {data.review_items.length ? (
            <ul className="stack-sm" style={{ listStyle: "none", padding: 0, margin: 0 }}>
              {data.review_items.map((r) => (
                <li key={`${r.type}${r.id}`} className="small">
                  <Link to={recordPath(r.type, r.id)}>{r.title}</Link>
                  <div className="muted">{r.reason}</div>
                </li>
              ))}
            </ul>
          ) : (
            <p className="muted small">Nothing waiting for review.</p>
          )}
        </Card>
        <Card title="Previous digests">
          {data.previous.length ? (
            <ul className="stack-sm" style={{ listStyle: "none", padding: 0, margin: 0 }}>
              {data.previous.map((r) => (
                <li key={r.id} className="row-between small">
                  <Link to={`/reports/${r.id}`}>{r.title}</Link>
                  <StatusBadge kind="report" value={r.status} />
                </li>
              ))}
            </ul>
          ) : (
            <p className="muted small">No earlier approved digests.</p>
          )}
        </Card>
      </div>

      {data.estimated_minutes_saved > 0 && (
        <p className="small muted">
          <Icon name="clock" size={14} /> Estimated compilation time saved: about {data.estimated_minutes_saved} minutes. {data.minutes_saved_basis}
        </p>
      )}
    </div>
  );
}
