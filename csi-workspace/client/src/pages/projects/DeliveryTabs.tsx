/** Project delivery tabs: milestones, deliverables (submit/review/versions), risks & issues, dependencies. */
import { useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../../lib/api";
import { useApi, useForm } from "../../lib/hooks";
import { useAuth, useToast } from "../../lib/app-state";
import { fmtDate, fmtDateTime, humanize } from "../../lib/format";
import { Badge, Button, Callout, Card, ConfirmDialog, EmptyState, ErrorState, FormError, KeyValue, Loading, Modal, RichText, SelectInput, StatusBadge, TextArea, TextInput } from "../../components/ui";
import { Comments, UserSelect } from "../../components/records";
import { Icon } from "../../components/Icon";
import type { DepEdge, DepItem, Deliverable, DeliverableVersion, Milestone, ProjectDetail, Risk } from "./types";

const OPEN_MS = ["not_started", "in_progress"];

// ===================================================================== milestones
export function MilestonesTab({ project, onChanged }: { project: ProjectDetail; onChanged: () => void }) {
  const { me } = useAuth();
  const toast = useToast();
  const { data, error, loading, reload } = useApi<Milestone[]>(`/projects/${project.id}/milestones`);
  const [editing, setEditing] = useState<Milestone | "new" | null>(null);
  const [del, setDel] = useState<Milestone | null>(null);
  const manage = project.permissions.can_manage;
  const refresh = () => { reload(); onChanged(); };

  const setStatus = async (m: Milestone, status: string) => {
    try {
      await api.patch(`/milestones/${m.id}`, { status });
      toast.success(status === "achieved" ? "Milestone achieved" : "Milestone updated");
      refresh();
    } catch (e) {
      toast.error((e as Error).message);
    }
  };

  if (error) return <ErrorState error={error} onRetry={reload} />;
  if (loading && !data) return <Loading />;
  return (
    <div className="stack">
      <div className="row-between">
        <p className="muted small mb-1">Milestones mark meaningful points of progress. {project.progress_method === "milestones" && "This project's progress is calculated from milestones."}</p>
        {manage && <Button icon="plus" variant="primary" onClick={() => setEditing("new")}>Add milestone</Button>}
      </div>
      {!data?.length ? (
        <Card><EmptyState icon="milestone" title="No milestones yet">{manage ? "Add the key points this project needs to reach." : "The project owner has not added milestones."}</EmptyState></Card>
      ) : (
        <div className="card list">
          {data.map((m) => {
            const canUpdate = manage || m.owner_id === me?.user.id;
            return (
              <div className="list-item" key={m.id}>
                <span className={`prj-ms-dot ${m.status}`} aria-hidden><Icon name={m.status === "achieved" ? "check" : "milestone"} size={14} /></span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div className="row">
                    <span className="title">{m.title}</span>
                    <StatusBadge kind="milestone" value={m.status} />
                    {m.overdue && <Badge tone="danger" icon="alert">Overdue</Badge>}
                  </div>
                  <div className="meta">
                    <span>Target {fmtDate(m.target_date)}</span>
                    {m.completed_date && <span>Achieved {fmtDate(m.completed_date)}</span>}
                    <span>Owner: {m.owner_name ?? "—"}</span>
                    {!!m.deliverable_count && <span>{m.deliverables_done}/{m.deliverable_count} deliverables done</span>}
                    {project.progress_method === "weighted" && <span>Weight {m.weight}</span>}
                    {m.evidence_url && <a href={m.evidence_url} target="_blank" rel="noopener noreferrer">Evidence <Icon name="external" size={11} /></a>}
                  </div>
                  {m.description && <div className="small mt-1">{m.description}</div>}
                  {m.notes && <div className="small muted">{m.notes}</div>}
                </div>
                {canUpdate && (
                  <div className="row">
                    {OPEN_MS.includes(m.status) && <Button size="sm" icon="check" onClick={() => setStatus(m, "achieved")}>Mark achieved</Button>}
                    {m.status === "not_started" && <Button size="sm" variant="ghost" onClick={() => setStatus(m, "in_progress")}>Start</Button>}
                    {!OPEN_MS.includes(m.status) && <Button size="sm" variant="ghost" onClick={() => setStatus(m, "in_progress")}>Reopen</Button>}
                    <Button size="sm" variant="ghost" aria-label={`Edit ${m.title}`} onClick={() => setEditing(m)}><Icon name="edit" size={14} /></Button>
                    {manage && <Button size="sm" variant="ghost" aria-label={`Delete ${m.title}`} onClick={() => setDel(m)}><Icon name="trash" size={14} /></Button>}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
      {editing && <MilestoneModal project={project} milestone={editing === "new" ? null : editing} ownerOnly={!manage} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); refresh(); }} />}
      <ConfirmDialog
        open={!!del}
        title="Delete milestone?"
        message={<>This permanently removes <strong>{del?.title}</strong> and its dependencies. Consider marking it cancelled instead to keep history.</>}
        danger
        confirmLabel="Delete"
        onClose={() => setDel(null)}
        onConfirm={async () => {
          try { await api.del(`/milestones/${del!.id}`); toast.success("Milestone deleted"); setDel(null); refresh(); } catch (e) { toast.error((e as Error).message); }
        }}
      />
    </div>
  );
}

function MilestoneModal({ project, milestone, ownerOnly, onClose, onSaved }: { project: ProjectDetail; milestone: Milestone | null; ownerOnly: boolean; onClose: () => void; onSaved: () => void }) {
  const toast = useToast();
  const f = useForm({
    title: milestone?.title ?? "", description: milestone?.description ?? "", owner_id: milestone?.owner_id ?? project.owner_id ?? "", target_date: milestone?.target_date ?? "",
    status: milestone?.status ?? "not_started", weight: String(milestone?.weight ?? 1), notes: milestone?.notes ?? "", evidence_url: milestone?.evidence_url ?? "",
  });
  const v = f.values;
  const save = () =>
    f.submit(
      async (x) => {
        const body = ownerOnly
          ? { status: x.status, notes: x.notes, evidence_url: x.evidence_url }
          : { title: x.title, description: x.description, owner_id: x.owner_id || null, target_date: x.target_date || null, status: x.status, weight: Number(x.weight) || 1, notes: x.notes, evidence_url: x.evidence_url };
        if (milestone) await api.patch(`/milestones/${milestone.id}`, body);
        else await api.post(`/projects/${project.id}/milestones`, body);
        toast.success("Milestone saved");
        onSaved();
      },
      (x) => {
        const e: Record<string, string> = {};
        if (!ownerOnly && !x.title.trim()) e.title = "Give the milestone a title.";
        if (x.evidence_url && !/^https?:\/\//.test(x.evidence_url)) e.evidence_url = "Use a full https:// link.";
        if (!ownerOnly && (!Number.isInteger(Number(x.weight)) || Number(x.weight) < 1)) e.weight = "Whole number ≥ 1.";
        return e;
      },
    );
  return (
    <Modal open onClose={onClose} title={milestone ? "Edit milestone" : "Add milestone"} footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" onClick={save} loading={f.submitting}>Save</Button></>}>
      <FormError message={f.formError} />
      {ownerOnly && <Callout tone="accent" icon="info">As milestone owner you can update its status, notes and evidence.</Callout>}
      {!ownerOnly && (
        <>
          <TextInput label="Title" required value={v.title} onChange={(x) => f.set("title", x)} error={f.errors.title} />
          <TextArea label="Description" rows={2} value={v.description} onChange={(x) => f.set("description", x)} />
          <div className="form-grid">
            <UserSelect label="Owner" value={v.owner_id} onChange={(x) => f.set("owner_id", x)} />
            <TextInput label="Target date" type="date" value={v.target_date} onChange={(x) => f.set("target_date", x)} />
            {project.progress_method === "weighted" && <TextInput label="Weight" type="number" min={1} value={v.weight} onChange={(x) => f.set("weight", x)} error={f.errors.weight} hint="Relative importance for weighted progress." />}
          </div>
        </>
      )}
      <SelectInput label="Status" value={v.status} onChange={(x) => f.set("status", x)} options={["not_started", "in_progress", "achieved", "missed", "cancelled"].map((s) => ({ value: s, label: humanize(s) }))} />
      <TextArea label="Notes" rows={2} value={v.notes} onChange={(x) => f.set("notes", x)} />
      <TextInput label="Evidence / supporting document link" type="url" value={v.evidence_url} onChange={(x) => f.set("evidence_url", x)} error={f.errors.evidence_url} />
    </Modal>
  );
}

// ===================================================================== deliverables
export function DeliverablesTab({ project, onChanged }: { project: ProjectDetail; onChanged: () => void }) {
  const { data, error, loading, reload } = useApi<Deliverable[]>(`/projects/${project.id}/deliverables`);
  const [editing, setEditing] = useState<Deliverable | "new" | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const manage = project.permissions.can_manage;
  const refresh = () => { reload(); onChanged(); };
  if (error) return <ErrorState error={error} onRetry={reload} />;
  if (loading && !data) return <Loading />;
  return (
    <div className="stack">
      <div className="row-between">
        <p className="muted small mb-1">Deliverables are submitted by their owner and approved by a reviewer. Every submission is versioned.</p>
        {manage && <Button icon="plus" variant="primary" onClick={() => setEditing("new")}>Add deliverable</Button>}
      </div>
      {!data?.length ? (
        <Card><EmptyState icon="package" title="No deliverables yet">{manage ? "Add the outputs this project must produce." : "None recorded."}</EmptyState></Card>
      ) : (
        <div className="card table-wrap">
          <table className="table table-stack">
            <thead><tr><th>Deliverable</th><th>Owner</th><th>Reviewer</th><th>Due</th><th>Status</th><th>Version</th><th><span className="sr-only">Actions</span></th></tr></thead>
            <tbody>
              {data.map((d) => (
                <tr key={d.id}>
                  <td data-label="Deliverable">
                    <button className="btn-link strong prj-link-btn" onClick={() => setOpen(d.id)}>{d.name}</button>
                    {d.milestone_title && <div className="tiny muted"><Icon name="milestone" size={11} /> {d.milestone_title}</div>}
                    {!!d.task_count && <div className="tiny muted">{d.tasks_done}/{d.task_count} related tasks done</div>}
                  </td>
                  <td data-label="Owner">{d.owner_name ?? "—"}</td>
                  <td data-label="Reviewer">{d.reviewer_name ?? <span className="muted">Project owner</span>}</td>
                  <td data-label="Due" className={d.overdue ? "overdue nowrap" : "nowrap"}>{fmtDate(d.due_date)}{d.overdue && " (overdue)"}</td>
                  <td data-label="Status"><StatusBadge kind="deliverable" value={d.status} /></td>
                  <td data-label="Version">v{d.version}</td>
                  <td><Button size="sm" onClick={() => setOpen(d.id)}>Open</Button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {editing && <DeliverableModal project={project} deliverable={editing === "new" ? null : editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); refresh(); }} />}
      {open && <DeliverableDrawer id={open} onClose={() => setOpen(null)} onEdit={(d) => { setOpen(null); setEditing(d); }} onChanged={refresh} />}
    </div>
  );
}

function DeliverableModal({ project, deliverable, onClose, onSaved }: { project: ProjectDetail; deliverable: Deliverable | null; onClose: () => void; onSaved: () => void }) {
  const toast = useToast();
  const d = deliverable;
  const f = useForm({
    name: d?.name ?? "", description: d?.description ?? "", milestone_id: d?.milestone_id ?? "", owner_id: d?.owner_id ?? "", reviewer_id: d?.reviewer_id ?? "",
    due_date: d?.due_date ?? "", status: d?.status ?? "not_started", acceptance_criteria: d?.acceptance_criteria ?? "", weight: String(d?.weight ?? 1),
  });
  const v = f.values;
  const save = () =>
    f.submit(
      async (x) => {
        const body = { ...x, milestone_id: x.milestone_id || null, owner_id: x.owner_id || null, reviewer_id: x.reviewer_id || null, due_date: x.due_date || null, weight: Number(x.weight) || 1 };
        if (d) await api.patch(`/deliverables/${d.id}`, body);
        else await api.post(`/projects/${project.id}/deliverables`, body);
        toast.success("Deliverable saved");
        onSaved();
      },
      (x) => (x.name.trim() ? {} : { name: "Give the deliverable a name." }),
    );
  return (
    <Modal open wide onClose={onClose} title={d ? "Edit deliverable" : "Add deliverable"} footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" onClick={save} loading={f.submitting}>Save</Button></>}>
      <FormError message={f.formError} />
      <TextInput label="Name" required value={v.name} onChange={(x) => f.set("name", x)} error={f.errors.name} />
      <TextArea label="Description" rows={2} value={v.description} onChange={(x) => f.set("description", x)} />
      <div className="form-grid">
        <UserSelect label="Responsible person" value={v.owner_id} onChange={(x) => f.set("owner_id", x)} />
        <UserSelect label="Reviewer" value={v.reviewer_id} onChange={(x) => f.set("reviewer_id", x)} placeholder="Project owner reviews" />
        <TextInput label="Due date" type="date" value={v.due_date} onChange={(x) => f.set("due_date", x)} />
        <SelectInput label="Related milestone" value={v.milestone_id} onChange={(x) => f.set("milestone_id", x)} options={project.milestones.map((m) => ({ value: m.id, label: m.title }))} placeholder="None" error={f.errors.milestone_id} />
        <SelectInput label="Status" value={v.status} onChange={(x) => f.set("status", x)} options={["not_started", "in_progress", "submitted", "under_review", "changes_requested", "approved", "completed", "cancelled"].map((s) => ({ value: s, label: humanize(s) }))} />
        {project.progress_method === "weighted" && <TextInput label="Weight" type="number" min={1} value={v.weight} onChange={(x) => f.set("weight", x)} />}
      </div>
      <TextArea label="Acceptance criteria" rows={3} value={v.acceptance_criteria} onChange={(x) => f.set("acceptance_criteria", x)} hint="What must be true for this deliverable to be approved?" />
    </Modal>
  );
}

interface DeliverableFull extends Deliverable {
  tasks: { id: string; ref: number; title: string; status: string; due_date: string | null; assignee_name: string | null }[];
  versions: DeliverableVersion[];
  can_manage: boolean;
  can_review: boolean;
  can_submit: boolean;
}

function DeliverableDrawer({ id, onClose, onEdit, onChanged }: { id: string; onClose: () => void; onEdit: (d: Deliverable) => void; onChanged: () => void }) {
  const toast = useToast();
  const { data, error, loading, reload } = useApi<DeliverableFull>(`/deliverables/${id}`);
  const [mode, setMode] = useState<"" | "submit" | "review">("");
  const [form, setForm] = useState({ submission_url: "", note: "", decision: "approve" });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<Record<string, string>>({});
  const act = async (fn: () => Promise<unknown>, msg: string) => {
    setBusy(true);
    setErr({});
    try {
      await fn();
      toast.success(msg);
      setMode("");
      setForm({ submission_url: "", note: "", decision: "approve" });
      reload();
      onChanged();
    } catch (e) {
      const x = e as { message: string; fields?: Record<string, string> };
      setErr(x.fields ?? {});
      toast.error(x.message);
    } finally {
      setBusy(false);
    }
  };
  const d = data;
  const canSubmit = d && d.can_submit && ["not_started", "in_progress", "changes_requested"].includes(d.status);
  const canReview = d && d.can_review && ["submitted", "under_review"].includes(d.status);
  const canWork = d && d.can_submit && d.status === "not_started";
  return (
    <Modal open wide onClose={onClose} title={d?.name ?? "Deliverable"}>
      {error ? <ErrorState error={error} /> : loading && !d ? <Loading /> : d && (
        <div className="stack">
          <div className="row">
            <StatusBadge kind="deliverable" value={d.status} />
            <span className="muted small">Version {d.version}</span>
            <span className="spacer" />
            {canWork && <Button size="sm" onClick={() => act(() => api.patch(`/deliverables/${d.id}`, { status: "in_progress" }), "Marked in progress")}>Start work</Button>}
            {canSubmit && <Button size="sm" variant="primary" icon="send" onClick={() => setMode("submit")}>Submit for review</Button>}
            {canReview && d.status === "submitted" && <Button size="sm" onClick={() => act(() => api.post(`/deliverables/${d.id}/review`, { decision: "start_review" }), "Review started")}>Start review</Button>}
            {canReview && <Button size="sm" variant="primary" icon="checkCircle" onClick={() => setMode("review")}>Review</Button>}
            {d.can_manage && <Button size="sm" variant="ghost" icon="edit" onClick={() => onEdit(d)}>Edit</Button>}
          </div>
          {d.review_note && d.status === "changes_requested" && <Callout tone="danger" icon="edit"><strong>Changes requested:</strong> {d.review_note}</Callout>}
          {mode === "submit" && (
            <Card title="Submit for review">
              <TextInput label="Link to the work" type="url" placeholder="https://docs.google.com/…" value={form.submission_url} onChange={(x) => setForm({ ...form, submission_url: x })} error={err.submission_url} />
              <TextArea label="Note to reviewer" rows={2} value={form.note} onChange={(x) => setForm({ ...form, note: x })} />
              <div className="form-actions">
                <Button onClick={() => setMode("")}>Cancel</Button>
                <Button variant="primary" loading={busy} onClick={() => act(() => api.post(`/deliverables/${d.id}/submit`, { submission_url: form.submission_url, note: form.note }), "Submitted for review")}>Submit</Button>
              </div>
            </Card>
          )}
          {mode === "review" && (
            <Card title="Review deliverable">
              {d.acceptance_criteria && <div className="small mb-2"><strong>Acceptance criteria</strong><RichText text={d.acceptance_criteria} /></div>}
              <SelectInput label="Decision" value={form.decision} onChange={(x) => setForm({ ...form, decision: x })} options={[{ value: "approve", label: "Approve" }, { value: "changes", label: "Request changes" }]} />
              <TextArea label={form.decision === "changes" ? "What needs to change?" : "Comment (optional)"} required={form.decision === "changes"} rows={3} value={form.note} onChange={(x) => setForm({ ...form, note: x })} error={err.note} />
              <div className="form-actions">
                <Button onClick={() => setMode("")}>Cancel</Button>
                <Button variant={form.decision === "approve" ? "primary" : "danger"} loading={busy} onClick={() => act(() => api.post(`/deliverables/${d.id}/review`, { decision: form.decision, note: form.note }), form.decision === "approve" ? "Deliverable approved" : "Changes requested")}>
                  {form.decision === "approve" ? "Approve" : "Request changes"}
                </Button>
              </div>
            </Card>
          )}
          <KeyValue
            items={[
              ["Responsible", d.owner_name],
              ["Reviewer", d.reviewer_name ?? "Project owner"],
              ["Due", <span className={d.overdue ? "overdue" : ""}>{fmtDate(d.due_date)}</span>],
              ["Milestone", d.milestone_title],
              ["Latest submission", d.submission_url ? <a href={d.submission_url} target="_blank" rel="noopener noreferrer">Open <Icon name="external" size={11} /></a> : null],
            ]}
          />
          {d.description && <RichText text={d.description} />}
          {d.acceptance_criteria && mode !== "review" && <div><h3 className="mb-1">Acceptance criteria</h3><RichText text={d.acceptance_criteria} className="small" /></div>}
          <div>
            <h3 className="mb-1">Related tasks</h3>
            {d.tasks.length ? (
              <ul className="stack-sm" style={{ listStyle: "none", padding: 0, margin: 0 }}>
                {d.tasks.map((t) => (
                  <li key={t.id} className="row small"><StatusBadge kind="task" value={t.status} /><Link to={`/tasks/${t.id}`}>T-{t.ref} {t.title}</Link><span className="muted">{t.assignee_name ?? ""}</span></li>
                ))}
              </ul>
            ) : <p className="muted small">No tasks linked to this deliverable.</p>}
          </div>
          <div>
            <h3 className="mb-1">Version history</h3>
            {d.versions.length ? (
              <ul className="timeline">
                {d.versions.map((v) => (
                  <li key={v.id}>
                    <span className="tl-dot"><Icon name="send" /></span>
                    <div className="small">
                      <strong>v{v.version}</strong> submitted by {v.submitted_by_name ?? "former user"} · {fmtDateTime(v.submitted_at)}
                      {v.submission_url && <> · <a href={v.submission_url} target="_blank" rel="noopener noreferrer">link</a></>}
                      {v.note && <div className="muted">{v.note}</div>}
                    </div>
                  </li>
                ))}
              </ul>
            ) : <p className="muted small">Not submitted yet.</p>}
          </div>
          <Comments entityType="deliverable" entityId={d.id} title="Discussion & review feedback" />
        </div>
      )}
    </Modal>
  );
}

// ===================================================================== risks & issues
export function RisksTab({ project, onChanged }: { project: ProjectDetail; onChanged: () => void }) {
  const { me } = useAuth();
  const toast = useToast();
  const { data, error, loading, reload } = useApi<Risk[]>(`/projects/${project.id}/risks`);
  const [editing, setEditing] = useState<Risk | "new" | null>(null);
  const [filter, setFilter] = useState<"open" | "all">("open");
  const [del, setDel] = useState<Risk | null>(null);
  const refresh = () => { reload(); onChanged(); };
  if (error) return <ErrorState error={error} onRetry={reload} />;
  if (loading && !data) return <Loading />;
  const rows = (data ?? []).filter((r) => filter === "all" || !["resolved", "closed"].includes(r.status));
  const canEdit = (r: Risk) => project.permissions.can_manage || r.owner_id === me?.user.id || r.created_by === me?.user.id;
  return (
    <div className="stack">
      <div className="row-between">
        <div className="segmented" role="group" aria-label="Filter risks">
          <button className={filter === "open" ? "active" : ""} aria-pressed={filter === "open"} onClick={() => setFilter("open")}>Open</button>
          <button className={filter === "all" ? "active" : ""} aria-pressed={filter === "all"} onClick={() => setFilter("all")}>All ({data?.length ?? 0})</button>
        </div>
        {project.permissions.can_contribute && <Button icon="plus" variant="primary" onClick={() => setEditing("new")}>Add risk or issue</Button>}
      </div>
      {!rows.length ? (
        <Card><EmptyState icon="shield" title={filter === "open" ? "No open risks or issues" : "Risk register is empty"}>Record risks (what might happen), issues (what is happening) and blockers (what stops progress).</EmptyState></Card>
      ) : (
        <div className="stack">
          {rows.map((r) => (
            <div className="card card-pad" key={r.id}>
              <div className="row-between">
                <div className="row">
                  <Badge tone={r.type === "blocker" ? "danger" : r.type === "issue" ? "warn" : "neutral"} icon={r.type === "blocker" ? "ban" : r.type === "issue" ? "alertCircle" : "shield"}>{humanize(r.type)}</Badge>
                  <h3>{r.title}</h3>
                </div>
                <div className="row">
                  <StatusBadge kind="severity" value={r.severity} />
                  <StatusBadge kind="risk" value={r.status} />
                  {canEdit(r) && <Button size="sm" variant="ghost" aria-label={`Edit ${r.title}`} onClick={() => setEditing(r)}><Icon name="edit" size={14} /></Button>}
                  {project.permissions.can_manage && <Button size="sm" variant="ghost" aria-label={`Delete ${r.title}`} onClick={() => setDel(r)}><Icon name="trash" size={14} /></Button>}
                </div>
              </div>
              {r.description && <p className="small mt-1">{r.description}</p>}
              <div className="grid grid-3 small mt-1">
                <div><span className="muted">Owner</span><div>{r.owner_name ?? "—"}</div></div>
                <div><span className="muted">Identified</span><div>{fmtDate(r.identified_date)}</div></div>
                <div><span className="muted">Review by</span><div>{fmtDate(r.review_date)}</div></div>
                {r.likelihood && <div><span className="muted">Likelihood</span><div>{humanize(r.likelihood)}</div></div>}
                {r.impact && <div><span className="muted">Impact</span><div>{r.impact}</div></div>}
              </div>
              {r.mitigation && <div className="small mt-1"><strong>Mitigation:</strong> {r.mitigation}</div>}
              {r.action_plan && <div className="small"><strong>Action plan:</strong> {r.action_plan}</div>}
            </div>
          ))}
        </div>
      )}
      {editing && <RiskModal project={project} risk={editing === "new" ? null : editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); refresh(); }} />}
      <ConfirmDialog open={!!del} title="Delete from register?" danger confirmLabel="Delete" message={<>Delete <strong>{del?.title}</strong>? To keep a record, set its status to Closed instead.</>} onClose={() => setDel(null)}
        onConfirm={async () => { try { await api.del(`/risks/${del!.id}`); toast.success("Deleted"); setDel(null); refresh(); } catch (e) { toast.error((e as Error).message); } }} />
    </div>
  );
}

function RiskModal({ project, risk, onClose, onSaved }: { project: ProjectDetail; risk: Risk | null; onClose: () => void; onSaved: () => void }) {
  const toast = useToast();
  const f = useForm({
    type: risk?.type ?? "risk", title: risk?.title ?? "", description: risk?.description ?? "", severity: risk?.severity ?? "medium", likelihood: risk?.likelihood ?? "",
    impact: risk?.impact ?? "", owner_id: risk?.owner_id ?? "", mitigation: risk?.mitigation ?? "", action_plan: risk?.action_plan ?? "", status: risk?.status ?? "open", review_date: risk?.review_date ?? "",
  });
  const v = f.values;
  const save = () =>
    f.submit(
      async (x) => {
        const body = { ...x, likelihood: x.type === "risk" ? x.likelihood || null : null, owner_id: x.owner_id || null, review_date: x.review_date || null };
        if (risk) await api.patch(`/risks/${risk.id}`, body);
        else await api.post(`/projects/${project.id}/risks`, body);
        toast.success("Saved to risk register");
        onSaved();
      },
      (x) => (x.title.trim() ? {} : { title: "Give it a short title." }),
    );
  return (
    <Modal open wide onClose={onClose} title={risk ? "Edit risk / issue" : "Add risk or issue"} footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" onClick={save} loading={f.submitting}>Save</Button></>}>
      <FormError message={f.formError} />
      <div className="form-grid">
        <SelectInput label="Type" value={v.type} onChange={(x) => f.set("type", x)} options={[{ value: "risk", label: "Risk — might happen" }, { value: "issue", label: "Issue — is happening" }, { value: "blocker", label: "Blocker — stops progress" }]} />
        <SelectInput label="Severity" value={v.severity} onChange={(x) => f.set("severity", x)} options={["low", "medium", "high", "critical"].map((s) => ({ value: s, label: humanize(s) }))} />
        <TextInput label="Title" required className="full" value={v.title} onChange={(x) => f.set("title", x)} error={f.errors.title} />
        <TextArea label="Description" className="full" rows={2} value={v.description} onChange={(x) => f.set("description", x)} />
        {v.type === "risk" && <SelectInput label="Likelihood" value={v.likelihood} onChange={(x) => f.set("likelihood", x)} options={["low", "medium", "high"].map((s) => ({ value: s, label: humanize(s) }))} placeholder="Not assessed" />}
        <TextInput label="Impact" value={v.impact} onChange={(x) => f.set("impact", x)} />
        <UserSelect label="Owner" value={v.owner_id} onChange={(x) => f.set("owner_id", x)} placeholder="Me" />
        <TextInput label="Review date" type="date" value={v.review_date} onChange={(x) => f.set("review_date", x)} />
        {risk && <SelectInput label="Status" value={v.status} onChange={(x) => f.set("status", x)} options={["open", "mitigating", "monitoring", "resolved", "closed"].map((s) => ({ value: s, label: humanize(s) }))} />}
        <TextArea label="Mitigation" className="full" rows={2} value={v.mitigation} onChange={(x) => f.set("mitigation", x)} />
        <TextArea label="Action plan" className="full" rows={2} value={v.action_plan} onChange={(x) => f.set("action_plan", x)} />
      </div>
    </Modal>
  );
}

// ===================================================================== dependencies
const DEP_ICON: Record<string, string> = { task: "tasks", milestone: "milestone", deliverable: "package", project: "folder" };
function DepLabel({ item }: { item: DepItem }) {
  const inner = <><Icon name={DEP_ICON[item.type] ?? "link"} size={13} /> {item.label}</>;
  return item.type === "task" ? <Link to={`/tasks/${item.id}`}>{inner}</Link> : item.type === "project" ? <Link to={`/projects/${item.id}`}>{inner}</Link> : <span>{inner}</span>;
}

export function DependenciesPanel({ project }: { project: ProjectDetail }) {
  const toast = useToast();
  const { data, error, loading, reload } = useApi<{ edges: (DepEdge & { from_type: string })[]; affected: { item: DepItem; blocked_by: DepItem; reason: string }[] }>(`/projects/${project.id}/dependencies`);
  const delivs = useApi<Deliverable[]>(`/projects/${project.id}/deliverables`);
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ from: "", to: "", note: "" });
  const [busy, setBusy] = useState(false);
  const items = [
    ...project.milestones.map((m) => ({ value: `milestone:${m.id}`, label: `Milestone — ${m.title}` })),
    ...(delivs.data ?? []).map((d) => ({ value: `deliverable:${d.id}`, label: `Deliverable — ${d.name}` })),
    { value: `project:${project.id}`, label: `Project — ${project.name}` },
  ];
  const add = async () => {
    const [ft, fi] = form.from.split(":");
    const [tt, ti] = form.to.split(":");
    setBusy(true);
    try {
      await api.post("/dependencies", { from_type: ft, from_id: fi, to_type: tt, to_id: ti, note: form.note });
      toast.success("Dependency added");
      setOpen(false);
      setForm({ from: "", to: "", note: "" });
      reload();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const remove = async (id: string) => {
    try { await api.del(`/dependencies/${id}`); toast.success("Dependency removed"); reload(); } catch (e) { toast.error((e as Error).message); }
  };
  if (error) return <ErrorState error={error} onRetry={reload} />;
  if (loading && !data) return <Loading />;
  return (
    <div className="stack">
      <div className="row-between">
        <h3>Dependencies</h3>
        {project.permissions.can_contribute && <Button size="sm" icon="plus" onClick={() => setOpen(true)}>Add dependency</Button>}
      </div>
      {!!data?.affected.length && (
        <Callout tone="warn" icon="alert">
          <strong>Potentially affected work</strong>
          <ul className="mt-1" style={{ margin: "4px 0 0", paddingLeft: 18 }}>
            {data.affected.map((a, i) => <li key={i}><DepLabel item={a.item} /> — {a.reason}</li>)}
          </ul>
        </Callout>
      )}
      {!data?.edges.length ? (
        <p className="muted small">No dependencies recorded for this project's milestones, deliverables or tasks.</p>
      ) : (
        <div className="card list">
          {data.edges.map((e) => (
            <div className="list-item" key={e.id}>
              <div style={{ flex: 1, minWidth: 0 }} className="small">
                <DepLabel item={e.from} /> <span className="muted">depends on</span> <DepLabel item={e.to} />
                <div className="meta">
                  <StatusBadge kind={e.to.type === "task" ? "task" : e.to.type === "project" ? "project" : e.to.type} value={e.to.status} />
                  {e.to.due && <span className={e.delayed ? "overdue" : ""}>due {fmtDate(e.to.due)}{e.delayed ? " — late" : ""}</span>}
                  {!e.blocking && <Badge tone="ok" icon="check">Resolved</Badge>}
                  {e.note && <span>{e.note}</span>}
                </div>
              </div>
              {project.permissions.can_contribute && <Button size="sm" variant="ghost" aria-label="Remove dependency" onClick={() => remove(e.id)}><Icon name="x" size={14} /></Button>}
            </div>
          ))}
        </div>
      )}
      <Modal open={open} onClose={() => setOpen(false)} title="Add dependency" footer={<><Button onClick={() => setOpen(false)}>Cancel</Button><Button variant="primary" onClick={add} loading={busy} disabled={!form.from || !form.to || form.from === form.to}>Add</Button></>}>
        <SelectInput label="This item…" value={form.from} onChange={(x) => setForm({ ...form, from: x })} options={items} placeholder="Choose…" />
        <SelectInput label="…depends on" value={form.to} onChange={(x) => setForm({ ...form, to: x })} options={items.filter((i) => i.value !== form.from)} placeholder="Choose…" />
        <TextInput label="Note" value={form.note} onChange={(x) => setForm({ ...form, note: x })} />
        <p className="muted small">Task dependencies are managed from the task page.</p>
      </Modal>
    </div>
  );
}
