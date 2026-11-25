import { Link, useNavigate } from "react-router-dom";
import { useApi } from "../../lib/hooks";
import { fmtDate, money } from "../../lib/format";
import { statusMeta, STATUS } from "../../lib/status";
import { Card, ErrorState, Loading, StatCard, StatusBadge, Badge } from "../../components/ui";
import { Icon } from "../../components/Icon";
import type { AttentionItem, Overview as O } from "./types";
import { TYPE_ICON } from "./types";

const TONE_COLOR: Record<string, string> = { ok: "var(--ok)", warn: "#d08a12", danger: "var(--danger)", accent: "var(--accent)", neutral: "var(--border-strong)", ai: "var(--ai)" };

function Distribution({ kind, rows, field }: { kind: string; rows: { n: number; [k: string]: string | number }[]; field: string }) {
  const total = rows.reduce((a, r) => a + r.n, 0);
  if (!total) return <p className="muted small">No projects.</p>;
  const order = Object.keys(STATUS[kind] ?? {});
  const sorted = [...rows].sort((a, b) => order.indexOf(String(a[field])) - order.indexOf(String(b[field])));
  return (
    <div>
      <div className="mgt-dist" role="img" aria-label={sorted.map((r) => `${statusMeta(kind, String(r[field])).label}: ${r.n}`).join(", ")}>
        {sorted.map((r) => (
          <span key={String(r[field])} style={{ width: `${(100 * r.n) / total}%`, background: TONE_COLOR[statusMeta(kind, String(r[field])).tone] }} />
        ))}
      </div>
      <div className="mgt-legend">
        {sorted.map((r) => (
          <span key={String(r[field])}>
            <i style={{ background: TONE_COLOR[statusMeta(kind, String(r[field])).tone] }} />
            {statusMeta(kind, String(r[field])).label} <strong>{r.n}</strong>
          </span>
        ))}
      </div>
    </div>
  );
}

export default function Overview() {
  const { data, loading, error, reload } = useApi<O>("/management/overview");
  const att = useApi<{ items: AttentionItem[]; counts: Record<string, number> }>("/management/attention");
  const nav = useNavigate();
  if (loading && !data) return <Loading />;
  if (error) return <ErrorState error={error} onRetry={reload} />;
  if (!data) return null;
  const pipeTotal = data.pipeline.filter((p) => !["lost", "secured"].includes(p.stage));
  const maxN = Math.max(1, ...data.pipeline.map((p) => p.n));
  const stageOrder = Object.keys(STATUS.opportunity);
  return (
    <div className="stack" style={{ gap: 20 }}>
      <div className="grid grid-4">
        <StatCard label="Active projects" icon="folder" value={data.projects.active} hint={`${data.projects.at_risk} at risk · ${data.projects.blocked} blocked`} tone={data.projects.blocked ? "danger" : data.projects.at_risk ? "warn" : undefined} onClick={() => nav("/management/portfolio")} />
        <StatCard label="Milestones" icon="milestone" value={data.milestones.overdue} hint={`overdue · ${data.milestones.upcoming_14d} due in 14 days`} tone={data.milestones.overdue ? "danger" : "ok"} onClick={() => nav("/management/attention?type=milestone")} />
        <StatCard label="Deliverables outstanding" icon="package" value={data.deliverables.outstanding} hint={`${data.deliverables.overdue} overdue`} tone={data.deliverables.overdue ? "warn" : undefined} onClick={() => nav("/management/attention?type=deliverable")} />
        <StatCard label="Decisions needing attention" icon="flag" value={data.decisions.requiring_attention} tone={data.decisions.requiring_attention ? "warn" : "ok"} onClick={() => nav("/management/decisions")} />
        <StatCard label="Open project actions" icon="tasks" value={data.actions.open} hint={`${data.actions.overdue} overdue`} tone={data.actions.overdue ? "warn" : undefined} onClick={() => nav("/management/attention?type=task")} />
        <StatCard label="Awaiting review" icon="eye" value={data.actions.awaiting_review} hint="project actions" onClick={() => nav("/management/portfolio")} />
        <StatCard label="Needs intervention" icon="alert" value={att.data?.items.length ?? "…"} hint={att.data ? `${att.data.counts.critical} critical · ${att.data.counts.high} high` : undefined} tone={att.data?.counts.critical ? "danger" : undefined} onClick={() => nav("/management/attention")} />
        <StatCard label="Open opportunities" icon="target" value={pipeTotal.reduce((a, p) => a + p.n, 0)} hint={money(pipeTotal.reduce((a, p) => a + (p.value ?? 0), 0))} onClick={() => nav("/opportunities")} />
      </div>
      <p className="tiny muted">{data.actions.note} Figures cover projects you are authorised to see.</p>

      <div className="grid grid-2">
        <Card title="Project health">
          <Distribution kind="health" rows={data.projects.health} field="health" />
          <h3 className="mt-3 mb-1">Project status</h3>
          <Distribution kind="project" rows={data.projects.status} field="status" />
        </Card>
        <Card title="Attention required" actions={<Link to="/management/attention" className="small">View all</Link>}>
          {att.loading && !att.data ? (
            <Loading />
          ) : att.data && att.data.items.length ? (
            <ul className="stack-sm" style={{ listStyle: "none", margin: 0, padding: 0 }}>
              {att.data.items.slice(0, 6).map((i) => (
                <li key={`${i.type}${i.id}`} className="row" style={{ flexWrap: "nowrap", alignItems: "stretch" }}>
                  <span className={`mgt-sev ${i.severity}`} aria-hidden />
                  <div style={{ minWidth: 0 }} className="small">
                    <Link to={i.link} className="strong"><Icon name={TYPE_ICON[i.type] ?? "dot"} size={13} /> {i.title}</Link>
                    <div className="muted">{i.why}</div>
                  </div>
                </li>
              ))}
            </ul>
          ) : (
            <p className="muted small">Nothing currently requires intervention.</p>
          )}
        </Card>
      </div>

      <div className="grid grid-2">
        <Card title="Opportunity pipeline" actions={<Link to="/opportunities" className="small">Open pipeline</Link>}>
          {data.pipeline.length ? (
            <div className="mgt-pipeline">
              {[...data.pipeline].sort((a, b) => stageOrder.indexOf(a.stage) - stageOrder.indexOf(b.stage)).map((p) => (
                <div key={p.stage} style={{ display: "contents" }}>
                  <StatusBadge kind="opportunity" value={p.stage} />
                  <div className="track" aria-hidden><span style={{ width: `${(100 * p.n) / maxN}%` }} /></div>
                  <span className="nowrap">{p.n}{p.value ? ` · ${money(p.value)}` : ""}</span>
                </div>
              ))}
            </div>
          ) : (
            <p className="muted small">No opportunities recorded.</p>
          )}
          <p className="tiny muted mt-2">Values are estimates recorded by opportunity owners; confidential opportunities are shown only to authorised roles.</p>
        </Card>
        <Card title="Reporting deadlines" actions={<Link to="/reports" className="small">Reports</Link>}>
          {data.reporting_deadlines.length ? (
            <ul className="stack-sm" style={{ listStyle: "none", margin: 0, padding: 0 }}>
              {data.reporting_deadlines.map((d) => (
                <li key={d.id} className="row-between small">
                  <span>
                    <strong>{d.name}</strong>
                    <span className={`muted ${d.submission_deadline < data.today ? "overdue" : ""}`}> · due {fmtDate(d.submission_deadline)}</span>
                  </span>
                  {d.report_status ? <StatusBadge kind="report" value={d.report_status} /> : <Badge tone="warn">No draft</Badge>}
                </li>
              ))}
            </ul>
          ) : (
            <p className="muted small">No upcoming reporting deadlines.</p>
          )}
        </Card>
      </div>
    </div>
  );
}
