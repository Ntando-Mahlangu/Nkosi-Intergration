/**
 * Report document view + workflow, shared by call reports, project reports and Fakawe digests.
 */
import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { api, downloadUrl } from "../../lib/api";
import { useApi } from "../../lib/hooks";
import { useAuth, useToast } from "../../lib/app-state";
import { AIBadge, Badge, Button, Callout, Card, ErrorState, Loading, Modal, PageHeader, RichText, SelectInput, StatusBadge, TextArea, TextInput } from "../../components/ui";
import { Comments, UserSelect, recordPath } from "../../components/records";
import { Icon } from "../../components/Icon";
import { fmtDate, fmtDateTime, humanize, relTime } from "../../lib/format";
import "./detail/report-detail.css";

interface Source { type: string; id: string; label: string; visible?: boolean }
interface Section { key: string; title: string; body?: string; items?: string[]; sources?: Source[] }
interface Perms { can_edit: boolean; can_submit: boolean; can_review: boolean; can_return_to_draft: boolean; can_finalise: boolean; can_publish: boolean; can_archive: boolean }
export interface ReportFull {
  id: string;
  report_type: "call_report" | "fakawe" | "project_report" | string;
  title: string;
  status: string;
  audience: string;
  version: number;
  generated_by: string;
  meeting_id: string | null;
  meeting_title: string | null;
  meeting_date: string | null;
  meeting_visible: boolean;
  project_id: string | null;
  project_name: string | null;
  period_id: string | null;
  period_name: string | null;
  template_name: string | null;
  author_name: string | null;
  reviewer_id: string | null;
  reviewer_name: string | null;
  approved_by_name: string | null;
  approved_at: string | null;
  review_note: string;
  content: { sections: Section[] };
  source_records: Source[];
  quality_flags: string[];
  versions: number;
  history: { from_value: string | null; to_value: string; note: string; changed_at: string; changed_by_name: string | null }[];
  minutes_saved_estimate: number | null;
  created_at: string;
  updated_at: string;
  permissions: Perms;
}
interface VersionRow { id: string; version: number; status: string; change_note: string; created_at: string; changed_by_name: string | null }

const TYPE_LABEL: Record<string, string> = { call_report: "Call report", fakawe: "Fakawe digest", project_report: "Project report" };
const AUDIENCE: Record<string, string> = { participants: "Meeting participants", project: "Project team", management: "Management", all_staff: "All staff" };

function SectionView({ s }: { s: Section }) {
  const empty = !s.body && !(s.items && s.items.length);
  return (
    <section>
      <h2>{s.title}</h2>
      {s.body && <RichText text={s.body} />}
      {s.items && s.items.length > 0 && (
        <ul>
          {s.items.map((it, i) => <li key={i}>{it}</li>)}
        </ul>
      )}
      {empty && <p className="muted small">Nothing recorded.</p>}
      {s.sources && s.sources.length > 0 && (
        <div className="rpt-sources no-print">
          <span className="tiny muted">Sources:</span>
          {s.sources.map((src, i) =>
            src.visible && recordPath(src.type, src.id) !== "#" ? (
              <Link key={i} className="tag" to={recordPath(src.type, src.id)}>{src.label}</Link>
            ) : (
              <span key={i} className="tag" title={src.visible ? humanize(src.type) : "You don't have access to this record"}>{src.visible === false ? <><Icon name="lock" size={10} /> Restricted</> : src.label}</span>
            ),
          )}
        </div>
      )}
    </section>
  );
}

export default function ReportDetail() {
  const { id } = useParams();
  const toast = useToast();
  const { me } = useAuth();
  const { data: r, error, loading, reload, setData } = useApi<ReportFull>(`/reports/${id}`);
  const versions = useApi<VersionRow[]>(id ? `/reports/${id}/versions` : null);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<{ title: string; sections: (Section & { itemsText: string })[]; change_note: string } | null>(null);
  const [busy, setBusy] = useState("");
  const [modal, setModal] = useState<"" | "submit" | "request_changes" | "publish" | "approve">("");
  const [note, setNote] = useState("");
  const [reviewer, setReviewer] = useState("");
  const [audience, setAudience] = useState("management");
  const [viewVersion, setViewVersion] = useState<{ version: number; status: string; change_note: string; created_at: string; content: { sections: Section[] } } | null>(null);

  useEffect(() => {
    if (r) setAudience(r.report_type === "fakawe" ? (r.audience === "participants" ? "management" : r.audience) : r.audience);
  }, [r]);

  if (error) return <ErrorState error={error} onRetry={reload} />;
  if (loading && !r) return <Loading />;
  if (!r) return null;
  const p = r.permissions;

  const startEdit = () => {
    setDraft({ title: r.title, change_note: "", sections: r.content.sections.map((s) => ({ ...s, itemsText: (s.items ?? []).join("\n") })) });
    setEditing(true);
  };

  const saveEdit = async () => {
    if (!draft) return;
    if (!draft.title.trim()) return toast.error("The report needs a title.");
    setBusy("save");
    try {
      const updated = await api.patch<ReportFull>(`/reports/${id}`, {
        title: draft.title,
        change_note: draft.change_note,
        sections: draft.sections.map((s) => ({
          key: s.key,
          title: s.title,
          body: s.body ?? "",
          items: s.itemsText.split(/\r?\n/).map((l) => l.trim()).filter(Boolean),
        })),
      });
      setData(updated);
      setEditing(false);
      versions.reload();
      toast.success(`Saved as version ${updated.version}`);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy("");
    }
  };

  const transition = async (action: string, extra: Record<string, unknown> = {}) => {
    setBusy(action);
    try {
      const updated = await api.post<ReportFull>(`/reports/${id}/transition`, { action, ...extra });
      setData(updated);
      versions.reload();
      setModal("");
      setNote("");
      toast.success(
        { submit: "Submitted for review", approve: "Report approved", request_changes: "Changes requested", return_to_draft: "Returned to draft", finalise: "Report finalised", publish: "Report published", archive: "Report archived" }[action] ?? "Updated",
      );
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy("");
    }
  };

  const printPdf = () => {
    const w = window.open(downloadUrl(`/reports/${id}/export`, { format: "html" }), "_blank");
    if (!w) return toast.error("Allow pop-ups to open the print view.");
    w.addEventListener("load", () => {
      try {
        w.focus();
        w.print();
      } catch {
        /* user can print manually */
      }
    });
  };

  const gdoc = async () => {
    try {
      await api.get(`/reports/${id}/export`, { format: "gdoc" });
    } catch (e) {
      toast.error((e as Error).message);
    }
  };

  const openVersion = async (v: number) => {
    try {
      setViewVersion(await api.get(`/reports/${id}/versions/${v}`));
    } catch (e) {
      toast.error((e as Error).message);
    }
  };

  const generatedBadge =
    r.generated_by.startsWith("anthropic") || r.generated_by === "rules" ? <AIBadge engine={r.generated_by} /> : <Badge icon="layers" title="Assembled from approved records — no AI involved">Assembled from records</Badge>;
  const isDraft = ["draft", "in_review", "changes_requested"].includes(r.status);

  return (
    <>
      <PageHeader
        title={r.title}
        breadcrumbs={[
          { label: "Reports & Fakawe", to: "/reports" },
          ...(r.meeting_id && r.meeting_visible ? [{ label: r.meeting_title ?? "Meeting", to: `/meetings/${r.meeting_id}` }] : []),
          ...(r.project_id && !r.meeting_id ? [{ label: r.project_name ?? "Project", to: `/projects/${r.project_id}` }] : []),
          { label: TYPE_LABEL[r.report_type] ?? "Report" },
        ]}
        subtitle={
          <span className="row">
            <StatusBadge kind="report" value={r.status} />
            <span>{TYPE_LABEL[r.report_type] ?? "Report"} · version {r.version}</span>
            {generatedBadge}
          </span>
        }
        actions={
          !editing && (
            <>
              {p.can_edit && <Button icon="edit" onClick={startEdit}>Edit</Button>}
              {p.can_submit && <Button variant="primary" icon="send" onClick={() => { setReviewer(r.reviewer_id ?? ""); setModal("submit"); }}>Submit for review</Button>}
              {p.can_review && <Button icon="edit" onClick={() => setModal("request_changes")}>Request changes</Button>}
              {p.can_review && <Button variant="primary" icon="checkCircle" onClick={() => setModal("approve")}>Approve</Button>}
              {p.can_finalise && r.status === "approved" && <Button loading={busy === "finalise"} onClick={() => transition("finalise")}>Finalise</Button>}
              {p.can_publish && <Button variant="primary" icon="send" onClick={() => setModal("publish")}>Publish</Button>}
              {p.can_return_to_draft && <Button variant="ghost" icon="refresh" loading={busy === "return_to_draft"} onClick={() => transition("return_to_draft")}>Return to draft</Button>}
              {p.can_archive && <Button variant="ghost" icon="archive" loading={busy === "archive"} onClick={() => transition("archive")}>Archive</Button>}
            </>
          )
        }
      />

      <div className="stack mb-3">
        {r.quality_flags.length > 0 && (
          <Callout tone="warn" icon="alert">
            <strong>Review before relying on this report:</strong>
            <ul className="rpt-flags">
              {r.quality_flags.map((f, i) => <li key={i}>{f}</li>)}
            </ul>
          </Callout>
        )}
        {r.status === "changes_requested" && r.review_note && (
          <Callout tone="danger" icon="edit"><strong>Changes requested:</strong> {r.review_note}</Callout>
        )}
        {isDraft && <Callout tone="neutral" icon="info">This report is a draft until it is approved. Do not distribute it yet.</Callout>}
      </div>

      <div className="cols-main-side">
        <div className="stack">
          {editing && draft ? (
            <Card
              title="Edit report"
              footer={
                <>
                  <Button onClick={() => setEditing(false)}>Cancel</Button>
                  <Button variant="primary" loading={busy === "save"} onClick={saveEdit}>Save new version</Button>
                </>
              }
            >
              <TextInput label="Title" required value={draft.title} onChange={(v) => setDraft({ ...draft, title: v })} />
              {draft.sections.map((s, i) => (
                <fieldset key={s.key}>
                  <legend>{s.title}</legend>
                  <TextInput
                    label="Section heading"
                    value={s.title}
                    onChange={(v) => setDraft({ ...draft, sections: draft.sections.map((x, j) => (j === i ? { ...x, title: v } : x)) })}
                  />
                  <TextArea label="Text" rows={3} value={s.body ?? ""} onChange={(v) => setDraft({ ...draft, sections: draft.sections.map((x, j) => (j === i ? { ...x, body: v } : x)) })} />
                  <TextArea
                    label="List items (one per line)"
                    rows={Math.min(8, Math.max(2, s.itemsText.split("\n").length))}
                    value={s.itemsText}
                    onChange={(v) => setDraft({ ...draft, sections: draft.sections.map((x, j) => (j === i ? { ...x, itemsText: v } : x)) })}
                  />
                  <Button
                    size="sm"
                    variant="ghost"
                    icon="trash"
                    onClick={() => setDraft({ ...draft, sections: draft.sections.filter((_, j) => j !== i) })}
                  >
                    Remove section
                  </Button>
                </fieldset>
              ))}
              <Button
                size="sm"
                icon="plus"
                onClick={() => setDraft({ ...draft, sections: [...draft.sections, { key: `custom_${Date.now()}`, title: "Additional notes", body: "", itemsText: "" }] })}
              >
                Add section
              </Button>
              <TextInput className="mt-2" label="Change note" value={draft.change_note} onChange={(v) => setDraft({ ...draft, change_note: v })} placeholder="What did you change?" />
            </Card>
          ) : (
            <article className="doc" aria-label="Report document">
              <div className="doc-header">
                <div>
                  <div className="rpt-org">{me?.org.name ?? "Change Science Institute"}</div>
                  <div className="rpt-type">{TYPE_LABEL[r.report_type] ?? "Report"}</div>
                  <h1 className="rpt-title">{r.title}</h1>
                </div>
                <div className="tiny muted" style={{ textAlign: "right" }}>
                  {r.meeting_date && <div>Meeting date: {fmtDate(r.meeting_date, { year: true })}</div>}
                  <div>Version {r.version}</div>
                  <div>{r.approved_by_name ? `Approved by ${r.approved_by_name}, ${fmtDate(r.approved_at, { year: true })}` : "Not yet approved"}</div>
                </div>
              </div>
              {r.content.sections.length ? r.content.sections.map((s) => <SectionView key={s.key} s={s} />) : <p className="muted">This report has no sections.</p>}
            </article>
          )}
          <Card><Comments entityType="report" entityId={r.id} title="Review comments" /></Card>
        </div>

        <aside className="stack no-print">
          <Card title="Export">
            <div className="stack-sm">
              <Button icon="print" onClick={printPdf}>Export PDF (print view)</Button>
              <a className="btn" href={downloadUrl(`/reports/${id}/export`, { format: "html", download: 1 })}><Icon name="download" size={16} /> Download HTML</a>
              <a className="btn" href={downloadUrl(`/reports/${id}/export`, { format: "md" })}><Icon name="download" size={16} /> Download Markdown</a>
              <Button icon="file" onClick={gdoc}>Create Google Doc</Button>
              {isDraft && <p className="tiny muted">Exports of unapproved reports are marked as drafts.</p>}
            </div>
          </Card>

          <Card title="Details">
            <dl className="kv">
              <dt>Author</dt><dd>{r.author_name ?? "—"}</dd>
              <dt>Reviewer</dt><dd>{r.reviewer_name ?? <span className="muted">Not assigned</span>}</dd>
              <dt>Audience</dt><dd>{AUDIENCE[r.audience] ?? humanize(r.audience)}</dd>
              {r.meeting_id && <><dt>Meeting</dt><dd>{r.meeting_visible ? <Link to={`/meetings/${r.meeting_id}`}>{r.meeting_title}</Link> : <span className="muted">Restricted</span>}</dd></>}
              {r.project_id && <><dt>Project</dt><dd><Link to={`/projects/${r.project_id}`}>{r.project_name}</Link></dd></>}
              {r.period_id && <><dt>Period</dt><dd>{r.period_name}</dd></>}
              {r.template_name && <><dt>Template</dt><dd>{r.template_name}</dd></>}
              <dt>Updated</dt><dd>{relTime(r.updated_at)}</dd>
              {r.minutes_saved_estimate ? <><dt>Time saved</dt><dd>~{r.minutes_saved_estimate} min (estimate)</dd></> : null}
            </dl>
          </Card>

          {r.source_records.length > 0 && (
            <Card title="Source records">
              <ul className="stack-sm" style={{ listStyle: "none", margin: 0, padding: 0 }}>
                {r.source_records.map((s, i) => (
                  <li key={i} className="small row">
                    <Icon name="link" size={12} />
                    {s.visible && recordPath(s.type, s.id) !== "#" ? <Link to={recordPath(s.type, s.id)}>{s.label}</Link> : <span className={s.visible === false ? "muted" : ""}>{s.label}</span>}
                    <span className="tiny muted">{humanize(s.type)}</span>
                  </li>
                ))}
              </ul>
            </Card>
          )}

          <Card title={`Versions (${r.versions})`}>
            {versions.data?.length ? (
              <ul className="stack-sm" style={{ listStyle: "none", margin: 0, padding: 0 }}>
                {versions.data.map((v) => (
                  <li key={v.id} className="row-between small">
                    <button className="btn btn-ghost btn-sm" onClick={() => openVersion(v.version)}>v{v.version} · {v.change_note || humanize(v.status)}</button>
                    <span className="tiny muted">{v.changed_by_name ?? "—"} · {relTime(v.created_at)}</span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="muted small">No saved versions.</p>
            )}
          </Card>

          {r.history.length > 0 && (
            <Card title="Workflow history">
              <ul className="timeline">
                {r.history.map((h, i) => (
                  <li key={i}>
                    <span className="tl-dot"><Icon name="dot" /></span>
                    <div className="small">
                      <div><strong>{h.changed_by_name ?? "System"}</strong> → {humanize(h.to_value)}</div>
                      {h.note && <div className="muted">{h.note}</div>}
                      <div className="tiny muted">{fmtDateTime(h.changed_at)}</div>
                    </div>
                  </li>
                ))}
              </ul>
            </Card>
          )}
        </aside>
      </div>

      <Modal
        open={modal === "submit"}
        onClose={() => setModal("")}
        title="Submit for review"
        footer={<><Button onClick={() => setModal("")}>Cancel</Button><Button variant="primary" loading={busy === "submit"} onClick={() => transition("submit", { reviewer_id: reviewer, note })}>Submit</Button></>}
      >
        <UserSelect label="Reviewer" value={reviewer} onChange={setReviewer} placeholder={r.report_type === "fakawe" ? "Period approver (default)" : "Project owner / organiser (default)"} hint="The reviewer is notified. Reviewers must have permission to see the report." />
        <TextArea label="Note to reviewer" rows={2} value={note} onChange={setNote} />
      </Modal>
      <Modal
        open={modal === "approve"}
        onClose={() => setModal("")}
        title="Approve report"
        footer={<><Button onClick={() => setModal("")}>Cancel</Button><Button variant="primary" loading={busy === "approve"} onClick={() => transition("approve", { note })}>Approve</Button></>}
      >
        <p className="small">Approving confirms the content is accurate. {r.quality_flags.length ? "Please check the quality flags first." : ""}</p>
        <TextArea label="Note (optional)" rows={2} value={note} onChange={setNote} />
      </Modal>
      <Modal
        open={modal === "request_changes"}
        onClose={() => setModal("")}
        title="Request changes"
        footer={<><Button onClick={() => setModal("")}>Cancel</Button><Button variant="primary" loading={busy === "request_changes"} disabled={!note.trim()} onClick={() => transition("request_changes", { note })}>Send back</Button></>}
      >
        <TextArea label="What needs to change?" required rows={4} value={note} onChange={setNote} />
      </Modal>
      <Modal
        open={modal === "publish"}
        onClose={() => setModal("")}
        title="Publish report"
        footer={<><Button onClick={() => setModal("")}>Cancel</Button><Button variant="primary" loading={busy === "publish"} onClick={() => transition("publish", { audience })}>Publish</Button></>}
      >
        <SelectInput
          label="Audience"
          value={audience}
          onChange={setAudience}
          options={Object.entries(AUDIENCE).map(([value, label]) => ({ value, label }))}
          hint={r.report_type === "fakawe" ? "“All staff” makes the digest visible to everyone and searchable in the Knowledge Hub." : "Visibility still follows access to the meeting/project."}
        />
        <p className="small muted">Publishing doesn't email anyone. Share the link with the intended recipients.</p>
      </Modal>
      <Modal open={!!viewVersion} onClose={() => setViewVersion(null)} title={viewVersion ? `Version ${viewVersion.version} · ${humanize(viewVersion.status)}` : ""} wide>
        {viewVersion && (
          <>
            <p className="tiny muted">{viewVersion.change_note} · {fmtDateTime(viewVersion.created_at)}</p>
            <div className="doc" style={{ padding: 20 }}>
              {viewVersion.content.sections.map((s) => <SectionView key={s.key} s={s} />)}
            </div>
          </>
        )}
      </Modal>
    </>
  );
}
