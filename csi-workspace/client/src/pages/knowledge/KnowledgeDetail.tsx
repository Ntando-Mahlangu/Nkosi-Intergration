import { useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { api } from "../../lib/api";
import { useApi } from "../../lib/hooks";
import { useLookups, useToast } from "../../lib/app-state";
import { fmtDate, fmtDateTime, humanize } from "../../lib/format";
import { Badge, Button, Callout, Card, ConfirmDialog, ErrorState, KeyValue, Loading, Modal, PageHeader, PersonChip, RichText, StatusBadge, Tags, TextArea, TextInput } from "../../components/ui";
import { Comments, DocumentLinks, RelatedRecords, recordPath } from "../../components/records";
import { Icon } from "../../components/Icon";
import { ACCESS_LABEL, ITEM_TYPE_LABEL, type KnowledgeDetailResponse } from "./types";

interface VersionRow { version: number; title: string; summary: string; body: string; changed_at: string; changed_by_name: string | null }

export default function KnowledgeDetail() {
  const { id } = useParams();
  const nav = useNavigate();
  const toast = useToast();
  const { lookups } = useLookups();
  const { data, error, loading, reload } = useApi<KnowledgeDetailResponse>(`/knowledge/${id}`);
  const [busy, setBusy] = useState("");
  const [returnOpen, setReturnOpen] = useState(false);
  const [returnNote, setReturnNote] = useState("");
  const [returnErr, setReturnErr] = useState("");
  const [archiveOpen, setArchiveOpen] = useState(false);
  const [reviewOpen, setReviewOpen] = useState(false);
  const [nextReview, setNextReview] = useState("");
  const [reviewErr, setReviewErr] = useState("");
  const [version, setVersion] = useState<VersionRow | null>(null);
  const [grantPick, setGrantPick] = useState("");

  if (loading && !data) return <Loading />;
  if (error || !data) return <ErrorState error={error ?? "Not found"} onRetry={reload} />;
  const { item: k, permissions: p } = data;

  const act = async (key: string, path: string, body: object = {}, msg = "Updated") => {
    setBusy(key);
    try {
      await api.post(`/knowledge/${k.id}/${path}`, body);
      toast.success(msg);
      await reload();
      return true;
    } catch (e) {
      const err = e as { message: string; fields?: Record<string, string> };
      if (key === "review") setReviewErr(err.fields?.next_review_date ?? err.message);
      else toast.error(err.message);
      return false;
    } finally {
      setBusy("");
    }
  };

  const openVersion = async (v: number) => {
    try {
      setVersion(await api.get<VersionRow>(`/knowledge/${k.id}/versions/${v}`));
    } catch (e) {
      toast.error((e as Error).message);
    }
  };

  const addGrant = async () => {
    if (!grantPick) return;
    try {
      await api.post(`/knowledge/${k.id}/access`, { user_id: grantPick });
      setGrantPick("");
      toast.success("Access granted");
      reload();
    } catch (e) {
      toast.error((e as Error).message);
    }
  };
  const removeGrant = async (uid: string) => {
    try {
      await api.del(`/knowledge/${k.id}/access/${uid}`);
      toast.success("Access removed");
      reload();
    } catch (e) {
      toast.error((e as Error).message);
    }
  };

  const isLesson = k.item_type === "lesson";
  const lessonParts: [string, string][] = [
    ["What happened", k.what_happened],
    ["What worked", k.what_worked],
    ["What did not work", k.what_did_not_work],
    ["Why", k.why],
    ["What to do differently", k.do_differently],
    ["Who could benefit", k.future_benefit],
  ];
  const reviewOverdue = k.review_date && k.review_date < new Date().toISOString().slice(0, 10);

  return (
    <>
      <PageHeader
        breadcrumbs={[{ label: "Knowledge Hub", to: "/knowledge" }, ...(k.item_type === "procedure" ? [{ label: "Procedures", to: "/knowledge/procedures" }] : []), { label: k.title }]}
        title={k.title}
        subtitle={
          <span className="row">
            <Badge tone="accent" icon={k.item_type === "procedure" ? "tasks" : k.item_type === "lesson" ? "lightbulb" : "book"}>
              {ITEM_TYPE_LABEL[k.item_type] ?? k.item_type}
            </Badge>
            <span className="muted small">{k.category}</span>
            <StatusBadge kind="knowledge" value={k.status} />
            {k.access_level !== "all_staff" && <Badge icon="lock">{ACCESS_LABEL[k.access_level]}</Badge>}
            <span className="muted small">v{k.version}</span>
          </span>
        }
        actions={
          <>
            {p.can_edit && (
              <Button icon="edit" onClick={() => nav(`/knowledge/${k.id}/edit`)}>
                Edit
              </Button>
            )}
            {p.can_submit && (
              <Button variant="primary" icon="send" loading={busy === "submit"} onClick={() => act("submit", "submit", {}, "Submitted for review")}>
                Submit for review
              </Button>
            )}
            {p.can_return && (
              <Button icon="edit" onClick={() => setReturnOpen(true)}>
                Return to author
              </Button>
            )}
            {p.can_publish && (
              <Button variant="primary" icon="checkCircle" loading={busy === "publish"} onClick={() => act("publish", "publish", {}, "Published")}>
                Publish
              </Button>
            )}
            {p.can_mark_reviewed && (
              <Button icon="check" onClick={() => setReviewOpen(true)}>
                Mark reviewed
              </Button>
            )}
            {p.can_archive && (
              <Button variant="ghost" icon="archive" onClick={() => setArchiveOpen(true)}>
                Archive
              </Button>
            )}
          </>
        }
      />

      {k.status === "draft" && <div className="mb-2"><Callout tone="neutral" icon="edit">This is a draft — only you{p.can_manage ? " and knowledge managers once submitted" : ""} can see it. Submit it for review when it's ready.</Callout></div>}
      {k.status === "in_review" && <div className="mb-2"><Callout tone="warn" icon="eye">Awaiting review by a knowledge manager before it is published.</Callout></div>}
      {k.status === "archived" && <div className="mb-2"><Callout tone="neutral" icon="archive">Archived — kept for reference but hidden from default searches.</Callout></div>}
      {k.status === "published" && reviewOverdue && <div className="mb-2"><Callout tone="warn" icon="clock">Review was due {fmtDate(k.review_date)}. Check this is still accurate.</Callout></div>}

      <div className="cols-main-side">
        <div className="stack" style={{ gap: 18 }}>
          {k.summary && (
            <Card>
              <p style={{ margin: 0, fontSize: "1.02rem" }}>{k.summary}</p>
            </Card>
          )}
          {isLesson && (
            <div className="kno-lesson">
              {lessonParts.filter(([, val]) => val).map(([label, val]) => (
                <section className="card" key={label}>
                  <div className="card-body">
                    <h3>{label}</h3>
                    <RichText text={val} />
                  </div>
                </section>
              ))}
            </div>
          )}
          {k.body && (
            <Card title={k.item_type === "procedure" ? "Steps" : isLesson ? "Supporting evidence" : "Content"}>
              <RichText text={k.body} />
            </Card>
          )}
          {!k.body && !k.summary && !isLesson && !k.document_url && <Callout icon="info">No content has been added yet.</Callout>}
          {k.document_url && (
            <Card>
              <a href={k.document_url} target="_blank" rel="noopener noreferrer" className="row">
                <Icon name="external" size={16} /> Open source document
              </a>
              <p className="tiny muted mt-1" style={{ marginBottom: 0 }}>
                Opens in a new tab. Access depends on the document's own sharing settings.
              </p>
            </Card>
          )}
          <Card>
            <DocumentLinks entityType="knowledge" entityId={k.id} canEdit={p.can_edit} />
          </Card>
          <Card>
            <Comments entityType="knowledge" entityId={k.id} />
          </Card>
        </div>

        <div className="stack" style={{ gap: 18 }}>
          <Card title="Details">
            <KeyValue
              items={[
                ["Author", <PersonChip key="a" name={k.author_name} />],
                ["Owner", <PersonChip key="o" name={k.owner_name} />],
                ["Project", k.project_id ? <Link key="p" to={`/projects/${k.project_id}`}>{k.project_name}</Link> : null],
                ["Programme", k.programme_name],
                ["Published", k.published_date ? fmtDate(k.published_date, { year: true }) : null],
                ["Last reviewed", k.last_reviewed_date ? fmtDate(k.last_reviewed_date, { year: true }) : null],
                ["Next review", k.review_date ? <span key="r" className={reviewOverdue ? "overdue" : ""}>{fmtDate(k.review_date, { year: true })}</span> : null],
                ["Source", k.source || null],
                ["Derived from", data.source && recordPath(data.source.type, data.source.id) !== "#" ? <Link key="s" to={recordPath(data.source.type, data.source.id)}>{humanize(data.source.type)} record</Link> : null],
                ["Keywords", k.keywords || null],
                ["Tags", k.tags ? <Tags key="t" value={k.tags} /> : null],
                ["Views", String(k.view_count)],
              ]}
            />
          </Card>

          {p.can_edit && k.access_level === "restricted" && (
            <Card title="People with access">
              <p className="small muted">Besides the author and owner, only these people can see this item.</p>
              {data.grants.length ? (
                <ul className="stack-sm" style={{ listStyle: "none", padding: 0, margin: "0 0 10px" }}>
                  {data.grants.map((g) => (
                    <li key={g.id} className="row-between small">
                      <PersonChip name={g.name} />
                      <Button size="sm" variant="ghost" onClick={() => removeGrant(g.id)} aria-label={`Remove access for ${g.name}`}>
                        Remove
                      </Button>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="small">No additional people.</p>
              )}
              <div className="row">
                <select className="select" style={{ flex: 1 }} aria-label="Grant access to" value={grantPick} onChange={(e) => setGrantPick(e.target.value)}>
                  <option value="">Choose a person…</option>
                  {(lookups?.users ?? []).filter((u) => !data.grants.some((g) => g.id === u.id)).map((u) => (
                    <option key={u.id} value={u.id}>
                      {u.name}
                    </option>
                  ))}
                </select>
                <Button size="sm" onClick={addGrant} disabled={!grantPick}>
                  Grant
                </Button>
              </div>
            </Card>
          )}

          <Card>
            <RelatedRecords entityType="knowledge" entityId={k.id} />
          </Card>

          <Card title="Similar items">
            {data.similar.length ? (
              <ul className="stack-sm" style={{ listStyle: "none", padding: 0, margin: 0 }}>
                {data.similar.map((s) => (
                  <li key={s.id} className="small">
                    <Link to={`/knowledge/${s.id}`}>{s.title}</Link>
                    <div className="tiny muted">
                      {ITEM_TYPE_LABEL[s.item_type] ?? s.item_type} · {s.category}
                    </div>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="muted small">No similar items found (matched by shared tags, keywords and category).</p>
            )}
          </Card>

          <Card title="Version history">
            <ul className="stack-sm" style={{ listStyle: "none", padding: 0, margin: 0 }}>
              <li className="small">
                <strong>v{k.version}</strong> (current) · updated {fmtDateTime(k.updated_at)}
              </li>
              {data.versions.map((v) => (
                <li key={v.id} className="row-between small">
                  <span>
                    v{v.version} · replaced {fmtDateTime(v.changed_at)}
                    {v.changed_by_name ? ` by ${v.changed_by_name}` : ""}
                  </span>
                  <Button size="sm" variant="ghost" onClick={() => openVersion(v.version)}>
                    View
                  </Button>
                </li>
              ))}
            </ul>
            {!data.versions.length && <p className="tiny muted mt-1">Earlier versions appear here when the title, summary or content is edited.</p>}
          </Card>
        </div>
      </div>

      <Modal
        open={returnOpen}
        onClose={() => setReturnOpen(false)}
        title="Return to author"
        footer={
          <>
            <Button onClick={() => setReturnOpen(false)}>Cancel</Button>
            <Button
              variant="primary"
              loading={busy === "return"}
              onClick={async () => {
                if (!returnNote.trim()) return setReturnErr("Explain what needs to change.");
                if (await act("return", "return", { note: returnNote }, "Returned to the author with feedback")) {
                  setReturnOpen(false);
                  setReturnNote("");
                }
              }}
            >
              Return with feedback
            </Button>
          </>
        }
      >
        <TextArea label="Feedback for the author" required value={returnNote} onChange={(x) => { setReturnNote(x); setReturnErr(""); }} error={returnErr} rows={4} />
      </Modal>

      <Modal
        open={reviewOpen}
        onClose={() => setReviewOpen(false)}
        title="Mark as reviewed"
        footer={
          <>
            <Button onClick={() => setReviewOpen(false)}>Cancel</Button>
            <Button
              variant="primary"
              loading={busy === "review"}
              onClick={async () => {
                if (await act("review", "review-complete", { next_review_date: nextReview || null }, "Marked as reviewed")) setReviewOpen(false);
              }}
            >
              Confirm review
            </Button>
          </>
        }
      >
        <p className="small">Confirm the content is still accurate. Today becomes the "last reviewed" date.</p>
        <TextInput label="Next review date" type="date" value={nextReview} onChange={(x) => { setNextReview(x); setReviewErr(""); }} error={reviewErr} hint="Leave blank to schedule the next review in 6 months." />
      </Modal>

      <ConfirmDialog
        open={archiveOpen}
        title="Archive this item?"
        message="Archived items stay available for reference but are hidden from default search and discovery. You can submit it again later."
        confirmLabel="Archive"
        busy={busy === "archive"}
        onClose={() => setArchiveOpen(false)}
        onConfirm={async () => {
          if (await act("archive", "archive", {}, "Archived")) setArchiveOpen(false);
        }}
      />

      <Modal open={!!version} onClose={() => setVersion(null)} title={version ? `Version ${version.version}` : ""} wide>
        {version && (
          <div className="stack">
            <p className="tiny muted">
              Replaced {fmtDateTime(version.changed_at)}
              {version.changed_by_name ? ` by ${version.changed_by_name}` : ""}. This is a read-only snapshot.
            </p>
            <h3>{version.title}</h3>
            {version.summary && <p>{version.summary}</p>}
            <RichText text={version.body} />
          </div>
        )}
      </Modal>
    </>
  );
}
