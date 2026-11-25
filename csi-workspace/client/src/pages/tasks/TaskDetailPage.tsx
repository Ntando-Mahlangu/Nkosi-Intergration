import { useState, type ReactNode } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { api } from "../../lib/api";
import { useApi, useDebounced, localToday } from "../../lib/hooks";
import { useAuth, useToast } from "../../lib/app-state";
import { dueLabel, fmtDate, fmtDateTime, humanize, relTime } from "../../lib/format";
import { statusMeta } from "../../lib/status";
import { Icon } from "../../components/Icon";
import { Badge, Button, Card, ConfirmDialog, ErrorState, KeyValue, Loading, Modal, PageHeader, PersonChip, PriorityBadge, RichText, StatusBadge, Tags, TextArea, TextInput, FormError, Callout } from "../../components/ui";
import { Comments, DocumentLinks, UserSelect } from "../../components/records";
import { TaskFormModal } from "./TaskFormModal";
import type { TaskRow } from "./TaskList";
import "./tasks.css";

interface DepItem { dependency_id: string; type: string; id: string; label: string; status: string | null; ref: number | null; visible: boolean; note: string }
interface TaskDetail extends TaskRow {
  start_date: string | null;
  blocked_reason: string;
  milestone_id: string | null;
  milestone_title: string | null;
  deliverable_name: string | null;
  task_type: string;
  collaborators: { id: string; name: string }[];
  depends_on: DepItem[];
  blocking: DepItem[];
  history: { field: string; from_value: string | null; to_value: string; note: string; changed_at: string; changed_by_name: string | null }[];
  reviews: { id: string; body: string; created_at: string; author_name: string | null }[];
  permissions: { can_work: boolean; can_manage: boolean; can_review: boolean; can_accept: boolean; can_delete: boolean };
}

type Dialog = null | "block" | "review" | "submit" | "decline" | "accept" | "collab" | "dep" | "delete" | "edit";

export default function TaskDetailPage() {
  const { id } = useParams();
  const nav = useNavigate();
  const toast = useToast();
  const { me } = useAuth();
  const { data: t, error, loading, reload } = useApi<TaskDetail>(`/tasks/${id}`);
  const [dialog, setDialog] = useState<Dialog>(null);
  const [busy, setBusy] = useState(false);

  if (loading && !t) return <Loading />;
  if (error || !t) return <ErrorState error={error ?? "Task not found."} onRetry={reload} />;
  const p = t.permissions;
  const done = t.status === "completed";
  const closed = done || t.status === "cancelled";
  const due = dueLabel(t.due_date, localToday(), closed);

  const act = async (path: string, body: object = {}, msg = "Saved") => {
    setBusy(true);
    try {
      await api.post(`/tasks/${t.id}/${path}`, body);
      toast.success(msg);
      setDialog(null);
      await reload();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const setStatus = async (status: string, extra: object = {}) => {
    setBusy(true);
    try {
      await api.patch(`/tasks/${t.id}`, { status, ...extra });
      toast.success(`Status: ${statusMeta("task", status).label}`);
      setDialog(null);
      await reload();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const del = async () => {
    setBusy(true);
    try {
      const r = await api.del<{ cancelled?: boolean }>(`/tasks/${t.id}`);
      toast.success(r.cancelled ? "Task cancelled (kept on the meeting record)" : "Task deleted");
      if (r.cancelled) {
        setDialog(null);
        reload();
      } else nav("/tasks");
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const needsReview = t.review_required && t.review_status !== "approved";

  return (
    <>
      <PageHeader
        breadcrumbs={[{ label: "My Tasks", to: "/tasks" }, ...(t.project_id && t.project_name ? [{ label: t.project_name, to: `/projects/${t.project_id}` }] : []), { label: `T-${t.ref}` }]}
        title={<span className="tsk-detail-title">{t.title}</span>}
        subtitle={
          <span className="row">
            <StatusBadge kind="task" value={t.status} />
            <PriorityBadge value={t.priority} />
            {t.review_required && <StatusBadge kind="review" value={t.review_status === "none" ? "pending" : t.review_status} />}
            {t.is_personal && <Badge icon="lock">Personal — private</Badge>}
            <span className={due.cls}>{due.text}</span>
          </span>
        }
        actions={
          <>
            {p.can_manage && !closed && (
              <Button icon="edit" onClick={() => setDialog("edit")}>
                Edit
              </Button>
            )}
            {p.can_delete && (
              <Button variant="ghost" icon="trash" onClick={() => setDialog("delete")} aria-label="Delete task">
                {t.meeting_id ? "Cancel task" : "Delete"}
              </Button>
            )}
          </>
        }
      />

      {t.status === "suggested" && (
        <div className="tsk-suggest mb-3">
          <Icon name="sparkles" />
          <div style={{ flex: 1, minWidth: 220 }}>
            <strong>{p.can_accept ? "This responsibility was suggested for you." : `Waiting for ${t.assignee_name ?? "the assignee"} to confirm.`}</strong>
            <div className="small">
              It came from {t.meeting_title ? <>the meeting “{t.meeting_title}”</> : "a suggestion"} and is not yet a confirmed responsibility.
              {t.source_ref && <div className="evidence mt-1">“{t.source_ref}”</div>}
            </div>
          </div>
          {p.can_accept && (
            <div className="row">
              <Button variant="primary" icon="check" onClick={() => setDialog("accept")}>
                Accept
              </Button>
              <Button onClick={() => setDialog("decline")}>Decline</Button>
            </div>
          )}
        </div>
      )}

      {t.status === "awaiting_review" && (
        <div className="mb-3">
          <Callout tone="warn" icon="eye">
            {p.can_review ? (
              <span className="row-between" style={{ width: "100%" }}>
                <span>
                  <strong>{t.assignee_name}</strong> submitted this for your review.
                </span>
                <Button variant="primary" size="sm" onClick={() => setDialog("review")}>
                  Review now
                </Button>
              </span>
            ) : (
              <>Awaiting review by <strong>{t.reviewer_name ?? "the reviewer"}</strong>.</>
            )}
          </Callout>
        </div>
      )}
      {t.status === "blocked" && t.blocked_reason && (
        <div className="mb-3">
          <Callout tone="danger" icon="ban">
            <strong>Blocked:</strong> {t.blocked_reason}
          </Callout>
        </div>
      )}
      {t.review_status === "changes_requested" && t.status === "in_progress" && t.reviews[0] && (
        <div className="mb-3">
          <Callout tone="danger" icon="edit">
            <strong>Changes requested</strong> by {t.reviews[0].author_name}: {t.reviews[0].body.replace(/^Changes requested:\s*/, "")}
          </Callout>
        </div>
      )}

      {p.can_work && !["suggested", "cancelled"].includes(t.status) && (
        <div className="tsk-actionbar mb-3" aria-label="Task actions">
          {t.status === "todo" && (
            <Button icon="clock" onClick={() => setStatus("in_progress")} loading={busy}>
              Start
            </Button>
          )}
          {t.status === "blocked" && (
            <Button icon="refresh" onClick={() => setStatus("in_progress")} loading={busy}>
              Unblock
            </Button>
          )}
          {["todo", "in_progress"].includes(t.status) && (
            <Button icon="ban" onClick={() => setDialog("block")}>
              Mark blocked
            </Button>
          )}
          {["todo", "in_progress", "blocked"].includes(t.status) &&
            (needsReview ? (
              <Button variant="primary" icon="send" onClick={() => setDialog("submit")}>
                Submit for review
              </Button>
            ) : (
              <Button variant="primary" icon="check" onClick={() => act("complete", {}, "Task completed")} loading={busy}>
                Mark complete
              </Button>
            ))}
          {!needsReview && t.review_required === false && ["todo", "in_progress", "blocked"].includes(t.status) && (
            <Button variant="ghost" size="sm" onClick={() => setDialog("submit")}>
              Ask for review
            </Button>
          )}
          {done && (
            <Button icon="refresh" onClick={() => act("reopen", {}, "Task reopened")} loading={busy}>
              Reopen
            </Button>
          )}
        </div>
      )}
      {!p.can_work && t.status !== "suggested" && (
        <div className="mb-3">
          <Callout icon="eye">You can view this task. Only the assignee, collaborators, creator or project managers can update it.</Callout>
        </div>
      )}
      {t.status === "cancelled" && p.can_manage && (
        <div className="tsk-actionbar mb-3">
          <Button icon="refresh" onClick={() => act("reopen", {}, "Task reopened")} loading={busy}>
            Reopen
          </Button>
        </div>
      )}

      <div className="cols-main-side">
        <div className="stack">
          <Card title="Description">{t.description ? <RichText text={t.description} /> : <p className="muted small">No description.</p>}</Card>
          {t.reviews.length > 0 && (
            <Card title="Review history">
              <ul className="timeline">
                {t.reviews.map((r) => (
                  <li key={r.id}>
                    <span className="tl-dot">
                      <Icon name={r.body.startsWith("Approved") ? "check" : "edit"} />
                    </span>
                    <div className="small">
                      <strong>{r.author_name}</strong> <span className="muted tiny">{relTime(r.created_at)}</span>
                      <div className="prewrap">{r.body}</div>
                    </div>
                  </li>
                ))}
              </ul>
            </Card>
          )}
          <Card>
            <Comments entityType="task" entityId={t.id} />
          </Card>
          <Card>
            <DocumentLinks entityType="task" entityId={t.id} canEdit={p.can_work || p.can_manage} />
          </Card>
        </div>

        <aside className="stack tsk-sidebar">
          <Card title="Details">
            <KeyValue
              items={[
                ["Assignee", <PersonChip name={t.assignee_name} />],
                ["Created by", t.creator_name ?? "—"],
                ["Due", t.due_date ? fmtDate(t.due_date, { year: true }) : "No due date"],
                ["Start", t.start_date ? fmtDate(t.start_date, { year: true }) : null],
                ["Priority", humanize(t.priority)],
                ["Project", t.project_id && t.project_name ? <Link to={`/projects/${t.project_id}`}>{t.project_name}</Link> : t.is_personal ? "Personal" : "—"],
                ["Meeting", t.meeting_id && t.meeting_title ? <Link to={`/meetings/${t.meeting_id}`}>{t.meeting_title}</Link> : null],
                ["Deliverable", t.deliverable_name],
                ["Milestone", t.milestone_title],
                ["Source", humanize(t.source)],
                ["Reviewer", t.review_required ? (t.reviewer_name ?? "Not set") : "No review required"],
                ["Tags", t.tags ? <Tags value={t.tags} /> : null],
                ["Updated", fmtDateTime(t.updated_at)],
                ["Completed", t.completed_at ? fmtDateTime(t.completed_at) : null],
              ].filter(([, v]) => v !== null) as [string, ReactNode][]}
            />
            <div className="tiny muted mt-2">Task T-{t.ref}</div>
          </Card>

          <Card
            title="Collaborators"
            actions={
              (p.can_manage || t.assignee_id === me?.user.id) && !t.is_personal ? (
                <Button size="sm" icon="plus" onClick={() => setDialog("collab")}>
                  Add
                </Button>
              ) : undefined
            }
          >
            {t.collaborators.length ? (
              <div className="tsk-people">
                {t.collaborators.map((c) => (
                  <div key={c.id} className="row-between">
                    <PersonChip name={c.name} />
                    {(p.can_manage || t.assignee_id === me?.user.id || c.id === me?.user.id) && (
                      <button
                        className="btn btn-ghost btn-sm"
                        aria-label={`Remove ${c.name}`}
                        onClick={() => api.del(`/tasks/${t.id}/collaborators/${c.id}`).then(reload, (e) => toast.error(e.message))}
                      >
                        <Icon name="x" size={14} />
                      </button>
                    )}
                  </div>
                ))}
              </div>
            ) : (
              <p className="muted small">No collaborators.</p>
            )}
          </Card>

          <Card
            title="Dependencies"
            actions={
              p.can_work ? (
                <Button size="sm" icon="plus" onClick={() => setDialog("dep")}>
                  Add
                </Button>
              ) : undefined
            }
          >
            <div className="small strong mb-1">Waiting on</div>
            {t.depends_on.length ? (
              t.depends_on.map((d) => <DepRow key={d.dependency_id} d={d} canRemove={p.can_work} onRemove={() => api.del(`/tasks/${t.id}/dependencies/${d.dependency_id}`).then(reload, (e) => toast.error(e.message))} />)
            ) : (
              <p className="muted small">Not waiting on anything.</p>
            )}
            <div className="small strong mb-1 mt-2">Blocking</div>
            {t.blocking.length ? t.blocking.map((d) => <DepRow key={d.dependency_id} d={d} canRemove={false} />) : <p className="muted small">Nothing depends on this task.</p>}
          </Card>

          <Card title="History">
            {t.history.length ? (
              <ul className="timeline">
                {t.history.slice(0, 12).map((h, i) => (
                  <li key={i}>
                    <span className="tl-dot">
                      <Icon name={statusMeta(h.field === "review_status" ? "review" : "task", h.to_value).icon} />
                    </span>
                    <div className="small">
                      <div>
                        {h.field === "review_status" ? "Review" : "Status"}: {h.from_value ? <>{statusMeta(h.field === "review_status" ? "review" : "task", h.from_value).label} → </> : null}
                        <strong>{statusMeta(h.field === "review_status" ? "review" : "task", h.to_value).label}</strong>
                      </div>
                      {h.note && <div className="muted">{h.note}</div>}
                      <div className="tiny muted">
                        {h.changed_by_name ?? "System"} · {relTime(h.changed_at)}
                      </div>
                    </div>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="muted small">No changes recorded.</p>
            )}
          </Card>
        </aside>
      </div>

      {/* ---------------------------------------------------------------- dialogs */}
      <TaskFormModal open={dialog === "edit"} onClose={() => setDialog(null)} onSaved={() => reload()} task={t} />
      <BlockDialog open={dialog === "block"} onClose={() => setDialog(null)} onSubmit={(reason) => setStatus("blocked", { blocked_reason: reason })} busy={busy} />
      <SubmitReviewDialog open={dialog === "submit"} task={t} onClose={() => setDialog(null)} onSubmit={(body) => act("submit-review", body, "Submitted for review")} busy={busy} />
      <ReviewDialog open={dialog === "review"} task={t} onClose={() => setDialog(null)} onSubmit={(body) => act("review", body, body.decision === "approve" ? "Approved — task completed" : "Changes requested")} busy={busy} />
      <AcceptDialog open={dialog === "accept"} task={t} onClose={() => setDialog(null)} onSubmit={(body) => act("accept", body, "Task accepted")} busy={busy} />
      <ReasonDialog
        open={dialog === "decline"}
        title="Decline this responsibility"
        label="Reason"
        hint="The organiser will be notified so they can reassign it."
        confirm="Decline"
        onClose={() => setDialog(null)}
        onSubmit={(reason) => act("decline", { reason }, "Declined")}
        busy={busy}
      />
      <CollaboratorDialog open={dialog === "collab"} task={t} onClose={() => setDialog(null)} onDone={reload} />
      <DependencyDialog open={dialog === "dep"} task={t} onClose={() => setDialog(null)} onDone={reload} />
      <ConfirmDialog
        open={dialog === "delete"}
        title={t.meeting_id ? "Cancel this task?" : "Delete this task?"}
        message={t.meeting_id ? "This action came from a meeting, so it will be cancelled and kept on the meeting record." : "This permanently removes the task, its comments and document links."}
        confirmLabel={t.meeting_id ? "Cancel task" : "Delete task"}
        danger
        busy={busy}
        onConfirm={del}
        onClose={() => setDialog(null)}
      />
    </>
  );
}

function DepRow({ d, canRemove, onRemove }: { d: DepItem; canRemove: boolean; onRemove?: () => void }) {
  const done = d.status === "completed" || d.status === "achieved" || d.status === "approved";
  return (
    <div className="tsk-dep">
      <Icon name={done ? "checkCircle" : "clock"} size={14} />
      <div style={{ flex: 1, minWidth: 0 }}>
        {d.type === "task" && d.visible ? <Link to={`/tasks/${d.id}`}>{d.label}</Link> : <span>{d.label}</span>}
        <div className="tiny muted">
          {humanize(d.type)}
          {d.status ? ` · ${statusMeta(d.type === "task" ? "task" : d.type, d.status).label}` : ""}
          {d.note ? ` · ${d.note}` : ""}
        </div>
      </div>
      {canRemove && onRemove && (
        <button className="btn btn-ghost btn-sm" onClick={onRemove} aria-label={`Remove dependency on ${d.label}`}>
          <Icon name="x" size={14} />
        </button>
      )}
    </div>
  );
}

function ReasonDialog({ open, title, label, hint, confirm, onClose, onSubmit, busy }: { open: boolean; title: string; label: string; hint?: string; confirm: string; onClose: () => void; onSubmit: (reason: string) => void; busy: boolean }) {
  const [reason, setReason] = useState("");
  const [err, setErr] = useState("");
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={title}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={busy} onClick={() => (reason.trim() ? onSubmit(reason.trim()) : setErr("Please give a reason."))}>
            {confirm}
          </Button>
        </>
      }
    >
      <TextArea label={label} required value={reason} onChange={(v) => { setReason(v); setErr(""); }} error={err} hint={hint} rows={3} />
    </Modal>
  );
}

function BlockDialog(props: { open: boolean; onClose: () => void; onSubmit: (reason: string) => void; busy: boolean }) {
  return <ReasonDialog {...props} title="Mark task as blocked" label="What is blocking this task?" hint="The task creator will be told what is blocking progress." confirm="Mark blocked" />;
}

function SubmitReviewDialog({ open, task, onClose, onSubmit, busy }: { open: boolean; task: TaskDetail; onClose: () => void; onSubmit: (b: { reviewer_id: string | null; note: string }) => void; busy: boolean }) {
  const [reviewer, setReviewer] = useState(task.reviewer_id ?? "");
  const [note, setNote] = useState("");
  const [err, setErr] = useState("");
  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Submit for review"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={busy} onClick={() => (reviewer ? onSubmit({ reviewer_id: reviewer, note }) : setErr("Choose a reviewer."))}>
            Submit for review
          </Button>
        </>
      }
    >
      <UserSelect label="Reviewer" required value={reviewer} onChange={(v) => { setReviewer(v); setErr(""); }} error={err} filter={(u) => u.id !== task.assignee_id} />
      <TextArea label="Note for the reviewer" value={note} onChange={setNote} rows={3} placeholder="What should they look at? Link the work in Documents if needed." />
    </Modal>
  );
}

function ReviewDialog({ open, task, onClose, onSubmit, busy }: { open: boolean; task: TaskDetail; onClose: () => void; onSubmit: (b: { decision: "approve" | "changes"; feedback: string }) => void; busy: boolean }) {
  const [feedback, setFeedback] = useState("");
  const [err, setErr] = useState("");
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={`Review: ${task.title}`}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="danger" loading={busy} onClick={() => (feedback.trim() ? onSubmit({ decision: "changes", feedback }) : setErr("Explain what needs to change."))}>
            Request changes
          </Button>
          <Button variant="primary" loading={busy} onClick={() => onSubmit({ decision: "approve", feedback })}>
            Approve & complete
          </Button>
        </>
      }
    >
      <p className="small muted">Submitted by {task.assignee_name}. Approving marks the task complete; requesting changes returns it with your feedback.</p>
      <TextArea label="Feedback" value={feedback} onChange={(v) => { setFeedback(v); setErr(""); }} error={err} rows={4} hint="Required when requesting changes." />
    </Modal>
  );
}

function AcceptDialog({ open, task, onClose, onSubmit, busy }: { open: boolean; task: TaskDetail; onClose: () => void; onSubmit: (b: { due_date: string | null }) => void; busy: boolean }) {
  const [due, setDue] = useState(task.due_date ?? "");
  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Accept responsibility"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={busy} onClick={() => onSubmit({ due_date: due || null })}>
            Accept task
          </Button>
        </>
      }
    >
      <p className="small">
        You are confirming that you will do: <strong>{task.title}</strong>
      </p>
      <TextInput label="Due date" type="date" value={due} onChange={setDue} hint={task.due_date ? "Suggested from the meeting — adjust if needed." : "No deadline was stated. Add one if you have agreed it."} />
    </Modal>
  );
}

function CollaboratorDialog({ open, task, onClose, onDone }: { open: boolean; task: TaskDetail; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const [userId, setUserId] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const save = async () => {
    if (!userId) return setErr("Choose a person.");
    setBusy(true);
    try {
      await api.post(`/tasks/${task.id}/collaborators`, { user_id: userId });
      toast.success("Collaborator added");
      setUserId("");
      onClose();
      onDone();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const existing = new Set([task.assignee_id, ...task.collaborators.map((c) => c.id)]);
  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Add collaborator"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={busy} onClick={save}>
            Add
          </Button>
        </>
      }
    >
      <UserSelect label="Person" required value={userId} onChange={(v) => { setUserId(v); setErr(""); }} error={err} filter={(u) => !existing.has(u.id)} hint="Collaborators can update the task's status and see it in their lists." />
    </Modal>
  );
}

function DependencyDialog({ open, task, onClose, onDone }: { open: boolean; task: TaskDetail; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const [q, setQ] = useState("");
  const dq = useDebounced(q, 300);
  const [note, setNote] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const { data, loading } = useApi<{ items: TaskRow[] }>(open ? "/tasks" : null, { scope: "visible", view: "everything", q: dq, limit: 20, sort: "updated", project_id: dq ? undefined : (task.project_id ?? undefined) });
  const options = (data?.items ?? []).filter((x) => x.id !== task.id && !task.depends_on.some((d) => d.id === x.id));
  const add = async (depId: string) => {
    setBusy(true);
    setErr("");
    try {
      await api.post(`/tasks/${task.id}/dependencies`, { depends_on_task_id: depId, note });
      toast.success("Dependency added");
      setQ("");
      setNote("");
      onClose();
      onDone();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal open={open} onClose={onClose} title="This task is waiting on…" wide>
      <FormError message={err} />
      <TextInput label="Find a task" type="search" value={q} onChange={setQ} placeholder="Search by title or T-number" hint={!dq && task.project_id ? "Showing recent tasks in this project." : undefined} />
      <TextInput label="Note (optional)" value={note} onChange={setNote} placeholder="e.g. Needs archive access first" />
      {loading && !data ? (
        <Loading />
      ) : options.length ? (
        <div className="card list">
          {options.map((o) => (
            <div className="list-item" key={o.id}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div className="title">{o.title}</div>
                <div className="meta">
                  <span>T-{o.ref}</span>
                  <StatusBadge kind="task" value={o.status} />
                  {o.project_name && <span>{o.project_name}</span>}
                  <span>{o.assignee_name}</span>
                </div>
              </div>
              <Button size="sm" onClick={() => add(o.id)} loading={busy}>
                Select
              </Button>
            </div>
          ))}
        </div>
      ) : (
        <p className="muted small">No matching tasks.</p>
      )}
    </Modal>
  );
}
