import { useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { api } from "../../lib/api";
import { useApi } from "../../lib/hooks";
import { useToast } from "../../lib/app-state";
import {
  AIBadge, Avatar, Badge, Button, Callout, Card, ConfirmDialog, EmptyState, ErrorState, KeyValue, Loading, Modal, PageHeader, RichText, SelectInput, StatusBadge, TextArea, TextInput,
} from "../../components/ui";
import { Comments, DocumentLinks, UserSelect } from "../../components/records";
import { Icon } from "../../components/Icon";
import { fmtDate, fmtDateTime, humanize, plural } from "../../lib/format";
import { TaskList, type TaskRow } from "../tasks/TaskList";
import { TaskFormModal } from "../tasks/TaskFormModal";
import { participantName, timeRange, type MeetingDetailResponse } from "./types";

export default function MeetingDetail() {
  const { id } = useParams();
  const nav = useNavigate();
  const toast = useToast();
  const { data, loading, error, reload } = useApi<MeetingDetailResponse>(`/meetings/${id}`);
  const tasks = useApi<{ items: TaskRow[] }>(id ? "/tasks" : null, { meeting_id: id, scope: "visible" });
  const templates = useApi<{ id: string; name: string; is_default: number }[]>(id ? `/meetings/${id}/report-templates` : null);

  const [busy, setBusy] = useState<string>("");
  const [notesOpen, setNotesOpen] = useState(false);
  const [notesDraft, setNotesDraft] = useState("");
  const [approveOpen, setApproveOpen] = useState(false);
  const [summaryDraft, setSummaryDraft] = useState("");
  const [reportOpen, setReportOpen] = useState(false);
  const [templateId, setTemplateId] = useState("");
  const [decisionOpen, setDecisionOpen] = useState(false);
  const [decision, setDecision] = useState({ title: "", description: "", decision_maker_id: "", status: "made" });
  const [decisionErr, setDecisionErr] = useState<Record<string, string>>({});
  const [taskOpen, setTaskOpen] = useState(false);
  const [cancelOpen, setCancelOpen] = useState(false);

  if (error) return <ErrorState error={error} onRetry={reload} />;
  if (loading && !data) return <Loading />;
  if (!data) return null;
  const { meeting: m, permissions: perm } = data;
  const approved = m.status === "approved";
  const cancelled = m.status === "cancelled";
  const hasNotes = !!(m.notes.trim() || m.transcript.trim());

  const run = async (key: string, fn: () => Promise<unknown>, ok?: string) => {
    setBusy(key);
    try {
      await fn();
      if (ok) toast.success(ok);
      await reload();
      tasks.reload();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy("");
    }
  };

  const process = () =>
    run("process", async () => {
      const r = await api.post<{ count: number; engine: string }>(`/meetings/${id}/process`);
      toast.success(`${plural(r.count, "suggestion")} ready for review (${r.engine === "rules" ? "rule-based" : "AI"})`);
      nav(`/meetings/${id}/review`);
    });

  const openApprove = () => {
    setSummaryDraft(m.summary || "");
    setApproveOpen(true);
  };

  const pendingSummary = data.suggestions.summary;

  return (
    <>
      <PageHeader
        title={m.title}
        breadcrumbs={[{ label: "Meetings", to: "/meetings" }, ...(m.project_name ? [{ label: m.project_name, to: `/projects/${m.project_id}` }] : []), { label: m.title }]}
        subtitle={
          <span className="row">
            <StatusBadge kind="meeting" value={m.status} />
            {m.confidential ? <Badge icon="lock">Confidential</Badge> : null}
            <span>{fmtDate(m.meeting_date, { year: true })}{timeRange(m) ? ` · ${timeRange(m)}` : ""} · {m.meeting_type}</span>
          </span>
        }
        actions={
          <>
            {perm.can_manage && !cancelled && <Button icon="edit" onClick={() => nav(`/meetings/${id}/edit`)}>Edit</Button>}
            {perm.can_submit_notes && !approved && !cancelled && (
              <Button icon="file" onClick={() => { setNotesDraft(m.notes); setNotesOpen(true); }}>{hasNotes ? "Update notes" : "Submit notes"}</Button>
            )}
            {perm.can_process && !approved && !cancelled && hasNotes && (
              <Button variant="ai" icon="sparkles" loading={busy === "process"} onClick={process}>Extract actions & decisions</Button>
            )}
            {perm.can_manage && data.suggestions.pending > 0 && <Button variant="ai" onClick={() => nav(`/meetings/${id}/review`)}>Review {plural(data.suggestions.pending, "suggestion")}</Button>}
            {perm.can_approve && !approved && !cancelled && <Button variant="primary" icon="checkCircle" onClick={openApprove}>Approve record</Button>}
            {perm.can_generate_report && (
              <Button variant="primary" icon="report" onClick={() => { setTemplateId(templates.data?.find((t) => t.is_default)?.id ?? ""); setReportOpen(true); }}>Generate call report</Button>
            )}
          </>
        }
      />

      {m.status === "in_review" && data.suggestions.pending > 0 && perm.can_manage && (
        <div className="mb-3">
          <Callout tone="ai" icon="sparkles">
            {plural(data.suggestions.pending, "suggestion")} from the notes are waiting for your review. Nothing has been assigned or recorded yet. <Link to={`/meetings/${id}/review`}>Open the review screen</Link>.
          </Callout>
        </div>
      )}
      {cancelled && <div className="mb-3"><Callout tone="warn" icon="ban">This meeting was cancelled.</Callout></div>}

      <div className="cols-main-side">
        <div className="stack">
          <Card title={<div className="stack-sm" style={{ gap: 2 }}><span className="mtg-record-label">Meeting record</span><h2>Details</h2></div>}>
            <KeyValue
              items={[
                ["When", `${fmtDate(m.meeting_date, { year: true })}${timeRange(m) ? `, ${timeRange(m)}` : ""} (${m.timezone})`],
                ["Organiser", m.organiser_name],
                ["Project", m.project_id ? <Link to={`/projects/${m.project_id}`}>{m.project_name}</Link> : null],
                ["Programme", m.programme_name],
                ["Location", m.location || null],
                ["Meeting link", m.meeting_link ? <a href={m.meeting_link} target="_blank" rel="noopener noreferrer">{m.meeting_link} <Icon name="external" size={12} /></a> : null],
                ["Purpose", m.purpose || null],
                ["Follow-up", m.follow_up_date ? fmtDate(m.follow_up_date, { year: true }) : null],
                ...(m.preparation_required ? ([["Preparation", <span className="due-today">{m.preparation_notes || "Required"}</span>]] as [string, React.ReactNode][]) : []),
                ["Approval", approved ? `Approved by ${m.approved_by_name ?? "—"} · ${fmtDateTime(m.approved_at)}` : <span className="muted">Not yet approved</span>],
              ]}
            />
            {approved && perm.can_manage && (
              <div className="mt-2">
                <Button size="sm" variant="ghost" icon="refresh" loading={busy === "reopen"} onClick={() => run("reopen", () => api.post(`/meetings/${id}/reopen`), "Meeting reopened for corrections")}>Reopen record</Button>
              </div>
            )}
          </Card>

          <Card
            title={<div className="stack-sm" style={{ gap: 2 }}><span className="mtg-record-label">Meeting record</span><h2>Summary</h2></div>}
            actions={m.summary ? <Badge tone={m.summary_source === "ai_approved" ? "ai" : "neutral"} icon={m.summary_source === "ai_approved" ? "sparkles" : "user"}>{m.summary_source === "ai_approved" ? "Generated, approved by a person" : "Written by a person"}</Badge> : undefined}
          >
            {m.summary ? <RichText text={m.summary} /> : <p className="muted small">No approved summary yet. {perm.can_manage && !approved ? "Write one when approving the record, or accept a suggested summary." : ""}</p>}
            {m.key_points && (
              <>
                <h3 className="mt-2 mb-1">Key points & follow-ups</h3>
                <RichText text={m.key_points} />
              </>
            )}
            {pendingSummary && (
              <div className="ai-panel card-pad mt-2">
                <div className="row-between mb-1">
                  <span className="ai-label"><Icon name="sparkles" size={14} /> Suggested summary — not part of the record</span>
                  <AIBadge engine={pendingSummary.engine} />
                </div>
                <p className="small">{String(pendingSummary.payload.text ?? "")}</p>
                {perm.can_manage && <Link className="small" to={`/meetings/${id}/review`}>Review suggestion</Link>}
              </div>
            )}
          </Card>

          <Card title={<div className="stack-sm" style={{ gap: 2 }}><span className="mtg-record-label">Submitted content</span><h2>Notes</h2></div>}>
            {m.notes ? <div className="mtg-notes" tabIndex={0} aria-label="Submitted notes">{m.notes}</div> : <EmptyState icon="file" title="No notes submitted">{perm.can_submit_notes && !approved ? "Participants can submit notes after the meeting." : undefined}</EmptyState>}
          </Card>

          {m.transcript && (
            <Card
              title={<div className="stack-sm" style={{ gap: 2 }}><span className="mtg-record-label">Imported content</span><h2>Transcript</h2></div>}
              actions={<Badge icon="upload">{m.transcript_source.startsWith("uploaded:") ? `Uploaded: ${m.transcript_source.slice(9)}` : "Pasted"}</Badge>}
            >
              <p className="small muted">Imported transcript, kept separate from the approved meeting record.</p>
              <div className="mtg-transcript" tabIndex={0} aria-label="Imported transcript">{m.transcript}</div>
            </Card>
          )}

          <Card
            title={`Action items (${tasks.data?.items.length ?? data.tasks.length})`}
            actions={perm.can_manage && !cancelled ? <Button size="sm" icon="plus" onClick={() => setTaskOpen(true)}>Add action</Button> : undefined}
            pad={false}
          >
            {tasks.loading && !tasks.data ? (
              <Loading />
            ) : (
              <TaskList
                tasks={tasks.data?.items ?? []}
                onChanged={() => { tasks.reload(); reload(); }}
                showProject={false}
                showAssignee
                emptyTitle="No actions yet"
                emptyText={perm.can_manage ? "Extract actions from the notes, or add one manually." : "Actions confirmed from this meeting will appear here."}
              />
            )}
          </Card>

          <Card title={`Decisions (${data.decisions.length})`} actions={perm.can_manage && !cancelled ? <Button size="sm" icon="plus" onClick={() => setDecisionOpen(true)}>Record decision</Button> : undefined} pad={false}>
            {data.decisions.length ? (
              <div className="list">
                {data.decisions.map((d) => (
                  <div className="list-item" key={d.id}>
                    <Icon name="flag" />
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div className="title">{d.title}</div>
                      {d.description && <div className="small muted">{d.description}</div>}
                      <div className="meta">{d.decision_maker_name && <span>{d.decision_maker_name}</span>}{d.decision_date && <span>{fmtDate(d.decision_date)}</span>}</div>
                    </div>
                    <StatusBadge kind="decision" value={d.status} />
                  </div>
                ))}
              </div>
            ) : (
              <EmptyState icon="flag" title="No decisions recorded" />
            )}
          </Card>

          {data.risks.length > 0 && (
            <Card title={`Risks & blockers (${data.risks.length})`} pad={false}>
              <div className="list">
                {data.risks.map((r) => (
                  <div className="list-item" key={r.id}>
                    <Icon name="alert" />
                    <div style={{ flex: 1 }}>
                      <div className="title">{r.title}</div>
                      <div className="meta"><span>{humanize(r.type)}</span></div>
                    </div>
                    <StatusBadge kind="severity" value={r.severity} />
                    <StatusBadge kind="risk" value={r.status} />
                  </div>
                ))}
              </div>
            </Card>
          )}

          <Card><Comments entityType="meeting" entityId={m.id} /></Card>
        </div>

        <aside className="stack">
          <Card title={`Participants (${data.participants.length})`}>
            {data.participants.length ? (
              data.participants.map((p) => (
                <div className="mtg-participant" key={p.id}>
                  <Avatar name={participantName(p)} size="sm" />
                  <span style={{ flex: 1 }}>{participantName(p)}</span>
                  {!p.user_id && <Badge>External</Badge>}
                  {p.attendance === "apologies" && <Badge tone="warn">Apologies</Badge>}
                </div>
              ))
            ) : (
              <p className="muted small">No participants recorded.</p>
            )}
          </Card>

          <Card title="Reports">
            {data.reports.length ? (
              <ul className="stack-sm" style={{ listStyle: "none", margin: 0, padding: 0 }}>
                {data.reports.map((r) => (
                  <li key={r.id} className="row-between small">
                    <Link to={`/reports/${r.id}`}>{r.title}</Link>
                    <StatusBadge kind="report" value={r.status} />
                  </li>
                ))}
              </ul>
            ) : (
              <p className="muted small">{approved ? "No call report yet." : "A call report can be generated once the meeting record is approved."}</p>
            )}
          </Card>

          <Card><DocumentLinks entityType="meeting" entityId={m.id} canEdit={perm.can_submit_notes && !cancelled} /></Card>

          {m.project_id && (
            <Card title="Meeting history">
              {data.completed_since_last.length > 0 && (
                <div className="mb-2">
                  <h3 className="small mb-1">Completed since the last meeting</h3>
                  <ul className="small" style={{ margin: 0, paddingLeft: 18 }}>
                    {data.completed_since_last.map((t) => (
                      <li key={t.id}><Link to={`/tasks/${t.id}`}>{t.title}</Link>{t.assignee_name ? ` — ${t.assignee_name}` : ""}</li>
                    ))}
                  </ul>
                </div>
              )}
              {data.history.length ? (
                <div className="mtg-history">
                  {data.history.map((h) => (
                    <div className="mtg-history-item" key={h.id}>
                      <div className="row small">
                        <Link to={`/meetings/${h.id}`} className="strong">{h.title}</Link>
                        <span className="muted tiny">{fmtDate(h.meeting_date)}</span>
                      </div>
                      {h.decisions.length > 0 && <div className="tiny muted">Decisions: {h.decisions.map((d) => d.title).join("; ")}</div>}
                      {h.outstanding_actions.length > 0 ? (
                        <ul className="tiny" style={{ margin: "4px 0 0", paddingLeft: 16 }}>
                          {h.outstanding_actions.map((t) => (
                            <li key={t.id}><Link to={`/tasks/${t.id}`}>{t.title}</Link> <span className="muted">({t.assignee_name ?? "unassigned"}{t.due_date ? `, due ${fmtDate(t.due_date)}` : ""})</span></li>
                          ))}
                        </ul>
                      ) : (
                        <div className="tiny muted">No outstanding actions.</div>
                      )}
                    </div>
                  ))}
                </div>
              ) : (
                <p className="muted small">No earlier meetings for this project.</p>
              )}
            </Card>
          )}

          {perm.can_manage && !cancelled && !approved && (
            <Button variant="danger" icon="ban" onClick={() => setCancelOpen(true)}>Cancel meeting</Button>
          )}
        </aside>
      </div>

      {/* --- submit notes */}
      <Modal
        open={notesOpen}
        onClose={() => setNotesOpen(false)}
        title="Submit meeting notes"
        wide
        footer={
          <>
            <Button onClick={() => setNotesOpen(false)}>Cancel</Button>
            <Button variant="primary" loading={busy === "notes"} disabled={!notesDraft.trim()} onClick={() => run("notes", () => api.post(`/meetings/${id}/notes`, { notes: notesDraft }), "Notes submitted").then(() => setNotesOpen(false))}>Submit notes</Button>
          </>
        }
      >
        <TextArea label="Notes" rows={14} value={notesDraft} onChange={setNotesDraft} hint="Use “Action:”, “Decision:”, “Risk:” or “Name to …” so items can be recognised. To add a transcript or upload a file, use Edit." />
      </Modal>

      {/* --- approve */}
      <Modal
        open={approveOpen}
        onClose={() => setApproveOpen(false)}
        title="Approve meeting record"
        footer={
          <>
            <Button onClick={() => setApproveOpen(false)}>Cancel</Button>
            <Button variant="primary" loading={busy === "approve"} onClick={() => run("approve", () => api.post(`/meetings/${id}/approve`, { summary: summaryDraft }), "Meeting record approved").then(() => setApproveOpen(false))}>Approve</Button>
          </>
        }
      >
        <p className="small">Approving confirms this is an accurate record. Only approved content is used in call reports and project reporting.</p>
        {data.suggestions.pending > 0 && <div className="mb-2"><Callout tone="warn" icon="alert">{plural(data.suggestions.pending, "suggestion")} have not been reviewed. They will be excluded unless you review them first.</Callout></div>}
        <TextArea label="Approved summary" rows={6} value={summaryDraft} onChange={setSummaryDraft} hint="This is the human-approved summary of the meeting." />
        {!summaryDraft && pendingSummary && (
          <Button size="sm" variant="ai" icon="sparkles" onClick={() => setSummaryDraft(String(pendingSummary.payload.text ?? ""))}>Start from the suggested summary</Button>
        )}
      </Modal>

      {/* --- call report */}
      <Modal
        open={reportOpen}
        onClose={() => setReportOpen(false)}
        title="Generate call report"
        footer={
          <>
            <Button onClick={() => setReportOpen(false)}>Cancel</Button>
            <Button
              variant="primary"
              loading={busy === "report"}
              onClick={async () => {
                setBusy("report");
                try {
                  const r = await api.post<{ id: string }>(`/meetings/${id}/call-report`, { template_id: templateId });
                  toast.success("Draft call report created");
                  nav(`/reports/${r.id}`);
                } catch (e) {
                  toast.error((e as Error).message);
                } finally {
                  setBusy("");
                }
              }}
            >
              Generate draft
            </Button>
          </>
        }
      >
        <p className="small">The report is built only from the approved meeting record: summary, decisions, confirmed actions, risks and linked documents. It starts as a draft for you to edit and submit for review.</p>
        <SelectInput label="Template" value={templateId} onChange={setTemplateId} placeholder="Default template" options={(templates.data ?? []).map((t) => ({ value: t.id, label: t.name }))} />
      </Modal>

      {/* --- decision */}
      <Modal
        open={decisionOpen}
        onClose={() => setDecisionOpen(false)}
        title="Record a decision"
        footer={
          <>
            <Button onClick={() => setDecisionOpen(false)}>Cancel</Button>
            <Button
              variant="primary"
              loading={busy === "decision"}
              onClick={async () => {
                if (!decision.title.trim()) return setDecisionErr({ title: "Describe the decision." });
                setBusy("decision");
                try {
                  await api.post(`/meetings/${id}/decisions`, decision);
                  toast.success("Decision recorded");
                  setDecisionOpen(false);
                  setDecision({ title: "", description: "", decision_maker_id: "", status: "made" });
                  setDecisionErr({});
                  reload();
                } catch (e) {
                  const x = e as { message: string; fields?: Record<string, string> };
                  setDecisionErr(x.fields ?? {});
                  toast.error(x.message);
                } finally {
                  setBusy("");
                }
              }}
            >
              Save decision
            </Button>
          </>
        }
      >
        <TextInput label="Decision" required value={decision.title} onChange={(v) => setDecision({ ...decision, title: v })} error={decisionErr.title} />
        <TextArea label="Details" rows={3} value={decision.description} onChange={(v) => setDecision({ ...decision, description: v })} />
        <UserSelect label="Decision maker" value={decision.decision_maker_id} onChange={(v) => setDecision({ ...decision, decision_maker_id: v })} placeholder="Not specified" />
        <SelectInput
          label="Status"
          value={decision.status}
          onChange={(v) => setDecision({ ...decision, status: v })}
          options={[{ value: "made", label: "Decision made" }, { value: "proposed", label: "Proposed (not yet decided)" }, { value: "pending_approval", label: "Needs approval" }]}
          hint="Only record “Decision made” for things that were actually decided."
        />
      </Modal>

      <TaskFormModal
        open={taskOpen}
        onClose={() => setTaskOpen(false)}
        onSaved={() => { setTaskOpen(false); tasks.reload(); reload(); }}
        defaults={{ meeting_id: m.id, project_id: m.project_id ?? undefined, source: "meeting" }}
      />

      <ConfirmDialog
        open={cancelOpen}
        title="Cancel this meeting?"
        message="Participants will be notified that the meeting is cancelled. The record is kept."
        confirmLabel="Cancel meeting"
        danger
        busy={busy === "cancel"}
        onClose={() => setCancelOpen(false)}
        onConfirm={() => run("cancel", () => api.del(`/meetings/${id}`), "Meeting cancelled").then(() => setCancelOpen(false))}
      />
    </>
  );
}
