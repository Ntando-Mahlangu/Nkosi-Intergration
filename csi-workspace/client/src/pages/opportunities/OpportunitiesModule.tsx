import { useEffect, useMemo, useState } from "react";
import { Link, Route, Routes, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { api } from "../../lib/api";
import { useApi, useDebounced, localToday } from "../../lib/hooks";
import { useAuth, useLookups, useToast } from "../../lib/app-state";
import { STATUS, statusMeta, options } from "../../lib/status";
import { fmtDate, money, dueLabel, relTime, humanize } from "../../lib/format";
import {
  AIBadge, Badge, Button, Callout, Card, EmptyState, ErrorState, KeyValue, Loading, Modal, PageHeader, PersonChip, RichText, Segmented,
  SelectInput, StatusBadge, Tabs, TextArea, TextInput, FormError,
} from "../../components/ui";
import { Comments, DocumentLinks, UserSelect, recordPath } from "../../components/records";
import { Icon } from "../../components/Icon";
import { OpportunityFormModal, type Opportunity } from "./OpportunityForm";
import "./opportunities.css";

const STAGES = Object.keys(STATUS.opportunity);

interface Summary {
  by_stage: { stage: string; count: number; value: number | null; weighted: number | null }[];
  open_count: number;
  open_value: number;
  weighted_value: number;
  follow_ups_due: number;
  recently_closed: { id: string; name: string; stage: string }[];
  note: string;
}

export default function OpportunitiesModule() {
  return (
    <Routes>
      <Route index element={<PipelinePage />} />
      <Route path=":id" element={<OpportunityDetail />} />
    </Routes>
  );
}

// =================================================================== pipeline
function PipelinePage() {
  const [params, setParams] = useSearchParams();
  const { lookups } = useLookups();
  const toast = useToast();
  const nav = useNavigate();
  const view = (params.get("view") as "board" | "list" | "signals") ?? "board";
  const [q, setQ] = useState("");
  const [type, setType] = useState("");
  const [owner, setOwner] = useState("");
  const [relevance, setRelevance] = useState("");
  const [dueOnly, setDueOnly] = useState(false);
  const dq = useDebounced(q);
  const list = useApi<{ items: Opportunity[] }>("/opportunities", { q: dq, type, owner_id: owner, relevance, follow_up_due: dueOnly ? "1" : "" });
  const summary = useApi<Summary>("/opportunities/summary");
  const createOpen = params.get("new") === "1";
  const setView = (v: string) => {
    const p = new URLSearchParams(params);
    p.set("view", v);
    setParams(p, { replace: true });
  };
  const closeCreate = () => {
    const p = new URLSearchParams(params);
    p.delete("new");
    setParams(p, { replace: true });
  };

  const moveStage = async (o: Opportunity, stage: string) => {
    if (stage === o.stage) return;
    const prev = list.data;
    list.setData((d) => (d ? { ...d, items: d.items.map((x) => (x.id === o.id ? { ...x, stage } : x)) } : d));
    try {
      await api.post(`/opportunities/${o.id}/stage`, { stage });
      toast.success(`Moved “${o.name}” to ${statusMeta("opportunity", stage).label}`);
      summary.reload();
    } catch (e) {
      list.setData(prev);
      toast.error((e as Error).message);
    }
  };

  const types = lookups?.taxonomies.opportunity_type ?? [];
  return (
    <>
      <PageHeader
        title="Opportunities & Partnerships"
        subtitle="Identify, assess, develop and follow up potential opportunities."
        actions={
          <Button variant="primary" icon="plus" onClick={() => setParams({ ...Object.fromEntries(params), new: "1" })}>
            New opportunity
          </Button>
        }
      />
      {summary.data && <SummaryStrip s={summary.data} onDue={() => { setDueOnly(true); setView("list"); }} />}
      <Tabs
        tabs={[
          { key: "board", label: "Pipeline" },
          { key: "list", label: "List" },
          { key: "signals", label: "Suggested signals" },
        ]}
        value={view}
        onChange={setView}
      />
      {view !== "signals" && (
        <div className="filter-bar">
          <input className="input" type="search" placeholder="Search name, organisation, contact…" aria-label="Search opportunities" value={q} onChange={(e) => setQ(e.target.value)} />
          <select className="select" aria-label="Filter by type" value={type} onChange={(e) => setType(e.target.value)}>
            <option value="">All types</option>
            {types.map((t) => <option key={t}>{t}</option>)}
          </select>
          <select className="select" aria-label="Filter by owner" value={owner} onChange={(e) => setOwner(e.target.value)}>
            <option value="">All owners</option>
            {(lookups?.users ?? []).map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
          </select>
          <select className="select" aria-label="Filter by strategic relevance" value={relevance} onChange={(e) => setRelevance(e.target.value)}>
            <option value="">Any relevance</option>
            <option value="high">High relevance</option>
            <option value="medium">Medium relevance</option>
            <option value="low">Low relevance</option>
          </select>
          <label className="check small">
            <input type="checkbox" checked={dueOnly} onChange={(e) => setDueOnly(e.target.checked)} /> Follow-up due
          </label>
        </div>
      )}
      {view === "signals" ? (
        <SignalsView onConverted={(id) => nav(`/opportunities/${id}`)} />
      ) : list.error ? (
        <ErrorState error={list.error} onRetry={list.reload} />
      ) : !list.data ? (
        <Loading />
      ) : view === "board" ? (
        <Board items={list.data.items} onMove={moveStage} />
      ) : (
        <ListView items={list.data.items} />
      )}
      <OpportunityFormModal
        open={createOpen}
        onClose={closeCreate}
        onSaved={(o) => {
          closeCreate();
          list.reload();
          summary.reload();
          nav(`/opportunities/${o.id}`);
        }}
      />
    </>
  );
}

function SummaryStrip({ s, onDue }: { s: Summary; onDue: () => void }) {
  return (
    <div className="opp-summary" aria-label="Pipeline summary">
      <div className="card">
        <div className="tiny muted">Open opportunities</div>
        <div className="opp-sum-value">{s.open_count}</div>
      </div>
      <div className="card" title={s.note}>
        <div className="tiny muted">Open estimated value</div>
        <div className="opp-sum-value">{money(s.open_value)}</div>
        <div className="tiny muted">Weighted: {money(s.weighted_value)}</div>
      </div>
      <button className="card clickable" style={{ textAlign: "left", font: "inherit" }} onClick={onDue}>
        <div className="tiny muted">Follow-ups due</div>
        <div className="opp-sum-value" style={{ color: s.follow_ups_due ? "var(--warn)" : undefined }}>{s.follow_ups_due}</div>
      </button>
      {s.by_stage.filter((b) => b.count > 0).map((b) => (
        <div className="card" key={b.stage}>
          <div className="tiny muted">{statusMeta("opportunity", b.stage).label}</div>
          <div className="opp-sum-value">{b.count}</div>
          {!!b.value && <div className="tiny muted">{money(b.value)}</div>}
        </div>
      ))}
    </div>
  );
}

function OppMeta({ o }: { o: Opportunity }) {
  const due = o.follow_up_date && !["secured", "lost"].includes(o.stage) ? dueLabel(o.follow_up_date, localToday()) : null;
  return (
    <div className="opp-card-meta">
      {o.organisation && <span>{o.organisation}</span>}
      {o.estimated_value !== null && <span>{money(o.estimated_value)}</span>}
      {o.probability !== null && <span>{o.probability}%</span>}
      {o.strategic_relevance === "high" && <Badge tone="accent" icon="flag">High relevance</Badge>}
      {!!o.confidential && <Badge tone="neutral" icon="lock">Confidential</Badge>}
      {due && <span className={due.cls}>Follow-up: {due.text.replace(/^Due /, "")}</span>}
    </div>
  );
}

function Board({ items, onMove }: { items: Opportunity[]; onMove: (o: Opportunity, stage: string) => void }) {
  const { me, can } = useAuth();
  const [dragId, setDragId] = useState<string | null>(null);
  const [over, setOver] = useState<string | null>(null);
  const canMove = (o: Opportunity) => o.owner_id === me?.user.id || o.created_by === me?.user.id || can("opportunity.manage") || can("management.view");
  if (!items.length) return <EmptyState icon="target" title="No opportunities match">Add an opportunity, or check the suggested signals tab.</EmptyState>;
  return (
    <div className="kanban" role="list" aria-label="Opportunity pipeline">
      {STAGES.map((stage) => {
        const col = items.filter((o) => o.stage === stage);
        const total = col.reduce((a, o) => a + (o.estimated_value ?? 0), 0);
        return (
          <section
            key={stage}
            className={`kanban-col ${over === stage ? "drop-target" : ""}`}
            aria-label={`${statusMeta("opportunity", stage).label} column`}
            onDragOver={(e) => { if (dragId) { e.preventDefault(); setOver(stage); } }}
            onDragLeave={() => setOver((s) => (s === stage ? null : s))}
            onDrop={(e) => {
              e.preventDefault();
              const o = items.find((x) => x.id === (e.dataTransfer.getData("text/plain") || dragId));
              setOver(null);
              setDragId(null);
              if (o && canMove(o)) onMove(o, stage);
            }}
          >
            <div className="kanban-col-head">
              <StatusBadge kind="opportunity" value={stage} />
              <span className="opp-col-total">{col.length}{total ? ` · ${money(total)}` : ""}</span>
            </div>
            <div className="kanban-col-body" role="list">
              {col.map((o) => (
                <article
                  key={o.id}
                  role="listitem"
                  className={`kanban-card ${dragId === o.id ? "dragging" : ""}`}
                  draggable={canMove(o)}
                  onDragStart={(e) => { e.dataTransfer.setData("text/plain", o.id); setDragId(o.id); }}
                  onDragEnd={() => { setDragId(null); setOver(null); }}
                >
                  <Link to={`/opportunities/${o.id}`} className="opp-card-title">{o.name}</Link>
                  <OppMeta o={o} />
                  <div className="opp-card-meta"><PersonChip name={o.owner_name} /></div>
                  {canMove(o) && (
                    <div className="opp-card-move">
                      <label className="sr-only" htmlFor={`mv-${o.id}`}>Move {o.name} to stage</label>
                      <select id={`mv-${o.id}`} value={o.stage} onChange={(e) => onMove(o, e.target.value)}>
                        {options("opportunity").map((s) => <option key={s.value} value={s.value}>Stage: {s.label}</option>)}
                      </select>
                    </div>
                  )}
                </article>
              ))}
              {!col.length && <p className="tiny muted" style={{ padding: "6px 4px" }}>Nothing here</p>}
            </div>
          </section>
        );
      })}
    </div>
  );
}

function ListView({ items }: { items: Opportunity[] }) {
  const nav = useNavigate();
  if (!items.length) return <EmptyState icon="target" title="No opportunities match" />;
  return (
    <div className="card table-wrap">
      <table className="table table-stack">
        <thead>
          <tr><th>Opportunity</th><th>Type</th><th>Stage</th><th>Owner</th><th>Value</th><th>Next action</th><th>Follow-up</th></tr>
        </thead>
        <tbody>
          {items.map((o) => {
            const due = o.follow_up_date ? dueLabel(o.follow_up_date, localToday(), ["secured", "lost"].includes(o.stage)) : null;
            return (
              <tr key={o.id} className="clickable" onClick={() => nav(`/opportunities/${o.id}`)}>
                <td data-label="Opportunity"><Link to={`/opportunities/${o.id}`} onClick={(e) => e.stopPropagation()}>{o.name}</Link>{o.organisation && <div className="tiny muted">{o.organisation}</div>}</td>
                <td data-label="Type">{o.opportunity_type}</td>
                <td data-label="Stage"><StatusBadge kind="opportunity" value={o.stage} /></td>
                <td data-label="Owner">{o.owner_name ?? "—"}</td>
                <td data-label="Value">{o.estimated_value !== null ? money(o.estimated_value) : "—"}{o.probability !== null && <span className="tiny muted"> · {o.probability}%</span>}</td>
                <td data-label="Next action">{o.next_action || <span className="muted">—</span>}</td>
                <td data-label="Follow-up">{due ? <span className={due.cls}>{fmtDate(o.follow_up_date)}</span> : "—"}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// =================================================================== signals
interface SignalRow { key: string; source_type: "meeting" | "knowledge"; source_id: string; source_title: string; signal: string; evidence: string; suggested_name: string; engine: string }

function SignalsView({ onConverted }: { onConverted: (id: string) => void }) {
  const { data, error, loading, reload } = useApi<{ items: SignalRow[]; note: string; engine: string }>("/opportunities/signals");
  const { lookups } = useLookups();
  const toast = useToast();
  const [converting, setConverting] = useState<SignalRow | null>(null);
  const [form, setForm] = useState({ name: "", opportunity_type: "Other", organisation: "", description: "" });
  const [err, setErr] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [dismissed, setDismissed] = useState<Set<string>>(new Set());

  const start = (s: SignalRow) => {
    setConverting(s);
    setForm({ name: s.suggested_name, opportunity_type: "Other", organisation: "", description: `Evidence: “${s.evidence}” (from ${s.source_title})` });
    setErr({});
  };
  const convert = async () => {
    if (!converting) return;
    if (!form.name.trim()) return setErr({ name: "Give the opportunity a name." });
    setBusy(true);
    try {
      const o = await api.post<{ id: string }>("/opportunities/signals/convert", { source_type: converting.source_type, source_id: converting.source_id, ...form });
      toast.success("Opportunity created from signal");
      setConverting(null);
      reload();
      onConverted(o.id);
    } catch (e) {
      const x = e as { fields?: Record<string, string>; message: string };
      setErr(x.fields ?? {});
      toast.error(x.message);
    } finally {
      setBusy(false);
    }
  };
  if (error) return <ErrorState error={error} onRetry={reload} />;
  if (loading || !data) return <Loading />;
  const items = data.items.filter((s) => !dismissed.has(s.key));
  return (
    <div className="stack">
      <Callout tone="ai" icon="sparkles">
        <strong>Suggestions, not commitments.</strong> {data.note} Dismissing only hides a suggestion for this visit.
      </Callout>
      {!items.length ? (
        <EmptyState icon="sparkles" title="No new signals">Approved meetings and published knowledge you can access don't currently mention interest, partnerships, expansion, funding or proposals that aren't already linked to an opportunity.</EmptyState>
      ) : (
        <div className="card list">
          {items.map((s) => (
            <div className="list-item opp-signal" key={s.key}>
              <Icon name={s.source_type === "meeting" ? "meeting" : "book"} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div className="row"><span className="title">{s.signal}</span><AIBadge engine={s.engine} /></div>
                <div className="evidence mt-1">“{s.evidence}”</div>
                <div className="meta">From {humanize(s.source_type)}: <Link to={recordPath(s.source_type, s.source_id)}>{s.source_title}</Link></div>
              </div>
              <div className="row">
                <Button size="sm" variant="primary" onClick={() => start(s)}>Convert…</Button>
                <Button size="sm" variant="ghost" onClick={() => setDismissed((d) => new Set(d).add(s.key))}>Dismiss</Button>
              </div>
            </div>
          ))}
        </div>
      )}
      <Modal
        open={!!converting}
        onClose={() => setConverting(null)}
        title="Create opportunity from signal"
        footer={<><Button onClick={() => setConverting(null)}>Cancel</Button><Button variant="primary" loading={busy} onClick={convert}>Create opportunity</Button></>}
      >
        <p className="small muted">It will start in the <strong>Identified</strong> stage with you as owner, linked to its source record.</p>
        <TextInput label="Name" required value={form.name} onChange={(v) => setForm({ ...form, name: v })} error={err.name} />
        <SelectInput label="Type" value={form.opportunity_type} onChange={(v) => setForm({ ...form, opportunity_type: v })} options={(lookups?.taxonomies.opportunity_type ?? ["Other"]).map((t) => ({ value: t, label: t }))} />
        <TextInput label="Organisation" value={form.organisation} onChange={(v) => setForm({ ...form, organisation: v })} />
        <TextArea label="Description" rows={3} value={form.description} onChange={(v) => setForm({ ...form, description: v })} />
      </Modal>
    </div>
  );
}

// =================================================================== detail
interface Detail {
  opportunity: Opportunity;
  can_manage: boolean;
  history: { id: string; from_value: string | null; to_value: string; note: string; changed_by_name: string | null; changed_at: string }[];
  engagements: { id: string; body: string; author_name: string | null; created_at: string }[];
  follow_up_tasks: { id: string; ref: number; title: string; status: string; due_date: string | null; assignee_name: string | null }[];
  related: { link_id: string; type: string; id: string; label: string; relation: string }[];
}

function OpportunityDetail() {
  const { id } = useParams();
  const { data, error, loading, reload } = useApi<Detail>(`/opportunities/${id}`);
  const toast = useToast();
  const [edit, setEdit] = useState(false);
  const [stageOpen, setStageOpen] = useState(false);
  const [taskOpen, setTaskOpen] = useState(false);
  const [linkOpen, setLinkOpen] = useState(false);
  const [tab, setTab] = useState<"overview" | "engagements" | "documents" | "comments">("overview");

  if (error) return <ErrorState error={error} onRetry={reload} />;
  if (loading && !data) return <Loading />;
  if (!data) return null;
  const o = data.opportunity;
  const due = o.follow_up_date && !["secured", "lost"].includes(o.stage) ? dueLabel(o.follow_up_date, localToday()) : null;

  const unlink = async (linkId: string) => {
    try {
      await api.del(`/opportunities/${o.id}/links/${linkId}`);
      reload();
    } catch (e) {
      toast.error((e as Error).message);
    }
  };

  return (
    <>
      <PageHeader
        breadcrumbs={[{ label: "Opportunities", to: "/opportunities" }, { label: o.name }]}
        title={o.name}
        subtitle={
          <span className="row">
            <StatusBadge kind="opportunity" value={o.stage} />
            <span>{o.opportunity_type}</span>
            {o.organisation && <span>· {o.organisation}</span>}
            {!!o.confidential && <Badge icon="lock">Confidential</Badge>}
          </span>
        }
        actions={
          data.can_manage && (
            <>
              <Button icon="arrowRight" onClick={() => setStageOpen(true)}>Change stage</Button>
              <Button icon="tasks" onClick={() => setTaskOpen(true)}>Add follow-up</Button>
              <Button icon="edit" onClick={() => setEdit(true)}>Edit</Button>
            </>
          )
        }
      />
      {due && due.cls === "overdue" && (
        <div className="mb-2"><Callout tone="warn" icon="clock">Follow-up was due {fmtDate(o.follow_up_date)}{o.next_action ? ` — ${o.next_action}` : ""}.</Callout></div>
      )}
      <div className="cols-main-side">
        <div>
          <Tabs
            tabs={[
              { key: "overview", label: "Overview" },
              { key: "engagements", label: "Engagements", count: data.engagements.length },
              { key: "documents", label: "Proposals & documents" },
              { key: "comments", label: "Comments" },
            ]}
            value={tab}
            onChange={setTab}
          />
          {tab === "overview" && (
            <div className="stack">
              <Card title="Details">
                <KeyValue
                  items={[
                    ["Owner", <PersonChip name={o.owner_name} />],
                    ["Strategic relevance", humanize(o.strategic_relevance)],
                    ["Estimated value", o.estimated_value !== null ? money(o.estimated_value) : null],
                    ["Probability", o.probability !== null ? `${o.probability}%` : null],
                    ["Potential value", o.potential_value || null],
                    ["Contact", o.contact_name ? <span>{o.contact_name}{o.contact_email && <> · <a href={`mailto:${o.contact_email}`}>{o.contact_email}</a></>}</span> : null],
                    ["Source", o.source || null],
                    ["Identified", fmtDate(o.date_identified)],
                    ["Next action", o.next_action || null],
                    ["Follow-up", o.follow_up_date ? <span className={due?.cls}>{fmtDate(o.follow_up_date)}</span> : null],
                  ]}
                />
              </Card>
              {o.description && <Card title="Description"><RichText text={o.description} /></Card>}
              {o.notes && <Card title="Notes"><RichText text={o.notes} /></Card>}
              <Card title="Follow-up tasks" actions={data.can_manage && <Button size="sm" icon="plus" onClick={() => setTaskOpen(true)}>Add</Button>} pad={false}>
                {data.follow_up_tasks.length ? (
                  <div className="list">
                    {data.follow_up_tasks.map((t) => (
                      <div className="list-item" key={t.id}>
                        <div style={{ flex: 1 }}>
                          <Link to={`/tasks/${t.id}`} className="title">{t.title}</Link>
                          <div className="meta"><span>T-{t.ref}</span><span>{t.assignee_name ?? "Unassigned"}</span>{t.due_date && <span>Due {fmtDate(t.due_date)}</span>}</div>
                        </div>
                        <StatusBadge kind="task" value={t.status} />
                      </div>
                    ))}
                  </div>
                ) : (
                  <p className="muted small card-body">No follow-up tasks yet.</p>
                )}
              </Card>
            </div>
          )}
          {tab === "engagements" && <Engagements oppId={o.id} rows={data.engagements} onAdded={reload} />}
          {tab === "documents" && <DocumentLinks entityType="opportunity" entityId={o.id} canEdit={data.can_manage} title="Proposals & documents" />}
          {tab === "comments" && <Comments entityType="opportunity" entityId={o.id} />}
        </div>
        <aside className="stack">
          <Card title="Related records" actions={data.can_manage && <Button size="sm" icon="link" onClick={() => setLinkOpen(true)}>Link</Button>}>
            {data.related.length ? (
              <ul className="stack-sm" style={{ listStyle: "none", padding: 0, margin: 0 }}>
                {data.related.map((r) => (
                  <li key={r.link_id} className="row small">
                    <Icon name={r.type === "project" ? "folder" : r.type === "meeting" ? "meeting" : r.type === "task" ? "tasks" : "book"} size={14} />
                    {recordPath(r.type, r.id) !== "#" ? <Link to={recordPath(r.type, r.id)}>{r.label}</Link> : r.label}
                    <span className="tiny muted">{humanize(r.relation === "related" ? r.type : r.relation)}</span>
                    {data.can_manage && r.type !== "task" && (
                      <button className="btn btn-ghost btn-sm" aria-label={`Unlink ${r.label}`} onClick={() => unlink(r.link_id)}><Icon name="x" size={12} /></button>
                    )}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="muted small">Link related projects, research or meetings.</p>
            )}
          </Card>
          <Card title="Stage history">
            {data.history.length ? (
              <ul className="timeline">
                {data.history.map((h) => (
                  <li key={h.id}>
                    <span className="tl-dot"><Icon name={statusMeta("opportunity", h.to_value).icon} /></span>
                    <div className="small">
                      <div>{h.from_value ? <>{statusMeta("opportunity", h.from_value).label} → </> : "Created as "}<strong>{statusMeta("opportunity", h.to_value).label}</strong></div>
                      {h.note && <div className="muted">{h.note}</div>}
                      <div className="tiny muted">{h.changed_by_name ?? "System"} · {relTime(h.changed_at)}</div>
                    </div>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="muted small">No stage changes recorded.</p>
            )}
          </Card>
        </aside>
      </div>
      <OpportunityFormModal open={edit} existing={o} onClose={() => setEdit(false)} onSaved={() => { setEdit(false); reload(); }} />
      <StageModal open={stageOpen} opp={o} onClose={() => setStageOpen(false)} onDone={() => { setStageOpen(false); reload(); }} />
      <FollowUpModal open={taskOpen} opp={o} onClose={() => setTaskOpen(false)} onDone={() => { setTaskOpen(false); reload(); }} />
      <LinkModal open={linkOpen} oppId={o.id} onClose={() => setLinkOpen(false)} onDone={() => { setLinkOpen(false); reload(); }} />
    </>
  );
}

function Engagements({ oppId, rows, onAdded }: { oppId: string; rows: Detail["engagements"]; onAdded: () => void }) {
  const toast = useToast();
  const [body, setBody] = useState("");
  const [date, setDate] = useState(localToday());
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const add = async () => {
    if (!body.trim()) return setErr("Describe the engagement.");
    setBusy(true);
    try {
      await api.post(`/opportunities/${oppId}/engagements`, { body, date });
      setBody("");
      setErr("");
      toast.success("Engagement recorded");
      onAdded();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="stack">
      <Card title="Record an engagement">
        <div className="form-grid">
          <TextArea className="full" label="What happened?" rows={2} value={body} onChange={(v) => { setBody(v); setErr(""); }} error={err} placeholder="e.g. Intro call with HR lead — interested in a two-day pilot" />
          <TextInput label="Date" type="date" value={date} onChange={setDate} />
        </div>
        <div className="form-actions"><Button variant="primary" onClick={add} loading={busy}>Add engagement</Button></div>
      </Card>
      {rows.length ? (
        <ul className="timeline card card-pad">
          {rows.map((e) => (
            <li key={e.id}>
              <span className="tl-dot"><Icon name="message" /></span>
              <div className="small"><div className="prewrap">{e.body}</div><div className="tiny muted">{e.author_name ?? "Former user"} · {relTime(e.created_at)}</div></div>
            </li>
          ))}
        </ul>
      ) : (
        <EmptyState icon="message" title="No engagements yet">Log calls, meetings and correspondence so the history stays with the opportunity.</EmptyState>
      )}
    </div>
  );
}

function StageModal({ open, opp, onClose, onDone }: { open: boolean; opp: Opportunity; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const [stage, setStage] = useState(opp.stage);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (open) { setStage(opp.stage); setNote(""); } }, [open, opp.stage]);
  const save = async () => {
    setBusy(true);
    try {
      await api.post(`/opportunities/${opp.id}/stage`, { stage, note });
      toast.success(`Stage changed to ${statusMeta("opportunity", stage).label}`);
      onDone();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal open={open} onClose={onClose} title="Change stage" footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" loading={busy} disabled={stage === opp.stage} onClick={save}>Save stage</Button></>}>
      <SelectInput label="Stage" value={stage} onChange={setStage} options={options("opportunity")} />
      <TextArea label="Note (optional)" rows={2} value={note} onChange={setNote} hint={stage === "lost" ? "Recording why helps future opportunities." : undefined} />
    </Modal>
  );
}

function FollowUpModal({ open, opp, onClose, onDone }: { open: boolean; opp: Opportunity; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const { me, can } = useAuth();
  const [v, setV] = useState({ title: "", due_date: "", assignee_id: "", description: "" });
  const [errs, setErrs] = useState<Record<string, string>>({});
  const [formErr, setFormErr] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (open) { setV({ title: opp.next_action || "", due_date: opp.follow_up_date ?? "", assignee_id: opp.owner_id ?? me?.user.id ?? "", description: "" }); setErrs({}); setFormErr(""); } }, [open, opp, me]);
  const canDelegate = can("opportunity.manage") || can("task.assign_any");
  const save = async () => {
    const e: Record<string, string> = {};
    if (!v.title.trim()) e.title = "Describe the follow-up.";
    if (!v.due_date) e.due_date = "Choose a due date.";
    setErrs(e);
    if (Object.keys(e).length) return;
    setBusy(true);
    try {
      await api.post(`/opportunities/${opp.id}/follow-up-task`, { ...v, assignee_id: v.assignee_id || null });
      toast.success("Follow-up task created and assigned");
      onDone();
    } catch (x) {
      const err = x as { fields?: Record<string, string>; message: string };
      setErrs(err.fields ?? {});
      setFormErr(err.message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal open={open} onClose={onClose} title="Add follow-up task" footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" loading={busy} onClick={save}>Create task</Button></>}>
      <FormError message={formErr} />
      <TextInput label="Task" required value={v.title} onChange={(x) => setV({ ...v, title: x })} error={errs.title} />
      <TextInput label="Due date" type="date" required value={v.due_date} onChange={(x) => setV({ ...v, due_date: x })} error={errs.due_date} />
      {canDelegate ? (
        <UserSelect label="Assign to" value={v.assignee_id} onChange={(x) => setV({ ...v, assignee_id: x })} error={errs.assignee_id} />
      ) : (
        <SelectInput label="Assign to" value={v.assignee_id} onChange={(x) => setV({ ...v, assignee_id: x })} options={[{ value: me?.user.id ?? "", label: "Me" }, ...(opp.owner_id && opp.owner_id !== me?.user.id ? [{ value: opp.owner_id, label: `${opp.owner_name} (owner)` }] : [])]} />
      )}
      <TextArea label="Notes" rows={2} value={v.description} onChange={(x) => setV({ ...v, description: x })} />
      <p className="tiny muted">The task appears in the assignee's workspace and updates this opportunity's next action and follow-up date.</p>
    </Modal>
  );
}

function LinkModal({ open, oppId, onClose, onDone }: { open: boolean; oppId: string; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const { lookups } = useLookups();
  const [type, setType] = useState<"project" | "knowledge" | "meeting">("project");
  const [target, setTarget] = useState("");
  const [busy, setBusy] = useState(false);
  const [q, setQ] = useState("");
  const dq = useDebounced(q);
  const search = useApi<{ results?: { type: string; id: string; title: string }[] } | { type: string; id: string; title: string }[]>(open && type !== "project" && dq.length > 1 ? "/search" : null, { q: dq, types: type });
  const results = useMemo(() => {
    const d = search.data as unknown;
    const arr = Array.isArray(d) ? d : ((d as { results?: unknown[] } | null)?.results ?? []);
    return (arr as { type: string; id: string; title?: string; label?: string }[]).filter((r) => r.type === type);
  }, [search.data, type]);
  useEffect(() => { if (open) { setTarget(""); setQ(""); } }, [open, type]);
  const save = async () => {
    if (!target) return;
    setBusy(true);
    try {
      await api.post(`/opportunities/${oppId}/links`, { type, id: target });
      toast.success("Record linked");
      onDone();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal open={open} onClose={onClose} title="Link a related record" footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" loading={busy} disabled={!target} onClick={save}>Link record</Button></>}>
      <Segmented label="Record type" value={type} onChange={setType} options={[{ key: "project", label: "Project" }, { key: "knowledge", label: "Knowledge" }, { key: "meeting", label: "Meeting" }]} />
      <div className="mt-2">
        {type === "project" ? (
          <SelectInput label="Project" value={target} onChange={setTarget} placeholder="Choose a project…" options={(lookups?.projects ?? []).map((p) => ({ value: p.id, label: p.name }))} />
        ) : (
          <>
            <TextInput label={`Search ${type === "knowledge" ? "knowledge items" : "meetings"}`} value={q} onChange={setQ} placeholder="Type at least 2 characters" />
            {search.loading && <Loading />}
            {dq.length > 1 && !search.loading && (
              results.length ? (
                <div className="stack-sm" role="radiogroup" aria-label="Search results">
                  {results.slice(0, 15).map((r) => (
                    <label key={r.id} className="check small">
                      <input type="radio" name="link-target" checked={target === r.id} onChange={() => setTarget(r.id)} /> {r.title ?? r.label}
                    </label>
                  ))}
                </div>
              ) : (
                <p className="small muted">{search.error ? "Search is unavailable right now." : "No matching records you can access."}</p>
              )
            )}
          </>
        )}
      </div>
    </Modal>
  );
}

