import { useEffect, useState } from "react";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import { api } from "../../lib/api";
import { useApi, useForm } from "../../lib/hooks";
import { useAuth, useLookups, useToast } from "../../lib/app-state";
import { Button, Callout, Card, ErrorState, Field, FormError, Loading, PageHeader, SelectInput, TextArea, TextInput } from "../../components/ui";
import { ProjectSelect, UserSelect } from "../../components/records";
import { ACCESS_LEVELS, ITEM_TYPES, type KnowledgeDetailResponse, type KnowledgeItem } from "./types";

interface FormValues extends Record<string, unknown> {
  title: string;
  summary: string;
  body: string;
  category: string;
  item_type: string;
  keywords: string;
  tags: string;
  owner_id: string;
  source: string;
  document_url: string;
  project_id: string;
  programme_id: string;
  access_level: string;
  review_date: string;
  what_happened: string;
  what_worked: string;
  what_did_not_work: string;
  why: string;
  do_differently: string;
  future_benefit: string;
  grant_user_ids: string[];
}

const EMPTY: FormValues = {
  title: "", summary: "", body: "", category: "", item_type: "resource", keywords: "", tags: "", owner_id: "", source: "", document_url: "",
  project_id: "", programme_id: "", access_level: "all_staff", review_date: "", what_happened: "", what_worked: "", what_did_not_work: "", why: "",
  do_differently: "", future_benefit: "", grant_user_ids: [],
};

const fromItem = (k: KnowledgeItem): FormValues => ({
  title: k.title, summary: k.summary, body: k.body, category: k.category, item_type: k.item_type, keywords: k.keywords, tags: k.tags,
  owner_id: k.owner_id ?? "", source: k.source, document_url: k.document_url, project_id: k.project_id ?? "", programme_id: k.programme_id ?? "",
  access_level: k.access_level, review_date: k.review_date ?? "", what_happened: k.what_happened, what_worked: k.what_worked,
  what_did_not_work: k.what_did_not_work, why: k.why, do_differently: k.do_differently, future_benefit: k.future_benefit, grant_user_ids: [],
});

export default function KnowledgeForm() {
  const { id } = useParams();
  const editing = !!id;
  const [params] = useSearchParams();
  const nav = useNavigate();
  const toast = useToast();
  const { can, me } = useAuth();
  const { lookups } = useLookups();
  const existing = useApi<KnowledgeDetailResponse>(editing ? `/knowledge/${id}` : null);
  const f = useForm<FormValues>({ ...EMPTY, item_type: params.get("type") ?? "resource", project_id: params.get("project_id") ?? "" });
  const [loaded, setLoaded] = useState(false);
  const [grantPick, setGrantPick] = useState("");

  useEffect(() => {
    if (existing.data && !loaded) {
      f.setValues(fromItem(existing.data.item));
      setLoaded(true);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [existing.data, loaded]);

  if (editing && existing.loading && !existing.data) return <Loading />;
  if (editing && existing.error) return <ErrorState error={existing.error} onRetry={existing.reload} />;
  if (editing && existing.data && !existing.data.permissions.can_edit) return <ErrorState error="You can view this item but not edit it." />;
  if (!editing && !can("knowledge.contribute")) return <ErrorState error="Your role cannot submit knowledge items. Ask a knowledge manager." />;

  const v = f.values;
  const categories = lookups?.taxonomies.knowledge_category ?? ["Other"];
  const isLesson = v.item_type === "lesson";
  const isProcedure = v.item_type === "procedure";
  const typeMeta = ITEM_TYPES.find((t) => t.value === v.item_type);
  const accessMeta = ACCESS_LEVELS.find((a) => a.value === v.access_level);
  const status = existing.data?.item.status;

  const validate = (x: FormValues) => {
    const e: Record<string, string> = {};
    if (!x.title.trim()) e.title = "Give the item a title.";
    if (!x.category) e.category = "Choose a category.";
    if (x.access_level === "project" && !x.project_id) e.project_id = "Project-level access needs a linked project.";
    if (x.document_url && !/^https?:\/\/\S+$/i.test(x.document_url)) e.document_url = "Use a full link starting with https://";
    if (isLesson && !x.what_happened.trim() && !x.what_worked.trim() && !x.do_differently.trim()) e.what_happened = "Describe at least what happened, what worked, or what to do differently.";
    if (!isLesson && !x.summary.trim() && !x.body.trim() && !x.document_url) e.summary = "Add a summary, content or a document link so people can use this item.";
    return e;
  };

  const payload = (x: FormValues) => {
    const p: Record<string, unknown> = { ...x };
    for (const k of ["owner_id", "project_id", "programme_id", "review_date"]) if (!p[k]) p[k] = null;
    if (x.access_level !== "restricted") delete p.grant_user_ids;
    return p;
  };

  const save = (action: "draft" | "submit" | "publish") =>
    f.submit(async (x) => {
      if (editing) {
        const r = await api.patch<KnowledgeItem>(`/knowledge/${id}`, payload(x));
        if (action === "submit" && (r.status === "draft" || r.status === "archived")) await api.post(`/knowledge/${id}/submit`);
        if (action === "publish" && r.status !== "published") await api.post(`/knowledge/${id}/publish`);
        toast.success(action === "submit" ? "Saved and submitted for review" : action === "publish" ? "Saved and published" : "Changes saved");
        nav(`/knowledge/${id}`);
      } else {
        const r = await api.post<KnowledgeItem>("/knowledge", { ...payload(x), action });
        toast.success(action === "publish" ? "Published to the Knowledge Hub" : action === "submit" ? "Submitted for review" : "Draft saved");
        nav(`/knowledge/${r.id}`);
      }
    }, validate);

  const grantUsers = (lookups?.users ?? []).filter((u) => v.grant_user_ids.includes(u.id));

  return (
    <>
      <PageHeader
        title={editing ? "Edit knowledge item" : "Add knowledge"}
        subtitle={editing ? `Editing the title, summary or content creates a new version (currently v${existing.data?.item.version}).` : "Capture something CSI should be able to find and reuse."}
        breadcrumbs={[{ label: "Knowledge Hub", to: "/knowledge" }, ...(editing && existing.data ? [{ label: existing.data.item.title, to: `/knowledge/${id}` }] : []), { label: editing ? "Edit" : "New" }]}
      />
      <form
        onSubmit={(e) => {
          e.preventDefault();
          save("draft");
        }}
        noValidate
        className="cols-main-side"
      >
        <div className="stack">
          <FormError message={f.formError} />
          <Card title="What are you adding?">
            <div className="segmented" role="radiogroup" aria-label="Knowledge type">
              {ITEM_TYPES.map((t) => (
                <button type="button" key={t.value} role="radio" aria-checked={v.item_type === t.value} className={v.item_type === t.value ? "active" : ""} onClick={() => f.set("item_type", t.value)}>
                  {t.label}
                </button>
              ))}
            </div>
            {typeMeta && <p className="small muted mt-1">{typeMeta.hint}</p>}
          </Card>
          <Card title="Content">
            <TextInput label="Title" required value={v.title} onChange={(x) => f.set("title", x)} error={f.errors.title} maxLength={300} placeholder={isProcedure ? "How to …" : isLesson ? "Lesson: …" : ""} />
            <TextArea label="Summary" rows={2} value={v.summary} onChange={(x) => f.set("summary", x)} error={f.errors.summary} hint="One or two sentences shown in search results." />
            {isLesson ? (
              <>
                <TextArea label="What happened?" rows={3} value={v.what_happened} onChange={(x) => f.set("what_happened", x)} error={f.errors.what_happened} />
                <div className="form-grid">
                  <TextArea label="What worked?" rows={3} value={v.what_worked} onChange={(x) => f.set("what_worked", x)} />
                  <TextArea label="What did not work?" rows={3} value={v.what_did_not_work} onChange={(x) => f.set("what_did_not_work", x)} />
                  <TextArea label="Why?" rows={3} value={v.why} onChange={(x) => f.set("why", x)} />
                  <TextArea label="What should be done differently?" rows={3} value={v.do_differently} onChange={(x) => f.set("do_differently", x)} />
                </div>
                <TextArea label="Which future work could benefit?" rows={2} value={v.future_benefit} onChange={(x) => f.set("future_benefit", x)} />
                <TextArea label="Supporting evidence or notes" rows={3} value={v.body} onChange={(x) => f.set("body", x)} />
              </>
            ) : (
              <TextArea
                label={isProcedure ? "Steps" : "Content"}
                rows={isProcedure ? 10 : 8}
                value={v.body}
                onChange={(x) => f.set("body", x)}
                hint={isProcedure ? "Number each step (1. 2. 3.) — lists are formatted automatically." : "Plain text; lines starting with - or 1. become lists."}
              />
            )}
            <TextInput label="Document link" type="url" value={v.document_url} onChange={(x) => f.set("document_url", x)} error={f.errors.document_url} placeholder="https://docs.google.com/…" hint="Link to the source document in Google Drive or elsewhere. Access is still governed by the document's own sharing." />
            <TextInput label="Source" value={v.source} onChange={(x) => f.set("source", x)} hint="Where this came from (e.g. a meeting, study or partner)." />
          </Card>
        </div>
        <div className="stack">
          <Card title="Classification">
            <SelectInput label="Category" required value={v.category} onChange={(x) => f.set("category", x)} error={f.errors.category} placeholder="Choose…" options={categories.map((c) => ({ value: c, label: c }))} />
            <TextInput label="Keywords" value={v.keywords} onChange={(x) => f.set("keywords", x)} hint="Comma-separated terms people might search for." />
            <TextInput label="Tags" value={v.tags} onChange={(x) => f.set("tags", x)} hint="Comma-separated, e.g. research, partnerships" />
            <ProjectSelect value={v.project_id} onChange={(x) => f.set("project_id", x)} error={f.errors.project_id} />
            <SelectInput label="Programme" value={v.programme_id} onChange={(x) => f.set("programme_id", x)} placeholder="No programme" options={(lookups?.programmes ?? []).map((p) => ({ value: p.id, label: p.name }))} />
          </Card>
          <Card title="Ownership & access">
            <UserSelect label={isProcedure ? "Procedure owner" : "Owner"} value={v.owner_id} onChange={(x) => f.set("owner_id", x)} placeholder={`Me (${me?.user.name ?? ""})`} hint="Responsible for keeping it accurate." />
            <TextInput label="Next review date" type="date" value={v.review_date} onChange={(x) => f.set("review_date", x)} hint={isProcedure ? "Procedures should be reviewed regularly." : "Optional."} />
            <SelectInput label="Who can see this?" value={v.access_level} onChange={(x) => f.set("access_level", x)} options={ACCESS_LEVELS.map((a) => ({ value: a.value, label: a.label }))} hint={accessMeta?.hint} />
            {v.access_level === "restricted" && (
              <Field label="Grant access to">
                <div className="row">
                  <select className="select" style={{ flex: 1 }} aria-label="Person to grant access" value={grantPick} onChange={(e) => setGrantPick(e.target.value)}>
                    <option value="">Choose a person…</option>
                    {(lookups?.users ?? []).filter((u) => !v.grant_user_ids.includes(u.id) && u.id !== me?.user.id).map((u) => (
                      <option key={u.id} value={u.id}>
                        {u.name}
                      </option>
                    ))}
                  </select>
                  <Button size="sm" disabled={!grantPick} onClick={() => { f.set("grant_user_ids", [...v.grant_user_ids, grantPick]); setGrantPick(""); }}>
                    Add
                  </Button>
                </div>
                {grantUsers.length > 0 && (
                  <div className="row mt-1">
                    {grantUsers.map((u) => (
                      <span className="tag" key={u.id}>
                        {u.name}{" "}
                        <button type="button" className="btn btn-ghost btn-sm" style={{ minHeight: 0, padding: "0 4px" }} aria-label={`Remove ${u.name}`} onClick={() => f.set("grant_user_ids", v.grant_user_ids.filter((x) => x !== u.id))}>
                          ×
                        </button>
                      </span>
                    ))}
                  </div>
                )}
                {editing && <span className="hint">Existing grants are managed on the item page.</span>}
              </Field>
            )}
          </Card>
          <Card title="Save">
            <div className="stack-sm">
              {status && status !== "draft" && <Callout tone="accent" icon="info">This item is currently <strong>{status.replace("_", " ")}</strong>. Saving keeps that status.</Callout>}
              <Button type="submit" loading={f.submitting}>
                {editing ? "Save changes" : "Save as draft"}
              </Button>
              {(!editing || status === "draft" || status === "archived") && (
                <Button variant="primary" loading={f.submitting} onClick={() => save("submit")} icon="send">
                  {editing ? "Save & submit for review" : "Submit for review"}
                </Button>
              )}
              {can("knowledge.manage") && status !== "published" && (
                <Button variant="primary" loading={f.submitting} onClick={() => save("publish")} icon="checkCircle">
                  {editing ? "Save & publish" : "Publish now"}
                </Button>
              )}
              <Button variant="ghost" onClick={() => nav(editing ? `/knowledge/${id}` : "/knowledge")}>
                Cancel
              </Button>
              {!can("knowledge.manage") && <p className="tiny muted">A knowledge manager reviews submissions before they are published.</p>}
            </div>
          </Card>
        </div>
      </form>
    </>
  );
}
