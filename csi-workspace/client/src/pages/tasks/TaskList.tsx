/**
 * Reusable task list (used by My Workspace, My Tasks, project and meeting pages).
 * Inline completion respects the server's can_work flag and review rules:
 * ticking a review-required task submits it for review instead of completing it.
 */
import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../../lib/api";
import { useToast } from "../../lib/app-state";
import { localToday } from "../../lib/hooks";
import { dueLabel, humanize } from "../../lib/format";
import { Icon } from "../../components/Icon";
import { Badge, EmptyState, PriorityBadge, StatusBadge } from "../../components/ui";
import "./tasks.css";

export interface TaskRow {
  id: string;
  ref: number;
  title: string;
  description: string;
  status: string;
  priority: string;
  due_date: string | null;
  assignee_id: string | null;
  assignee_name: string | null;
  creator_id: string | null;
  creator_name: string | null;
  project_id: string | null;
  project_name: string | null;
  meeting_id: string | null;
  meeting_title: string | null;
  deliverable_id: string | null;
  source: string;
  source_ref: string;
  review_required: boolean;
  reviewer_id: string | null;
  reviewer_name: string | null;
  review_status: string;
  is_personal: boolean;
  tags: string;
  completed_at: string | null;
  created_at: string;
  updated_at: string;
  can_work: boolean;
  can_manage: boolean;
  blocked_by_open: number;
}

const SOURCE_ICON: Record<string, string> = { meeting: "meeting", project: "folder", deliverable: "package", management: "chart", opportunity: "target", knowledge: "book", email: "message", personal: "user", automation: "zap", import: "upload" };

export function TaskItem({ task, onChanged, showProject = true, showAssignee = false }: { task: TaskRow; onChanged?: () => void; showProject?: boolean; showAssignee?: boolean }) {
  const toast = useToast();
  const [state, setState] = useState<TaskRow>(task);
  const [busy, setBusy] = useState(false);
  const [undo, setUndo] = useState(false);
  const timer = useRef<number | null>(null);
  useEffect(() => setState(task), [task]);
  useEffect(() => () => { if (timer.current) window.clearTimeout(timer.current); }, []);

  const done = state.status === "completed";
  const reviewPending = state.status === "awaiting_review";
  const disabled = busy || !state.can_work || state.status === "suggested" || state.status === "cancelled" || reviewPending;
  const due = dueLabel(state.due_date, localToday(), done || state.status === "cancelled");

  const scheduleRefresh = () => {
    if (timer.current) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => { setUndo(false); onChanged?.(); }, 4000);
  };

  const toggle = async () => {
    setBusy(true);
    try {
      if (done) {
        const r = await api.post<TaskRow>(`/tasks/${state.id}/reopen`);
        setState({ ...state, ...r });
        setUndo(false);
        toast.info(`Reopened "${state.title}"`);
        onChanged?.();
      } else if (state.review_required && state.review_status !== "approved") {
        if (!state.reviewer_id) {
          toast.error("This task needs a reviewer — open it to choose one.");
        } else {
          const r = await api.post<TaskRow>(`/tasks/${state.id}/submit-review`);
          setState({ ...state, ...r });
          toast.success(`Submitted for review by ${state.reviewer_name ?? "the reviewer"}`);
          onChanged?.();
        }
      } else {
        const r = await api.post<TaskRow>(`/tasks/${state.id}/complete`);
        setState({ ...state, ...r });
        setUndo(true);
        toast.success(`Completed "${state.title}"`);
        scheduleRefresh();
      }
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const undoComplete = async () => {
    if (timer.current) window.clearTimeout(timer.current);
    setBusy(true);
    try {
      const r = await api.post<TaskRow>(`/tasks/${state.id}/reopen`);
      setState({ ...state, ...r });
      setUndo(false);
      onChanged?.();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const checkLabel = done ? `Reopen ${state.title}` : state.review_required && state.review_status !== "approved" ? `Submit ${state.title} for review` : `Mark ${state.title} complete`;
  return (
    <div className={`task-row ${done ? "tsk-done" : ""}`}>
      <button
        className={`task-check ${done ? "done" : ""}`}
        onClick={toggle}
        disabled={disabled && !done ? true : busy || !state.can_work}
        aria-label={checkLabel}
        title={!state.can_work ? "You can view but not update this task" : reviewPending ? "Awaiting review" : state.status === "suggested" ? "Accept this task first" : checkLabel}
      >
        {busy ? <span className="spinner" style={{ width: 12, height: 12, color: "var(--text-3)" }} /> : done ? <Icon name="check" size={14} /> : reviewPending ? <Icon name="eye" size={12} className="tsk-check-muted" /> : null}
      </button>
      <div className="tsk-main">
        <div className="row" style={{ gap: 6 }}>
          <Link to={`/tasks/${state.id}`} className={`task-title ${done ? "done" : ""}`}>
            {state.title}
          </Link>
          <PriorityBadge value={state.priority} />
          {state.status !== "todo" && !done && <StatusBadge kind="task" value={state.status} />}
          {state.review_required && !reviewPending && !done && (
            <Badge tone="neutral" icon="eye" title={`Reviewer: ${state.reviewer_name ?? "not set"}`}>
              Review required
            </Badge>
          )}
          {state.review_status === "changes_requested" && !reviewPending && <StatusBadge kind="review" value="changes_requested" />}
          {state.blocked_by_open > 0 && !done && (
            <Badge tone="warn" icon="link" title="Depends on unfinished work">
              Waiting on {state.blocked_by_open}
            </Badge>
          )}
        </div>
        <div className="meta">
          <span className={due.cls}>
            <Icon name="calendar" size={12} /> {due.text}
          </span>
          {showProject && state.project_name && (
            <span>
              <Icon name="folder" size={12} />{" "}
              {state.project_id ? <Link to={`/projects/${state.project_id}`}>{state.project_name}</Link> : state.project_name}
            </span>
          )}
          {state.meeting_title && (
            <span>
              <Icon name="meeting" size={12} />{" "}
              {state.meeting_id ? <Link to={`/meetings/${state.meeting_id}`}>{state.meeting_title}</Link> : state.meeting_title}
            </span>
          )}
          {!state.meeting_title && state.source !== "project" && (
            <span>
              <Icon name={SOURCE_ICON[state.source] ?? "dot"} size={12} /> {state.is_personal ? "Personal (private)" : humanize(state.source)}
            </span>
          )}
          {showAssignee && <span><Icon name="user" size={12} /> {state.assignee_name ?? "Unassigned"}</span>}
          <span className="tsk-ref">T-{state.ref}</span>
        </div>
        {state.description && <div className="tsk-desc">{state.description}</div>}
      </div>
      {undo && (
        <button className="btn btn-sm" onClick={undoComplete} disabled={busy}>
          Undo
        </button>
      )}
    </div>
  );
}

export function TaskList({ tasks, onChanged, showProject = true, showAssignee = false, emptyTitle = "Nothing here", emptyText }: { tasks: TaskRow[]; onChanged?: () => void; showProject?: boolean; showAssignee?: boolean; emptyTitle?: string; emptyText?: string }) {
  if (!tasks.length) return <EmptyState icon="checkCircle" title={emptyTitle}>{emptyText}</EmptyState>;
  return (
    <div className="tsk-list" role="list">
      {tasks.map((t) => (
        <div role="listitem" key={t.id}>
          <TaskItem task={t} onChanged={onChanged} showProject={showProject} showAssignee={showAssignee} />
        </div>
      ))}
    </div>
  );
}
