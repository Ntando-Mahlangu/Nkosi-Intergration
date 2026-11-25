/** Decisions log (project-scoped or global) and project updates. */
import { useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../../lib/api";
import { useApi, useForm } from "../../lib/hooks";
import { useAuth, useToast } from "../../lib/app-state";
import { fmtDate, fmtDateTime, humanize } from "../../lib/format";
import { Badge, Button, Card, Checkbox, EmptyState, ErrorState, FormError, Loading, Modal, RichText, SelectInput, StatusBadge, TextArea, TextInput, Avatar } from "../../components/ui";
import { ProjectSelect, UserSelect } from "../../components/records";
import { Icon } from "../../components/Icon";
import type { Decision, ProjectDetail, ProjectUpdate } from "./types";
import { ProjectUpdateModal } from "./ProjectUpdateModal";

// ===================================================================== decision log
/**
 * Decision log. With `projectId` it shows that project's decisions; without, the global
 * (permission-filtered) log. `requiresManagement` narrows to escalated decisions.
 */
export function DecisionLog({ projectId, requiresManagement, canAdd = true, onChanged }: { projectId?: string; requiresManagement?: boolean; canAdd?: boolean; onChanged?: () => void }) {
  const toast = useToast();
  const [status, setStatus] = useState("");
  const [q, setQ] = useState("");
  const { data, error, loading, reload } = useApi<{ items: Decision[]; can_approve: boolean }>("/decisions", {
    project_id: projectId, requires_management: requiresManagement ? 1 : undefined, status: status || undefined, q: q || undefined,
  });
  const [editing, setEditing] = useState<Decision | "new" | null>(null);
  const [acting, setActing] = useState<{ d: Decision; action: "approve" | "reject" } | null>(null);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const refresh = () => { reload(); onChanged?.(); };

  const act = async () => {
    if (!acting) return;
    setBusy(true);
    try {
      await api.post(`/decisions/${acting.d.id}/${acting.action}`, { note });
      toast.success(acting.action === "approve" ? "Decision approved" : "Decision rejected");
      setActing(null);
      setNote("");
      refresh();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="stack">
      <div className="filter-bar" style={{ marginBottom: 0 }}>
        <input className="input" type="search" placeholder="Search decisions…" aria-label="Search decisions" value={q} onChange={(e) => setQ(e.target.value)} />
        <select className="select" aria-label="Status" value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="">Status: all</option>
          {["proposed", "pending_approval", "made", "approved", "rejected", "superseded", "revisited"].map((s) => <option key={s} value={s}>{humanize(s)}</option>)}
        </select>
        <span className="spacer" />
        {canAdd && <Button icon="plus" variant="primary" onClick={() => setEditing("new")}>Record decision</Button>}
      </div>
      {error ? <ErrorState error={error} onRetry={reload} /> : loading && !data ? <Loading /> : !data?.items.length ? (
        <Card><EmptyState icon="flag" title="No decisions recorded">Decisions from meetings and project work appear here, with who made them, when and why.</EmptyState></Card>
      ) : (
        <div className="stack">
          {data.items.map((d) => (
            <div className="card card-pad" key={d.id}>
              <div className="row-between">
                <div className="row">
                  <h3>{d.title}</h3>
                  <StatusBadge kind="decision" value={d.status} />
                  {!!d.requires_management && <Badge tone="warn" icon="chart">Management</Badge>}
                </div>
                <div className="row">
                  {data.can_approve && ["proposed", "pending_approval"].includes(d.status) && (
                    <>
                      <Button size="sm" variant="primary" icon="check" onClick={() => setActing({ d, action: "approve" })}>Approve</Button>
                      <Button size="sm" variant="danger" onClick={() => setActing({ d, action: "reject" })}>Reject</Button>
                    </>
                  )}
                  {d.can_edit && <Button size="sm" variant="ghost" aria-label={`Edit ${d.title}`} onClick={() => setEditing(d)}><Icon name="edit" size={14} /></Button>}
                </div>
              </div>
              <div className="meta row tiny muted mt-1">
                <span>{d.decision_date ? `Decided ${fmtDate(d.decision_date)}` : `Raised ${fmtDate(d.created_at)}`}</span>
                {d.decision_maker_name && <span>Decision maker: {d.decision_maker_name}</span>}
                {d.created_by_name && <span>Recorded by {d.created_by_name}</span>}
                {!projectId && d.project_id && d.project_name && <Link to={`/projects/${d.project_id}?tab=decisions`}>{d.project_name}</Link>}
                {d.meeting_id && d.meeting_title && <Link to={`/meetings/${d.meeting_id}`}><Icon name="meeting" size={11} /> {d.meeting_title}</Link>}
              </div>
              {d.description && <RichText text={d.description} className="small mt-1" />}
              {d.context && <div className="small"><strong>Context:</strong> {d.context}</div>}
              {d.consequences && <div className="small prewrap"><strong>Consequences / follow-up:</strong> {d.consequences}</div>}
            </div>
          ))}
        </div>
      )}
      {editing && <DecisionModal decision={editing === "new" ? null : editing} projectId={projectId} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); refresh(); }} />}
      <Modal
        open={!!acting}
        onClose={() => setActing(null)}
        title={acting?.action === "approve" ? "Approve decision" : "Reject decision"}
        footer={<><Button onClick={() => setActing(null)}>Cancel</Button><Button variant={acting?.action === "approve" ? "primary" : "danger"} onClick={act} loading={busy}>{acting?.action === "approve" ? "Approve" : "Reject"}</Button></>}
      >
        <p><strong>{acting?.d.title}</strong></p>
        <TextArea label="Note (recorded with the decision)" rows={3} value={note} onChange={setNote} />
      </Modal>
    </div>
  );
}

function DecisionModal({ decision, projectId, onClose, onSaved }: { decision: Decision | null; projectId?: string; onClose: () => void; onSaved: () => void }) {
  const toast = useToast();
  const { can } = useAuth();
  const d = decision;
  const f = useForm({
    title: d?.title ?? "", description: d?.description ?? "", context: d?.context ?? "", consequences: d?.consequences ?? "", project_id: d?.project_id ?? projectId ?? "",
    decision_maker_id: d?.decision_maker_id ?? "", decision_date: d?.decision_date ?? "", status: d?.status ?? "made", requires_management: !!d?.requires_management,
  });
  const v = f.values;
  const statuses = ["proposed", "pending_approval", "made", "superseded", "revisited", ...(d && ["approved", "rejected"].includes(d.status) ? [d.status] : [])];
  const save = () =>
    f.submit(
      async (x) => {
        const body = { ...x, project_id: x.project_id || null, decision_maker_id: x.decision_maker_id || null, decision_date: x.decision_date || null, status: x.requires_management && !d ? "pending_approval" : x.status };
        if (d) await api.patch(`/decisions/${d.id}`, body);
        else await api.post("/decisions", body);
        toast.success("Decision saved");
        onSaved();
      },
      (x) => (x.title.trim() ? {} : { title: "Summarise the decision in a short title." }),
    );
  return (
    <Modal open wide onClose={onClose} title={d ? "Edit decision" : "Record a decision"} footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" onClick={save} loading={f.submitting}>Save</Button></>}>
      <FormError message={f.formError} />
      <TextInput label="Decision" required value={v.title} onChange={(x) => f.set("title", x)} error={f.errors.title} placeholder="What was decided (or needs deciding)?" />
      <TextArea label="Description" rows={2} value={v.description} onChange={(x) => f.set("description", x)} />
      <div className="form-grid">
        <TextArea label="Context" rows={2} value={v.context} onChange={(x) => f.set("context", x)} />
        <TextArea label="Consequences / follow-up" rows={2} value={v.consequences} onChange={(x) => f.set("consequences", x)} />
        {!projectId && <ProjectSelect value={v.project_id} onChange={(x) => f.set("project_id", x)} onlyContributable placeholder="Not project-specific" />}
        <UserSelect label="Decision maker" value={v.decision_maker_id} onChange={(x) => f.set("decision_maker_id", x)} placeholder="Not recorded" />
        <TextInput label="Decision date" type="date" value={v.decision_date} onChange={(x) => f.set("decision_date", x)} />
        {!v.requires_management && <SelectInput label="Status" value={v.status} onChange={(x) => f.set("status", x)} options={statuses.map((s) => ({ value: s, label: humanize(s) }))} />}
      </div>
      {!d && <Checkbox label="This decision needs management approval" checked={v.requires_management} onChange={(x) => f.set("requires_management", x)} hint={can("decision.approve") ? undefined : "It will be sent to management for approval."} />}
    </Modal>
  );
}

// ===================================================================== updates
export function UpdatesTab({ project, onChanged }: { project: ProjectDetail; onChanged: () => void }) {
  const { data, error, loading, reload } = useApi<ProjectUpdate[]>(`/projects/${project.id}/updates`);
  const [open, setOpen] = useState(false);
  if (error) return <ErrorState error={error} onRetry={reload} />;
  if (loading && !data) return <Loading />;
  return (
    <div className="stack">
      <div className="row-between">
        <p className="muted small mb-1">Regular updates feed Fakawe reporting and keep management informed without status meetings.</p>
        {project.permissions.can_contribute && <Button variant="primary" icon="message" onClick={() => setOpen(true)}>Post update</Button>}
      </div>
      {!data?.length ? (
        <Card><EmptyState icon="message" title="No updates yet">Post a short update on progress, achievements, next steps and blockers.</EmptyState></Card>
      ) : (
        <div className="stack">
          {data.map((u) => (
            <div className="card card-pad" key={u.id}>
              <div className="row">
                <Avatar name={u.author_name} size="sm" />
                <strong className="small">{u.author_name ?? "Former user"}</strong>
                <span className="tiny muted">{fmtDateTime(u.created_at)}</span>
                {(u.period_start || u.period_end) && <span className="tiny muted">· Period {fmtDate(u.period_start)} – {fmtDate(u.period_end)}</span>}
                <span className="spacer" />
                {u.health && <StatusBadge kind="health" value={u.health} />}
                {u.progress != null && <Badge tone="accent">{u.progress}% reported</Badge>}
              </div>
              <RichText text={u.summary} className="mt-1" />
              <div className="grid grid-3 small">
                {u.achievements && <div><strong>Achievements</strong><RichText text={u.achievements} /></div>}
                {u.next_steps && <div><strong>Next steps</strong><RichText text={u.next_steps} /></div>}
                {u.blockers && <div><strong className="overdue">Blockers</strong><RichText text={u.blockers} /></div>}
              </div>
            </div>
          ))}
        </div>
      )}
      <ProjectUpdateModal open={open} onClose={() => setOpen(false)} projectId={project.id} canManage={project.permissions.can_manage} manualProgress={project.progress_method === "manual"} onSaved={() => { reload(); onChanged(); }} />
    </div>
  );
}
