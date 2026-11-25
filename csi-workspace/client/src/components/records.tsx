/**
 * Reusable record widgets backed by the core API:
 *   <UserSelect/>, <ProjectSelect/>  — permission-aware pickers from /api/lookups
 *   <Comments/>                      — /api/comments
 *   <DocumentLinks/>                 — /api/attachments (secure document links incl. Google Drive/Docs)
 *   <RelatedRecords/>                — /api/links (cross-module relationships, permission filtered)
 *   <ActivityList/>                  — renders activity rows from any module endpoint
 */
import React, { useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../lib/api";
import { useApi } from "../lib/hooks";
import { useAuth, useLookups, useToast } from "../lib/app-state";
import { relTime, humanize } from "../lib/format";
import { Icon } from "./Icon";
import { Avatar, Button, EmptyState, Loading, SelectInput, TextArea, TextInput, Badge, Modal } from "./ui";

export function UserSelect({ label, value, onChange, error, required, placeholder = "Select a person…", filter, hint, className }: { label: string; value: string | null | undefined; onChange: (v: string) => void; error?: string; required?: boolean; placeholder?: string; filter?: (u: { id: string; role_key: string }) => boolean; hint?: string; className?: string }) {
  const { lookups } = useLookups();
  const users = (lookups?.users ?? []).filter((u) => !filter || filter(u));
  return <SelectInput label={label} value={value ?? ""} onChange={onChange} error={error} required={required} placeholder={placeholder} hint={hint} className={className} options={users.map((u) => ({ value: u.id, label: u.job_title ? `${u.name} — ${u.job_title}` : u.name }))} />;
}

export function ProjectSelect({ label = "Project", value, onChange, error, required, placeholder = "No project", onlyContributable, hint, className }: { label?: string; value: string | null | undefined; onChange: (v: string) => void; error?: string; required?: boolean; placeholder?: string; onlyContributable?: boolean; hint?: string; className?: string }) {
  const { lookups } = useLookups();
  const { me } = useAuth();
  const projects = (lookups?.projects ?? []).filter((p) => !onlyContributable || p.owner_id === me?.user.id || (p.my_role && p.my_role !== "viewer"));
  return <SelectInput label={label} value={value ?? ""} onChange={onChange} error={error} required={required} placeholder={placeholder} hint={hint} className={className} options={projects.map((p) => ({ value: p.id, label: p.name }))} />;
}

// ------------------------------------------------------------------ comments
interface CommentRow { id: string; author_id: string; author_name: string; body: string; kind: string; created_at: string }

export function Comments({ entityType, entityId, title = "Comments" }: { entityType: string; entityId: string; title?: string }) {
  const { data, loading, reload } = useApi<CommentRow[]>("/comments", { entity_type: entityType, entity_id: entityId });
  const { me } = useAuth();
  const toast = useToast();
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);
  const post = async () => {
    if (!body.trim()) return;
    setBusy(true);
    try {
      await api.post("/comments", { entity_type: entityType, entity_id: entityId, body });
      setBody("");
      reload();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const del = async (id: string) => {
    await api.del(`/comments/${id}`).then(reload, (e) => toast.error(e.message));
  };
  return (
    <div className="stack">
      <h3>{title}</h3>
      {loading && !data ? (
        <Loading />
      ) : data && data.length ? (
        <ul className="timeline">
          {data.map((c) => (
            <li key={c.id}>
              <Avatar name={c.author_name} size="sm" />
              <div style={{ minWidth: 0, flex: 1 }}>
                <div className="row small">
                  <strong>{c.author_name ?? "Former user"}</strong>
                  {c.kind !== "comment" && <Badge tone={c.kind === "review_feedback" ? "warn" : "neutral"}>{humanize(c.kind)}</Badge>}
                  <span className="muted tiny">{relTime(c.created_at)}</span>
                  {c.author_id === me?.user.id && (
                    <button className="btn btn-ghost btn-sm" onClick={() => del(c.id)} aria-label="Delete comment">
                      <Icon name="trash" size={14} />
                    </button>
                  )}
                </div>
                <div className="prewrap small">{c.body}</div>
              </div>
            </li>
          ))}
        </ul>
      ) : (
        <p className="muted small">No comments yet.</p>
      )}
      <div>
        <TextArea label="Add a comment" value={body} onChange={setBody} rows={2} placeholder="Write a comment or note…" />
        <div className="row" style={{ justifyContent: "flex-end" }}>
          <Button size="sm" variant="primary" onClick={post} loading={busy} disabled={!body.trim()}>
            Post comment
          </Button>
        </div>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ document links
interface Attachment { id: string; title: string; url: string; kind: string; description: string; added_by_name: string; created_at: string }
const KIND_LABEL: Record<string, string> = { google_doc: "Google Doc", google_sheet: "Google Sheet", google_drive_folder: "Drive folder", pdf: "PDF", link: "Link" };

export function DocumentLinks({ entityType, entityId, canEdit = true, title = "Documents & links" }: { entityType: string; entityId: string; canEdit?: boolean; title?: string }) {
  const { data, loading, reload } = useApi<Attachment[]>("/attachments", { entity_type: entityType, entity_id: entityId });
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ title: "", url: "", description: "" });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    try {
      await api.post("/attachments", { entity_type: entityType, entity_id: entityId, ...form });
      setOpen(false);
      setForm({ title: "", url: "", description: "" });
      setErrors({});
      toast.success("Document link added");
      reload();
    } catch (e) {
      const err = e as { fields?: Record<string, string>; message: string };
      setErrors(err.fields ?? {});
      if (!err.fields || !Object.keys(err.fields).length) toast.error(err.message);
    } finally {
      setBusy(false);
    }
  };
  const remove = async (id: string) => {
    await api.del(`/attachments/${id}`).then(() => { toast.success("Link removed"); reload(); }, (e) => toast.error(e.message));
  };
  return (
    <div className="stack">
      <div className="row-between">
        <h3>{title}</h3>
        {canEdit && (
          <Button size="sm" icon="plus" onClick={() => setOpen(true)}>
            Add link
          </Button>
        )}
      </div>
      {loading && !data ? (
        <Loading />
      ) : data && data.length ? (
        <div className="list card">
          {data.map((a) => (
            <div className="list-item" key={a.id}>
              <Icon name={a.kind === "google_drive_folder" ? "folder" : "file"} />
              <div style={{ minWidth: 0, flex: 1 }}>
                <a className="title" href={a.url} target="_blank" rel="noopener noreferrer">
                  {a.title} <Icon name="external" size={12} />
                </a>
                <div className="meta">
                  <span>{KIND_LABEL[a.kind] ?? "Link"}</span>
                  <span>Added by {a.added_by_name ?? "former user"} · {relTime(a.created_at)}</span>
                </div>
                {a.description && <div className="small muted">{a.description}</div>}
              </div>
              {canEdit && (
                <button className="btn btn-ghost btn-sm" onClick={() => remove(a.id)} aria-label={`Remove ${a.title}`}>
                  <Icon name="trash" size={14} />
                </button>
              )}
            </div>
          ))}
        </div>
      ) : (
        <p className="muted small">No documents linked. Add Google Drive, Docs, Sheets or other secure links.</p>
      )}
      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title="Add document link"
        footer={
          <>
            <Button onClick={() => setOpen(false)}>Cancel</Button>
            <Button variant="primary" onClick={save} loading={busy}>
              Add link
            </Button>
          </>
        }
      >
        <TextInput label="Title" required value={form.title} onChange={(v) => setForm({ ...form, title: v })} error={errors.title} />
        <TextInput label="URL" required type="url" placeholder="https://docs.google.com/…" value={form.url} onChange={(v) => setForm({ ...form, url: v })} error={errors.url} hint="Links are stored, not files. Access is controlled by the document's own sharing settings." />
        <TextArea label="Description" rows={2} value={form.description} onChange={(v) => setForm({ ...form, description: v })} />
      </Modal>
    </div>
  );
}

// ------------------------------------------------------------------ related records
export interface RelatedRow { link_id: string; type: string; id: string; label: string; relation: string }
export function recordPath(type: string, id: string): string {
  const map: Record<string, string> = {
    task: `/tasks/${id}`, project: `/projects/${id}`, meeting: `/meetings/${id}`, report: `/reports/${id}`, knowledge: `/knowledge/${id}`,
    opportunity: `/opportunities/${id}`, improvement: `/learning/improvements/${id}`, learning: `/learning/records/${id}`,
  };
  return map[type] ?? "#";
}
const TYPE_ICON: Record<string, string> = { task: "tasks", project: "folder", meeting: "meeting", report: "report", knowledge: "book", opportunity: "target", decision: "flag", deliverable: "package", milestone: "milestone", risk: "alert", learning: "lightbulb", improvement: "trending" };

export function RelatedRecords({ entityType, entityId }: { entityType: string; entityId: string }) {
  const { data, loading } = useApi<RelatedRow[]>("/links", { entity_type: entityType, entity_id: entityId });
  if (loading && !data) return <Loading />;
  return (
    <div className="stack">
      <h3>Related records</h3>
      {data && data.length ? (
        <ul className="stack-sm" style={{ listStyle: "none", padding: 0, margin: 0 }}>
          {data.map((r) => (
            <li key={r.link_id} className="row small">
              <Icon name={TYPE_ICON[r.type] ?? "link"} size={14} />
              {recordPath(r.type, r.id) !== "#" ? <Link to={recordPath(r.type, r.id)}>{r.label}</Link> : <span>{r.label}</span>}
              <span className="muted tiny">{humanize(r.type)}</span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="muted small">No related records.</p>
      )}
    </div>
  );
}

// ------------------------------------------------------------------ activity
export interface ActivityRow { id: string; actor_name?: string | null; verb: string; entity_type: string; entity_id: string; entity_label: string; project_id?: string | null; project_name?: string | null; detail?: string; created_at: string }

const VERB_TEXT: Record<string, string> = {
  "task.created": "created task", "task.assigned": "assigned", "task.completed": "completed", "task.reopened": "reopened", "task.status": "updated status of",
  "task.submitted_for_review": "submitted for review", "task.review_approved": "approved", "task.changes_requested": "requested changes on", "task.accepted": "accepted",
  "meeting.created": "created meeting", "meeting.notes_submitted": "submitted notes for", "meeting.approved": "approved meeting", "meeting.processed": "processed notes for",
  "project.created": "created project", "project.update": "posted an update on", "project.status": "changed status of", "project.health": "changed health of",
  "milestone.achieved": "achieved milestone", "milestone.updated": "updated milestone", "deliverable.submitted": "submitted", "deliverable.approved": "approved deliverable",
  "risk.identified": "identified risk", "decision.recorded": "recorded decision", "document.added": "added a document to", "report.generated": "generated", "report.approved": "approved",
  "knowledge.published": "published", "knowledge.submitted": "submitted knowledge item", "opportunity.stage": "moved opportunity",
};
const VERB_ICON: Record<string, string> = { completed: "check", approved: "checkCircle", assigned: "user", created: "plus", submitted: "send", update: "message", identified: "alert", document: "link", generated: "report" };

export function ActivityList({ rows, empty = "No recent activity." }: { rows: ActivityRow[] | null | undefined; empty?: string }) {
  if (!rows || !rows.length) return <EmptyState icon="activity" title={empty} />;
  return (
    <ul className="timeline">
      {rows.map((a) => {
        const verbText = VERB_TEXT[a.verb] ?? a.verb.split(".").pop()!.replace(/_/g, " ");
        const iconKey = Object.keys(VERB_ICON).find((k) => a.verb.includes(k));
        return (
          <li key={a.id}>
            <span className="tl-dot">
              <Icon name={iconKey ? VERB_ICON[iconKey] : "dot"} />
            </span>
            <div style={{ minWidth: 0 }} className="small">
              <div>
                <strong>{a.actor_name ?? "System"}</strong> {verbText}{" "}
                {recordPath(a.entity_type, a.entity_id) !== "#" ? <Link to={recordPath(a.entity_type, a.entity_id)}>{a.entity_label}</Link> : <span>{a.entity_label}</span>}
              </div>
              {a.detail && <div className="muted">{a.detail}</div>}
              <div className="tiny muted">
                {relTime(a.created_at)}
                {a.project_name ? ` · ${a.project_name}` : ""}
              </div>
            </div>
          </li>
        );
      })}
    </ul>
  );
}

export function SectionTitle({ children, meta, action }: { children: React.ReactNode; meta?: React.ReactNode; action?: React.ReactNode }) {
  return (
    <div className="section-head">
      <h2>{children}</h2>
      <div className="row">
        {meta && <span className="meta">{meta}</span>}
        {action}
      </div>
    </div>
  );
}
