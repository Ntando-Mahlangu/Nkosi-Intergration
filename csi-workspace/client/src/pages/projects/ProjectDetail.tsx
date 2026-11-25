import { useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { api } from "../../lib/api";
import { useApi } from "../../lib/hooks";
import { useAuth, useLookups, useToast } from "../../lib/app-state";
import { fmtDate, fmtDateTime, humanize, money, relTime } from "../../lib/format";
import {
  Badge, Button, Callout, Card, ConfirmDialog, EmptyState, ErrorState, KeyValue, LinkButton, Loading, Modal, PageHeader, PersonChip, ProgressBar, RichText, SelectInput, StatusBadge, Tabs,
} from "../../components/ui";
import { ActivityList, DocumentLinks, RelatedRecords, UserSelect, type ActivityRow } from "../../components/records";
import { Icon } from "../../components/Icon";
import { TaskList, type TaskRow } from "../tasks/TaskList";
import { TaskFormModal } from "../tasks/TaskFormModal";
import type { HistoryRow, ProjectDetail as Detail } from "./types";
import { PROGRESS_METHODS, ROLE_LABEL, VISIBILITY_OPTIONS } from "./types";
import { DeliverablesTab, DependenciesPanel, MilestonesTab, RisksTab } from "./DeliveryTabs";
import { DecisionLog, UpdatesTab } from "./RecordTabs";
import { riskTone } from "./Portfolio";

type TabKey = "overview" | "tasks" | "milestones" | "deliverables" | "risks" | "decisions" | "updates" | "meetings" | "reports" | "documents" | "activity" | "related";

export default function ProjectDetail() {
  const { id } = useParams();
  const [params, setParams] = useSearchParams();
  const tab = (params.get("tab") as TabKey) || "overview";
  const setTab = (t: TabKey) => setParams(t === "overview" ? {} : { tab: t }, { replace: true });
  const { data: p, error, loading, reload } = useApi<Detail>(`/projects/${id}`);

  if (error) return <ErrorState error={error} onRetry={reload} />;
  if (loading && !p) return <Loading />;
  if (!p) return null;

  const tabs: { key: TabKey; label: string; count?: number }[] = [
    { key: "overview", label: "Overview" },
    { key: "tasks", label: "Tasks", count: p.open_actions },
    { key: "milestones", label: "Milestones", count: p.counts.milestones },
    { key: "deliverables", label: "Deliverables", count: p.counts.deliverables },
    { key: "risks", label: "Risks & issues", count: p.counts.risks },
    { key: "decisions", label: "Decisions", count: p.counts.decisions },
    { key: "updates", label: "Updates", count: p.counts.updates },
    { key: "meetings", label: "Meetings" },
    { key: "reports", label: "Reports" },
    { key: "documents", label: "Documents" },
    { key: "activity", label: "Activity" },
    { key: "related", label: "Related" },
  ];

  return (
    <>
      <PageHeader
        breadcrumbs={[{ label: "Projects", to: "/projects" }, ...(p.programme_id && p.programme_name ? [{ label: p.programme_name, to: `/projects/programmes/${p.programme_id}` }] : []), { label: p.name }]}
        title={
          <span className="row" style={{ gap: 10 }}>
            {p.name}
            {p.code && <span className="tag">{p.code}</span>}
            {p.visibility === "restricted" && <Badge tone="neutral" icon="lock">Restricted</Badge>}
          </span>
        }
        subtitle={
          <span className="row">
            <StatusBadge kind="project" value={p.status} />
            <StatusBadge kind="health" value={p.health} />
            {p.priority !== "normal" && <StatusBadge kind="priority" value={p.priority} />}
            <span className="muted small">Owner: {p.owner_name ?? "—"}{p.my_role ? ` · You: ${ROLE_LABEL[p.my_role] ?? p.my_role}` : ""}</span>
          </span>
        }
        actions={
          <>
            {p.drive_folder_url && <a className="btn" href={p.drive_folder_url} target="_blank" rel="noopener noreferrer"><Icon name="folder" size={16} /> Project folder</a>}
            {p.permissions.can_contribute && <Button icon="message" onClick={() => setTab("updates")}>Post update</Button>}
            {p.permissions.can_manage && <LinkButton to={`/projects/${p.id}/edit`} icon="edit">Edit</LinkButton>}
          </>
        }
      />
      <Tabs tabs={tabs} value={tab} onChange={setTab} />
      {tab === "overview" && <Overview p={p} reload={reload} goTab={setTab} />}
      {tab === "tasks" && <ProjectTasks p={p} onChanged={reload} />}
      {tab === "milestones" && <MilestonesTab project={p} onChanged={reload} />}
      {tab === "deliverables" && <DeliverablesTab project={p} onChanged={reload} />}
      {tab === "risks" && <RisksTab project={p} onChanged={reload} />}
      {tab === "decisions" && <DecisionLog projectId={p.id} canAdd={p.permissions.can_contribute} onChanged={reload} />}
      {tab === "updates" && <UpdatesTab project={p} onChanged={reload} />}
      {tab === "meetings" && <ProjectMeetings p={p} />}
      {tab === "reports" && <ProjectReports p={p} />}
      {tab === "documents" && <DocumentLinks entityType="project" entityId={p.id} canEdit={p.permissions.can_contribute} />}
      {tab === "activity" && <ProjectActivity id={p.id} />}
      {tab === "related" && <Related p={p} />}
    </>
  );
}

// ===================================================================== overview
function Overview({ p, reload, goTab }: { p: Detail; reload: () => void; goTab: (t: TabKey) => void }) {
  const [howOpen, setHowOpen] = useState(false);
  const objectives = p.objectives.split("\n").map((o) => o.trim()).filter(Boolean);
  const method = PROGRESS_METHODS.find((m) => m.value === p.progress.method);
  const sugg = p.health_suggestion;
  const differs = sugg.suggested !== p.health && p.health !== "completed";
  return (
    <div className="cols-main-side">
      <div className="stack">
        <div className="grid grid-4">
          <div className="card stat-card">
            <span className="stat-label"><Icon name="trending" size={16} /> Progress</span>
            <span className="stat-value">{p.progress.value === null ? "—" : `${p.progress.value}%`}</span>
            <button className="stat-hint prj-link-btn" onClick={() => setHowOpen(true)}>How is this calculated?</button>
          </div>
          <button className="stat-card" onClick={() => goTab("tasks")}>
            <span className="stat-label"><Icon name="tasks" size={16} /> Open actions</span>
            <span className="stat-value">{p.open_actions}</span>
            <span className={`stat-hint ${p.overdue_actions ? "overdue" : ""}`}>{p.overdue_actions} overdue</span>
          </button>
          <button className="stat-card" onClick={() => goTab("deliverables")}>
            <span className="stat-label"><Icon name="package" size={16} /> Deliverables due</span>
            <span className="stat-value">{p.outstanding_deliverables}</span>
            <span className={`stat-hint ${p.overdue_deliverables ? "overdue" : ""}`}>{p.overdue_deliverables} overdue</span>
          </button>
          <button className="stat-card" onClick={() => goTab("risks")}>
            <span className="stat-label"><Icon name="shield" size={16} /> Open risks</span>
            <span className="stat-value">{p.open_risks}</span>
            <span className="stat-hint">{p.risk_level ? `Highest: ${p.risk_level}` : "None open"}</span>
          </button>
        </div>

        <Card title="About this project">
          {p.description ? <RichText text={p.description} /> : <p className="muted">No description yet.</p>}
          {p.purpose && <><h3 className="mt-2 mb-1">Purpose</h3><RichText text={p.purpose} /></>}
          {objectives.length > 0 && (
            <>
              <h3 className="mt-2 mb-1">Objectives</h3>
              <ol className="prj-objectives">{objectives.map((o, i) => <li key={i}>{o}</li>)}</ol>
            </>
          )}
          {p.intended_outcomes && <><h3 className="mt-2 mb-1">Intended outcomes</h3><RichText text={p.intended_outcomes} /></>}
          {(p.scope || p.stakeholders || p.reporting_requirements) && (
            <div className="grid grid-3 mt-2 small">
              {p.scope && <div><strong>Scope</strong><RichText text={p.scope} /></div>}
              {p.stakeholders && <div><strong>Stakeholders</strong><RichText text={p.stakeholders} /></div>}
              {p.reporting_requirements && <div><strong>Reporting</strong><RichText text={p.reporting_requirements} /></div>}
            </div>
          )}
        </Card>

        <Card title="Timeline" actions={<Button size="sm" variant="ghost" onClick={() => goTab("milestones")}>All milestones</Button>}>
          {p.milestones.length ? <MilestoneTimeline p={p} /> : <EmptyState icon="milestone" title="No milestones yet" />}
        </Card>

        {p.last_update && (
          <Card title="Latest update" actions={<Button size="sm" variant="ghost" onClick={() => goTab("updates")}>All updates</Button>}>
            <div className="tiny muted mb-1">{p.last_update.author_name} · {relTime(p.last_update.created_at)}</div>
            <RichText text={p.last_update.summary} />
            {p.last_update.next_steps && <div className="small"><strong>Next steps:</strong> {p.last_update.next_steps}</div>}
          </Card>
        )}
      </div>

      <div className="stack">
        <Card title="Health">
          <div className="row mb-1"><StatusBadge kind="health" value={p.health} /><span className="muted tiny">set by the project owner</span></div>
          {p.health_note && <p className="small">{p.health_note}</p>}
          <div className={`callout ${differs ? "tone-warn" : ""} mt-1`}>
            <div className="small"><strong>Suggested from project data:</strong> {humanize(sugg.suggested)}</div>
            <ul className="small prj-factors">
              {sugg.factors.map((f, i) => <li key={i} className={`lvl-${f.level}`}>{f.text}</li>)}
            </ul>
            <div className="tiny muted">Rules: overdue milestones, open blockers/high risks, overdue deliverables or tasks, and stale updates. This is a suggestion, not a judgement.</div>
          </div>
          <HealthHistory id={p.id} />
        </Card>

        <Card title="Details">
          <KeyValue
            items={[
              ["Owner", <PersonChip name={p.owner_name} />],
              ["Team", p.team_name],
              ["Programme", p.programme_id ? <Link to={`/projects/programmes/${p.programme_id}`}>{p.programme_name}</Link> : null],
              ["Category", p.category || null],
              ["Start", fmtDate(p.start_date)],
              ["Target", fmtDate(p.target_date)],
              ...(p.completed_date ? [["Completed", fmtDate(p.completed_date)] as [string, string]] : []),
              ["Visibility", VISIBILITY_OPTIONS.find((v) => v.value === p.visibility)?.label ?? p.visibility],
              ["Progress method", method?.label ?? p.progress_method],
            ]}
          />
          {p.budget_visible && (
            <div className="mt-2">
              <h3 className="mb-1">Budget</h3>
              <div className="strong">{p.budget_amount != null ? money(p.budget_amount, p.budget_currency) : <span className="muted">Not set</span>}</div>
              {p.budget_notes && <div className="small muted">{p.budget_notes}</div>}
              <div className="tiny muted">Visible to project managers and management only.</div>
            </div>
          )}
        </Card>

        <Members p={p} reload={reload} />
      </div>

      <Modal open={howOpen} onClose={() => setHowOpen(false)} title="How progress is calculated">
        <p><strong>{method?.label ?? p.progress.method}.</strong> {method?.explain}</p>
        <Callout tone="accent" icon="info">{p.progress.explanation}</Callout>
        <ProgressBar value={p.progress.value} label="Current" />
        <p className="small muted mt-2">The project owner can change the method on the Edit page. Task counts treat every task equally, so milestones or deliverables usually give a fairer picture.</p>
      </Modal>
    </div>
  );
}

function MilestoneTimeline({ p }: { p: Detail }) {
  return (
    <ol className="prj-timeline">
      {p.milestones.map((m) => {
        const overdue = ["not_started", "in_progress"].includes(m.status) && m.target_date && m.target_date < new Date().toISOString().slice(0, 10);
        return (
          <li key={m.id} className={`prj-tl-item ${m.status}`}>
            <span className="prj-tl-marker" aria-hidden><Icon name={m.status === "achieved" ? "check" : "milestone"} size={12} /></span>
            <div>
              <div className="small strong">{m.title}</div>
              <div className="tiny muted">
                {fmtDate(m.target_date)} · <StatusBadge kind="milestone" value={m.status} /> {overdue && <span className="overdue">overdue</span>}
              </div>
            </div>
          </li>
        );
      })}
    </ol>
  );
}

function HealthHistory({ id }: { id: string }) {
  const [open, setOpen] = useState(false);
  const { data } = useApi<HistoryRow[]>(open ? `/projects/${id}/history` : null);
  return (
    <div className="mt-2">
      <Button size="sm" variant="ghost" icon={open ? "chevronDown" : "chevronRight"} onClick={() => setOpen((o) => !o)}>Status & health history</Button>
      {open && (
        data?.length ? (
          <ul className="timeline mt-1">
            {data.map((h) => (
              <li key={h.id}>
                <span className="tl-dot"><Icon name="refresh" /></span>
                <div className="small">
                  <strong>{humanize(h.field)}</strong>: {h.from_value ? humanize(h.from_value) : "—"} → {humanize(h.to_value)}
                  {h.note && <div className="muted">{h.note}</div>}
                  <div className="tiny muted">{h.changed_by_name ?? "System"} · {fmtDateTime(h.changed_at)}</div>
                </div>
              </li>
            ))}
          </ul>
        ) : <p className="small muted">No changes recorded.</p>
      )}
    </div>
  );
}

function Members({ p, reload }: { p: Detail; reload: () => void }) {
  const toast = useToast();
  const { me } = useAuth();
  const { reload: reloadLookups } = useLookups();
  const nav = useNavigate();
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState({ user_id: "", role: "member" });
  const [removing, setRemoving] = useState<{ user_id: string; name: string } | null>(null);
  const manage = p.permissions.can_manage;
  const run = async (fn: () => Promise<unknown>, msg: string) => {
    try { await fn(); toast.success(msg); reload(); reloadLookups(); return true; } catch (e) { toast.error((e as Error).message); return false; }
  };
  return (
    <Card title={`Team (${p.members.length})`} actions={manage ? <Button size="sm" icon="plus" onClick={() => setAdding(true)}>Add</Button> : undefined}>
      <ul className="stack-sm" style={{ listStyle: "none", padding: 0, margin: 0 }}>
        {p.members.map((m) => (
          <li key={m.user_id} className="row prj-member">
            <PersonChip name={m.name} />
            <span className="spacer" />
            {manage && m.role !== "owner" ? (
              <select className="select prj-role-select" aria-label={`Role for ${m.name}`} value={m.role} onChange={(e) => run(() => api.patch(`/projects/${p.id}/members/${m.user_id}`, { role: e.target.value }), "Role updated")}>
                <option value="manager">Manager</option>
                <option value="member">Member</option>
                <option value="viewer">Viewer</option>
              </select>
            ) : (
              <Badge tone={m.role === "owner" ? "accent" : "neutral"}>{ROLE_LABEL[m.role] ?? m.role}</Badge>
            )}
            {m.role !== "owner" && (manage || m.user_id === me?.user.id) && (
              <Button size="sm" variant="ghost" aria-label={m.user_id === me?.user.id ? "Leave project" : `Remove ${m.name}`} onClick={() => setRemoving({ user_id: m.user_id, name: m.name })}>
                <Icon name="x" size={14} />
              </Button>
            )}
          </li>
        ))}
      </ul>
      <Modal open={adding} onClose={() => setAdding(false)} title="Add team member" footer={<><Button onClick={() => setAdding(false)}>Cancel</Button><Button variant="primary" disabled={!form.user_id} onClick={async () => { if (await run(() => api.post(`/projects/${p.id}/members`, form), "Member added")) { setAdding(false); setForm({ user_id: "", role: "member" }); } }}>Add</Button></>}>
        <UserSelect label="Person" required value={form.user_id} onChange={(x) => setForm({ ...form, user_id: x })} filter={(u) => !p.members.some((m) => m.user_id === u.id)} />
        <SelectInput label="Role" value={form.role} onChange={(x) => setForm({ ...form, role: x })} options={[{ value: "manager", label: "Manager — can edit the project and assign work" }, { value: "member", label: "Member — contributes, posts updates and risks" }, { value: "viewer", label: "Viewer — read only" }]} />
      </Modal>
      <ConfirmDialog
        open={!!removing}
        title={removing?.user_id === me?.user.id ? "Leave project?" : "Remove member?"}
        message={removing?.user_id === me?.user.id ? "You may lose access if the project is not visible to the organisation." : <>Remove <strong>{removing?.name}</strong> from this project? Their tasks stay assigned to them.</>}
        danger
        confirmLabel={removing?.user_id === me?.user.id ? "Leave" : "Remove"}
        onClose={() => setRemoving(null)}
        onConfirm={async () => {
          const self = removing!.user_id === me?.user.id;
          if (await run(() => api.del(`/projects/${p.id}/members/${removing!.user_id}`), self ? "You left the project" : "Member removed")) {
            setRemoving(null);
            if (self && p.visibility !== "organisation") nav("/projects");
          }
        }}
      />
    </Card>
  );
}

// ===================================================================== tasks
function ProjectTasks({ p, onChanged }: { p: Detail; onChanged: () => void }) {
  const [show, setShow] = useState<"open" | "all">("open");
  const { data, error, loading, reload } = useApi<{ items: TaskRow[]; total: number }>("/tasks", { project_id: p.id, scope: "visible", limit: 500 });
  const [creating, setCreating] = useState(false);
  const items = (data?.items ?? []).filter((t) => show === "all" || !["completed", "cancelled"].includes(t.status));
  return (
    <div className="stack">
      <div className="row-between">
        <div className="segmented" role="group" aria-label="Filter tasks">
          <button className={show === "open" ? "active" : ""} aria-pressed={show === "open"} onClick={() => setShow("open")}>Open</button>
          <button className={show === "all" ? "active" : ""} aria-pressed={show === "all"} onClick={() => setShow("all")}>All</button>
        </div>
        {p.permissions.can_contribute && <Button variant="primary" icon="plus" onClick={() => setCreating(true)}>Add task</Button>}
      </div>
      {error ? <ErrorState error={error} onRetry={reload} /> : loading && !data ? <Loading /> : (
        <div className="card">
          <TaskList tasks={items} showProject={false} showAssignee onChanged={() => { reload(); onChanged(); }} emptyTitle={show === "open" ? "No open tasks" : "No tasks yet"} emptyText="Tasks from meetings, deliverables and the project team appear here." />
        </div>
      )}
      <TaskFormModal open={creating} onClose={() => setCreating(false)} defaults={{ project_id: p.id, source: "project" }} onSaved={() => { setCreating(false); reload(); onChanged(); }} />
    </div>
  );
}

// ===================================================================== meetings & reports
interface MeetingItem { id: string; title: string; meeting_date: string; start_time: string | null; status: string; organiser_name: string | null; open_actions?: number; pending_suggestions?: number }
function ProjectMeetings({ p }: { p: Detail }) {
  const { data, error, loading, reload } = useApi<{ items: MeetingItem[] }>("/meetings", { project_id: p.id, limit: 300 });
  const today = new Date().toISOString().slice(0, 10);
  const items = data?.items ?? [];
  const upcoming = items.filter((m) => m.meeting_date >= today).sort((a, b) => a.meeting_date.localeCompare(b.meeting_date));
  const past = items.filter((m) => m.meeting_date < today).sort((a, b) => b.meeting_date.localeCompare(a.meeting_date));
  const row = (m: MeetingItem) => (
    <Link key={m.id} to={`/meetings/${m.id}`} className="list-item prj-meeting-row">
      <Icon name="calendar" />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div className="title">{m.title}</div>
        <div className="meta">
          <span>{fmtDate(m.meeting_date)}{m.start_time ? ` ${m.start_time}` : ""}</span>
          {m.organiser_name && <span>Organiser: {m.organiser_name}</span>}
          {!!m.open_actions && <span>{m.open_actions} open actions</span>}
          {!!m.pending_suggestions && <Badge tone="ai" icon="sparkles">{m.pending_suggestions} to review</Badge>}
        </div>
      </div>
      <StatusBadge kind="meeting" value={m.status} />
    </Link>
  );
  return (
    <div className="stack">
      <div className="row-between">
        <p className="muted small mb-1">Meetings linked to this project, newest first. Approved meeting outcomes update tasks, decisions and risks here.</p>
        <LinkButton to={`/meetings/new?project_id=${p.id}`} variant="primary" icon="plus">New meeting record</LinkButton>
      </div>
      {error ? <ErrorState error={error} onRetry={reload} /> : loading && !data ? <Loading /> : !items.length ? (
        <Card><EmptyState icon="meeting" title="No meetings linked yet" /></Card>
      ) : (
        <>
          {upcoming.length > 0 && <><h3>Upcoming</h3><div className="card list">{upcoming.map(row)}</div></>}
          {past.length > 0 && <><h3>Past meetings</h3><div className="card list">{past.map(row)}</div></>}
        </>
      )}
    </div>
  );
}

interface ReportItem { id: string; title: string; report_type: string; status: string; updated_at: string; author_name: string | null; meeting_title: string | null }
function ProjectReports({ p }: { p: Detail }) {
  const toast = useToast();
  const nav = useNavigate();
  const { data, error, loading, reload } = useApi<{ items: ReportItem[] }>("/reports", { project_id: p.id });
  const [busy, setBusy] = useState(false);
  const generate = async () => {
    setBusy(true);
    try {
      const r = await api.post<{ id: string }>(`/projects/${p.id}/report`);
      toast.success("Draft project report generated from current records");
      nav(`/reports/${r.id}`);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="stack">
      <div className="row-between">
        <p className="muted small mb-1">Call reports from project meetings and generated project status reports. Reports stay drafts until reviewed.</p>
        {p.permissions.can_contribute && <Button variant="primary" icon="report" onClick={generate} loading={busy}>Generate project report</Button>}
      </div>
      {error ? <ErrorState error={error} onRetry={reload} /> : loading && !data ? <Loading /> : !data?.items.length ? (
        <Card><EmptyState icon="report" title="No reports yet">Generate a status report assembled from milestones, deliverables, risks and decisions.</EmptyState></Card>
      ) : (
        <div className="card list">
          {data.items.map((r) => (
            <Link key={r.id} to={`/reports/${r.id}`} className="list-item prj-meeting-row">
              <Icon name="report" />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div className="title">{r.title}</div>
                <div className="meta">
                  <span>{humanize(r.report_type)}</span>
                  {r.author_name && <span>{r.author_name}</span>}
                  <span>Updated {relTime(r.updated_at)}</span>
                </div>
              </div>
              <StatusBadge kind="report" value={r.status} />
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}

// ===================================================================== activity & related
function ProjectActivity({ id }: { id: string }) {
  const { data, error, loading, reload } = useApi<ActivityRow[]>(`/projects/${id}/activity`, { limit: 100 });
  if (error) return <ErrorState error={error} onRetry={reload} />;
  if (loading && !data) return <Loading />;
  return <Card><ActivityList rows={data} empty="No activity recorded for this project yet." /></Card>;
}

function Related({ p }: { p: Detail }) {
  const { opportunities, knowledge, learning } = p.related;
  const lessons = knowledge.filter((k) => k.item_type === "lesson");
  const other = knowledge.filter((k) => k.item_type !== "lesson");
  return (
    <div className="grid grid-2">
      <Card title="Opportunities">
        {opportunities.length ? (
          <ul className="stack-sm prj-plain">
            {opportunities.map((o) => (
              <li key={o.id} className="row small"><Icon name="target" size={14} /><Link to={`/opportunities/${o.id}`}>{o.name}</Link><StatusBadge kind="opportunity" value={o.stage} /></li>
            ))}
          </ul>
        ) : <p className="muted small">No opportunities linked to this project.</p>}
      </Card>
      <Card title="Lessons learned">
        {lessons.length || learning.length ? (
          <ul className="stack-sm prj-plain">
            {lessons.map((k) => <li key={k.id} className="small"><Icon name="lightbulb" size={14} /> <Link to={`/knowledge/${k.id}`}>{k.title}</Link><div className="muted tiny">{k.summary}</div></li>)}
            {learning.map((l) => <li key={l.id} className="small"><Icon name="lightbulb" size={14} /> <Link to={`/learning/records/${l.id}`}>{l.title}</Link> <span className="tiny muted">{humanize(l.record_type)} · {l.contributor_name}</span></li>)}
          </ul>
        ) : <p className="muted small">No lessons captured yet. Share what the team learned from the Learning module.</p>}
      </Card>
      <Card title="Knowledge">
        {other.length ? (
          <ul className="stack-sm prj-plain">
            {other.map((k) => <li key={k.id} className="small"><Icon name="book" size={14} /> <Link to={`/knowledge/${k.id}`}>{k.title}</Link> <span className="tiny muted">{k.category}{k.status !== "published" ? ` · ${humanize(k.status)}` : ""}</span></li>)}
          </ul>
        ) : <p className="muted small">No knowledge items associated with this project.</p>}
      </Card>
      <Card><RelatedRecords entityType="project" entityId={p.id} /></Card>
      <div className="card card-pad" style={{ gridColumn: "1 / -1" }}><DependenciesPanel project={p} /></div>
    </div>
  );
}

export { riskTone };
