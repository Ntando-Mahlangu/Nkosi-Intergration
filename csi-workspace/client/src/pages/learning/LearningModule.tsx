import { useEffect, useState } from "react";
import { Link, NavLink, Route, Routes, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { api } from "../../lib/api";
import { useApi, useDebounced, useForm } from "../../lib/hooks";
import { useAuth, useLookups, useToast } from "../../lib/app-state";
import { options, statusMeta } from "../../lib/status";
import { fmtDate, humanize, relTime } from "../../lib/format";
import {
  AIBadge, Badge, Button, Callout, Card, ConfirmDialog, EmptyState, ErrorState, FormError, KeyValue, Loading, Modal, PageHeader,
  PersonChip, PriorityBadge, RichText, SelectInput, StatusBadge, TextArea, TextInput,
} from "../../components/ui";
import { Comments, ProjectSelect, UserSelect } from "../../components/records";
import { Icon } from "../../components/Icon";
import "./learning.css";

// ------------------------------------------------------------------ types
export interface LearningRecord {
  id: string; contributor_id: string | null; contributor_name: string | null; record_type: string; title: string; topic: string;
  project_id: string | null; project_name: string | null; theme_id: string | null; theme_title: string | null; theme_month: string | null;
  what_learned: string; what_changed: string; what_tried: string; what_worked: string; what_did_not_work: string; do_differently: string;
  suggested_improvement: string; others_could_learn: string; outcome: string; document_url: string; visibility: "shared" | "private";
  created_at: string; updated_at: string;
}
interface Theme {
  id: string; month: string; title: string; description: string; reading_material: string; discussion_prompts: string; summary: string;
  participation: string; contribution_count: number; created_by_name: string | null;
}
interface Improvement {
  id: string; title: string; description: string; area: string; origin: string; suggested_by: string | null; suggested_by_name: string | null;
  problem: string; proposed_solution: string; potential_benefit: string; priority: string; owner_id: string | null; owner_name: string | null;
  status: string; review_date: string | null; project_id: string | null; project_name: string | null; outcome: string; created_at: string; updated_at: string;
}

const RECORD_TYPES: { value: string; label: string; hint: string }[] = [
  { value: "lesson", label: "Lesson", hint: "Something that went well or badly and what it taught you" },
  { value: "insight", label: "New insight", hint: "A new understanding or perspective" },
  { value: "experiment", label: "Experiment", hint: "Something you tried deliberately to see what happens" },
  { value: "process_change", label: "Process change", hint: "A way of working that changed" },
  { value: "behaviour_change", label: "Behaviour change", hint: "A habit or behaviour you shifted" },
  { value: "approach_change", label: "Change in approach", hint: "A different way of tackling a problem" },
  { value: "unexpected_outcome", label: "Unexpected outcome", hint: "Something that surprised you" },
  { value: "theme_contribution", label: "Theme contribution", hint: "A reflection, resource or example for this month's theme" },
];
const typeLabel = (t: string) => RECORD_TYPES.find((r) => r.value === t)?.label ?? humanize(t);

export default function LearningModule() {
  return (
    <Routes>
      <Route index element={<LearningHome />} />
      <Route path="records/:id" element={<RecordDetail />} />
      <Route path="themes" element={<ThemesPage />} />
      <Route path="themes/:id" element={<ThemeDetailPage />} />
      <Route path="improvements" element={<ImprovementsPage />} />
      <Route path="improvements/:id" element={<ImprovementDetail />} />
    </Routes>
  );
}

function SubNav() {
  const cls = ({ isActive }: { isActive: boolean }) => `tab ${isActive ? "active" : ""}`;
  return (
    <nav className="tabs" aria-label="Learning sections">
      <NavLink to="/learning" end className={cls}>Learning</NavLink>
      <NavLink to="/learning/themes" className={cls}>Monthly themes</NavLink>
      <NavLink to="/learning/improvements" className={cls}>Improvement register</NavLink>
    </nav>
  );
}

// =================================================================== home
function LearningHome() {
  const [params, setParams] = useSearchParams();
  const { lookups } = useLookups();
  const current = useApi<{ month: string; theme: Theme | null; contributions: LearningRecord[]; can_manage: boolean }>("/learning/themes/current");
  const [q, setQ] = useState("");
  const [type, setType] = useState("");
  const [topic, setTopic] = useState("");
  const [project, setProject] = useState("");
  const [mine, setMine] = useState(false);
  const dq = useDebounced(q);
  const recs = useApi<{ items: LearningRecord[]; topics: string[] }>("/learning/records", { q: dq, type, topic, project_id: project, mine: mine ? "1" : "" });
  const formOpen = params.get("new") === "1";
  const nav = useNavigate();
  const close = () => { const p = new URLSearchParams(params); p.delete("new"); p.delete("theme"); setParams(p, { replace: true }); };

  return (
    <>
      <PageHeader
        title="Learning & Improvement"
        subtitle="Capture what we learn from our work — and from change itself — so others can benefit."
        actions={<Button variant="primary" icon="plus" onClick={() => setParams({ new: "1" })}>Share a learning</Button>}
      />
      <SubNav />
      {current.data?.theme ? (
        <ThemeHighlight theme={current.data.theme} contributions={current.data.contributions} onContribute={() => setParams({ new: "1", theme: current.data!.theme!.id })} />
      ) : current.data ? (
        <div className="mb-3">
          <Callout icon="lightbulb">
            No learning theme has been set for this month.
            {current.data.can_manage && <> <Link to="/learning/themes">Set one up</Link>.</>}
          </Callout>
        </div>
      ) : null}

      <div className="section-head"><h2>Shared learning</h2><span className="meta">Private records are visible only to you.</span></div>
      <div className="filter-bar">
        <input className="input" type="search" aria-label="Search learning" placeholder="Search learning…" value={q} onChange={(e) => setQ(e.target.value)} />
        <select className="select" aria-label="Filter by type" value={type} onChange={(e) => setType(e.target.value)}>
          <option value="">All types</option>
          {RECORD_TYPES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
        </select>
        <select className="select" aria-label="Filter by topic" value={topic} onChange={(e) => setTopic(e.target.value)}>
          <option value="">All topics</option>
          {(recs.data?.topics ?? []).map((t) => <option key={t}>{t}</option>)}
        </select>
        <select className="select" aria-label="Filter by project" value={project} onChange={(e) => setProject(e.target.value)}>
          <option value="">All projects</option>
          {(lookups?.projects ?? []).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
        <label className="check small"><input type="checkbox" checked={mine} onChange={(e) => setMine(e.target.checked)} /> Only mine</label>
      </div>
      {recs.error ? (
        <ErrorState error={recs.error} onRetry={recs.reload} />
      ) : !recs.data ? (
        <Loading />
      ) : recs.data.items.length ? (
        <div className="grid grid-2">
          {recs.data.items.map((r) => <RecordCard key={r.id} r={r} />)}
        </div>
      ) : (
        <EmptyState icon="lightbulb" title="No learning shared yet" action={<Button variant="primary" onClick={() => setParams({ new: "1" })}>Share a learning</Button>}>
          Small insights count. What did you try, notice or change recently?
        </EmptyState>
      )}
      <LearningFormModal
        open={formOpen}
        defaultThemeId={params.get("theme") ?? undefined}
        onClose={close}
        onSaved={(r) => { close(); recs.reload(); current.reload(); nav(`/learning/records/${r.id}`); }}
      />
    </>
  );
}

function ThemeHighlight({ theme, contributions, onContribute }: { theme: Theme; contributions: LearningRecord[]; onContribute: () => void }) {
  return (
    <section className="card lrn-theme mb-3" aria-labelledby="lrn-theme-title">
      <div className="card-body">
        <div className="row-between">
          <div>
            <div className="tiny muted">This month's learning theme · {monthLabel(theme.month)} · participation {theme.participation}</div>
            <h2 id="lrn-theme-title" className="mt-1">{theme.title}</h2>
          </div>
          <div className="row">
            <Link className="btn btn-sm" to={`/learning/themes/${theme.id}`}>Open theme</Link>
            <Button size="sm" variant="primary" icon="plus" onClick={onContribute}>Contribute</Button>
          </div>
        </div>
        {theme.description && <div className="mt-2"><RichText text={theme.description} /></div>}
        <div className="grid grid-2 mt-2">
          {theme.discussion_prompts && <div><h3 className="small">Discussion prompts</h3><RichText text={theme.discussion_prompts} className="small" /></div>}
          {theme.reading_material && <div><h3 className="small">Reading material</h3><RichText text={theme.reading_material} className="small" /></div>}
        </div>
        <div className="tiny muted mt-2">{contributions.length} shared contribution{contributions.length === 1 ? "" : "s"} so far.</div>
      </div>
    </section>
  );
}

const monthLabel = (m: string) => {
  const [y, mo] = m.split("-").map(Number);
  return new Date(y, mo - 1, 1).toLocaleString("en-GB", { month: "long", year: "numeric" });
};

function RecordCard({ r }: { r: LearningRecord }) {
  const excerpt = r.what_learned || r.what_tried || r.outcome || r.what_changed || r.others_could_learn;
  return (
    <Link to={`/learning/records/${r.id}`} className="card clickable lrn-card">
      <div className="card-body">
        <div className="row">
          <Badge tone="accent" icon="lightbulb">{typeLabel(r.record_type)}</Badge>
          {r.visibility === "private" ? <Badge icon="lock">Private</Badge> : <Badge tone="ok" icon="users">Shared</Badge>}
          {r.theme_title && <Badge tone="ai">{r.theme_title}</Badge>}
        </div>
        <h3 className="mt-1">{r.title}</h3>
        {excerpt && <p className="small muted lrn-excerpt">{excerpt}</p>}
        <div className="row tiny muted">
          <span>{r.contributor_name ?? "Former colleague"}</span>
          {r.topic && <span>· {r.topic}</span>}
          {r.project_name && <span>· {r.project_name}</span>}
          <span>· {relTime(r.created_at)}</span>
        </div>
      </div>
    </Link>
  );
}

// =================================================================== record form
type RecordValues = Omit<LearningRecord, "id" | "contributor_id" | "contributor_name" | "project_name" | "theme_title" | "theme_month" | "created_at" | "updated_at" | "project_id" | "theme_id"> & { project_id: string; theme_id: string };
const emptyRecord = (themeId = ""): RecordValues => ({
  record_type: themeId ? "theme_contribution" : "lesson", title: "", topic: "", project_id: "", theme_id: themeId, what_learned: "", what_changed: "",
  what_tried: "", what_worked: "", what_did_not_work: "", do_differently: "", suggested_improvement: "", others_could_learn: "", outcome: "",
  document_url: "", visibility: "shared",
});
const REFLECTIVE: (keyof RecordValues)[] = ["what_learned", "what_changed", "what_tried", "what_worked", "what_did_not_work", "do_differently", "suggested_improvement", "others_could_learn", "outcome"];

function LearningFormModal({ open, onClose, onSaved, existing, defaultThemeId }: { open: boolean; onClose: () => void; onSaved: (r: LearningRecord) => void; existing?: LearningRecord | null; defaultThemeId?: string }) {
  const toast = useToast();
  const themes = useApi<{ items: Theme[] }>(open ? "/learning/themes" : null);
  const f = useForm<RecordValues>(emptyRecord());
  useEffect(() => {
    if (!open) return;
    f.setValues(existing ? { ...existing, project_id: existing.project_id ?? "", theme_id: existing.theme_id ?? "" } : emptyRecord(defaultThemeId));
    f.setErrors({});
    f.setFormError("");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, existing?.id, defaultThemeId]);
  const validate = (v: RecordValues) => {
    const e: Record<string, string> = {};
    if (!v.title.trim()) e.title = "Give your learning a short title.";
    if (!REFLECTIVE.some((k) => String(v[k] ?? "").trim())) e.what_learned = "Add at least one reflection — any of the fields below is fine.";
    if (v.document_url && !/^https?:\/\//i.test(v.document_url)) e.document_url = "Use a full URL starting with https://";
    return e;
  };
  const save = () =>
    f.submit(async (v) => {
      const body = { ...v, project_id: v.project_id || null, theme_id: v.theme_id || null };
      const r = existing ? await api.patch<LearningRecord>(`/learning/records/${existing.id}`, body) : await api.post<LearningRecord>("/learning/records", body);
      toast.success(existing ? "Learning updated" : v.visibility === "private" ? "Saved privately" : "Thanks for sharing");
      onSaved(r);
    }, validate);
  const ta = (k: keyof RecordValues, label: string, hint?: string) => (
    <TextArea className="full" label={label} rows={2} value={String(f.values[k] ?? "")} onChange={(v) => f.set(k, v as never)} error={f.errors[k as string]} hint={hint} />
  );
  return (
    <Modal open={open} onClose={onClose} wide title={existing ? "Edit learning" : "Share a learning"} footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" loading={f.submitting} onClick={save}>{existing ? "Save changes" : "Save learning"}</Button></>}>
      <FormError message={f.formError} />
      <Callout icon="info">
        Every reflection field is optional — fill in only what's true for you. You don't need to have changed anything to share a learning,
        and contributions are never used to assess individual performance.
      </Callout>
      <div className="form-grid mt-2">
        <TextInput className="full" label="Title" required value={f.values.title} onChange={(v) => f.set("title", v)} error={f.errors.title} />
        <SelectInput label="Type" value={f.values.record_type} onChange={(v) => f.set("record_type", v)} options={RECORD_TYPES.map((t) => ({ value: t.value, label: t.label }))} hint={RECORD_TYPES.find((t) => t.value === f.values.record_type)?.hint} />
        <TextInput label="Topic" value={f.values.topic} onChange={(v) => f.set("topic", v)} hint="e.g. Communication, Facilitation" />
        <ProjectSelect value={f.values.project_id} onChange={(v) => f.set("project_id", v)} error={f.errors.project_id} />
        <SelectInput label="Monthly theme" value={f.values.theme_id} onChange={(v) => f.set("theme_id", v)} placeholder="Not linked to a theme" options={(themes.data?.items ?? []).map((t) => ({ value: t.id, label: `${monthLabel(t.month)} — ${t.title}` }))} />
      </div>
      <fieldset>
        <legend>Reflection</legend>
        <div className="form-grid">
          {ta("what_learned", "What did you learn?")}
          {ta("what_tried", "What did you try?", "An experiment, a new approach, a different way of working")}
          {ta("what_worked", "What worked?")}
          {ta("what_did_not_work", "What didn't work?")}
          {ta("outcome", "What was the result?", "Including anything unexpected")}
          {ta("what_changed", "What changed (if anything)?", "In your understanding, a process, a behaviour or an approach. Leave blank if nothing changed.")}
          {ta("do_differently", "What would you do differently?")}
          {ta("suggested_improvement", "Any improvement you'd suggest?")}
          {ta("others_could_learn", "What could others learn from this?")}
        </div>
      </fieldset>
      <div className="form-grid">
        <TextInput label="Supporting document (link)" type="url" value={f.values.document_url} onChange={(v) => f.set("document_url", v)} error={f.errors.document_url} />
        <SelectInput label="Who can see this?" value={f.values.visibility} onChange={(v) => f.set("visibility", v as "shared" | "private")} options={[{ value: "shared", label: "Shared with all staff" }, { value: "private", label: "Private — only me" }]} hint="Private records are never visible to management or administrators." />
      </div>
    </Modal>
  );
}

// =================================================================== record detail
function RecordDetail() {
  const { id } = useParams();
  const nav = useNavigate();
  const toast = useToast();
  const { data, error, loading, reload } = useApi<{ record: LearningRecord; is_owner: boolean; can_promote: boolean; promoted_to: { id: string; title: string; status: string } | null }>(`/learning/records/${id}`);
  const [edit, setEdit] = useState(false);
  const [del, setDel] = useState(false);
  const [busy, setBusy] = useState(false);
  if (error) return <ErrorState error={error} onRetry={reload} />;
  if (loading && !data) return <Loading />;
  if (!data) return null;
  const r = data.record;
  const promote = async () => {
    setBusy(true);
    try {
      const k = await api.post<{ id: string }>(`/learning/records/${r.id}/promote`);
      toast.success("Submitted to the Knowledge Hub for review");
      nav(`/knowledge/${k.id}`);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const remove = async () => {
    setBusy(true);
    try {
      await api.del(`/learning/records/${r.id}`);
      toast.success("Learning record deleted");
      nav("/learning");
    } catch (e) {
      toast.error((e as Error).message);
      setBusy(false);
    }
  };
  const sections: [string, string][] = [
    ["What was learned", r.what_learned], ["What was tried", r.what_tried], ["What worked", r.what_worked], ["What didn't work", r.what_did_not_work],
    ["Result", r.outcome], ["What changed", r.what_changed], ["Would do differently", r.do_differently], ["Suggested improvement", r.suggested_improvement],
    ["What others could learn", r.others_could_learn],
  ];
  return (
    <>
      <PageHeader
        breadcrumbs={[{ label: "Learning", to: "/learning" }, { label: r.title }]}
        title={r.title}
        subtitle={
          <span className="row">
            <Badge tone="accent" icon="lightbulb">{typeLabel(r.record_type)}</Badge>
            {r.visibility === "private" ? <Badge icon="lock">Private — only you can see this</Badge> : <Badge tone="ok" icon="users">Shared with all staff</Badge>}
          </span>
        }
        actions={
          <>
            {data.can_promote && <Button icon="book" loading={busy} onClick={promote}>Submit to Knowledge Hub</Button>}
            {data.is_owner && <Button icon="edit" onClick={() => setEdit(true)}>Edit</Button>}
            {data.is_owner && <Button variant="danger" icon="trash" onClick={() => setDel(true)}>Delete</Button>}
          </>
        }
      />
      {data.promoted_to && (
        <div className="mb-2"><Callout tone="ok" icon="book">This learning has been submitted to the Knowledge Hub as <Link to={`/knowledge/${data.promoted_to.id}`}>{data.promoted_to.title}</Link> ({statusMeta("knowledge", data.promoted_to.status).label}).</Callout></div>
      )}
      <div className="cols-main-side">
        <div className="stack">
          <Card title="Reflection">
            <div className="stack">
              {sections.filter(([, v]) => v?.trim()).map(([k, v]) => (
                <div key={k}><h3 className="small muted">{k}</h3><RichText text={v} /></div>
              ))}
            </div>
          </Card>
          {r.visibility === "shared" && <Card><Comments entityType="learning" entityId={r.id} /></Card>}
        </div>
        <aside>
          <Card title="Details">
            <KeyValue
              items={[
                ["Contributor", <PersonChip name={r.contributor_name} />],
                ["Topic", r.topic || null],
                ["Project", r.project_id ? <Link to={`/projects/${r.project_id}`}>{r.project_name}</Link> : null],
                ["Theme", r.theme_id ? <Link to={`/learning/themes/${r.theme_id}`}>{r.theme_title}</Link> : null],
                ["Document", r.document_url ? <a href={r.document_url} target="_blank" rel="noopener noreferrer">Open link <Icon name="external" size={12} /></a> : null],
                ["Shared", fmtDate(r.created_at)],
              ]}
            />
          </Card>
        </aside>
      </div>
      <LearningFormModal open={edit} existing={r} onClose={() => setEdit(false)} onSaved={() => { setEdit(false); reload(); }} />
      <ConfirmDialog open={del} danger title="Delete this learning?" message="This permanently removes the record." confirmLabel="Delete" busy={busy} onConfirm={remove} onClose={() => setDel(false)} />
    </>
  );
}

// =================================================================== themes
function ThemesPage() {
  const { data, error, loading, reload } = useApi<{ items: Theme[]; can_manage: boolean }>("/learning/themes");
  const [editing, setEditing] = useState<Theme | null | "new">(null);
  return (
    <>
      <PageHeader title="Monthly learning themes" subtitle="An optional organisation-wide focus for shared reflection each month." actions={data?.can_manage && <Button variant="primary" icon="plus" onClick={() => setEditing("new")}>New theme</Button>} />
      <SubNav />
      {error ? <ErrorState error={error} onRetry={reload} /> : !data || loading ? <Loading /> : data.items.length ? (
        <div className="card list">
          {data.items.map((t) => (
            <div className="list-item" key={t.id}>
              <Icon name="calendar" />
              <div style={{ flex: 1, minWidth: 0 }}>
                <Link className="title" to={`/learning/themes/${t.id}`}>{t.title}</Link>
                <div className="meta"><span>{monthLabel(t.month)}</span><span>{t.contribution_count} shared contribution{t.contribution_count === 1 ? "" : "s"}</span>{t.summary && <Badge tone="ok" icon="check">Summary written</Badge>}</div>
              </div>
              {data.can_manage && <Button size="sm" icon="edit" onClick={() => setEditing(t)}>Edit</Button>}
            </div>
          ))}
        </div>
      ) : (
        <EmptyState icon="calendar" title="No themes yet">{data.can_manage ? "Create a theme to invite reflections across CSI." : "Learning coordinators can set a monthly theme."}</EmptyState>
      )}
      <ThemeFormModal open={editing !== null} existing={editing === "new" ? null : editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); reload(); }} />
    </>
  );
}

function ThemeFormModal({ open, existing, onClose, onSaved }: { open: boolean; existing: Theme | null; onClose: () => void; onSaved: () => void }) {
  const toast = useToast();
  const thisMonth = new Date().toISOString().slice(0, 7);
  const f = useForm({ month: thisMonth, title: "", description: "", reading_material: "", discussion_prompts: "", participation: "optional" });
  useEffect(() => {
    if (!open) return;
    f.setValues(existing ? { month: existing.month, title: existing.title, description: existing.description, reading_material: existing.reading_material, discussion_prompts: existing.discussion_prompts, participation: existing.participation } : { month: thisMonth, title: "", description: "", reading_material: "", discussion_prompts: "", participation: "optional" });
    f.setErrors({});
    f.setFormError("");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, existing?.id]);
  const save = () =>
    f.submit(async (v) => {
      if (existing) await api.patch(`/learning/themes/${existing.id}`, v);
      else await api.post("/learning/themes", v);
      toast.success(existing ? "Theme updated" : "Theme created");
      onSaved();
    }, (v): Record<string, string> => (!v.title.trim() ? { title: "Give the theme a title." } : !/^\d{4}-\d{2}$/.test(v.month) ? { month: "Choose a month." } : {}));
  return (
    <Modal open={open} onClose={onClose} wide title={existing ? "Edit theme" : "New monthly theme"} footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" loading={f.submitting} onClick={save}>Save theme</Button></>}>
      <FormError message={f.formError} />
      <div className="form-grid">
        <TextInput label="Month" type="month" required value={f.values.month} onChange={(v) => f.set("month", v)} error={f.errors.month} />
        <SelectInput label="Participation" value={f.values.participation} onChange={(v) => f.set("participation", v)} options={[{ value: "optional", label: "Optional" }, { value: "encouraged", label: "Encouraged" }]} hint="Participation is never tracked per person." />
        <TextInput className="full" label="Title" required value={f.values.title} onChange={(v) => f.set("title", v)} error={f.errors.title} />
        <TextArea className="full" label="Description" rows={3} value={f.values.description} onChange={(v) => f.set("description", v)} />
        <TextArea className="full" label="Discussion prompts" rows={3} value={f.values.discussion_prompts} onChange={(v) => f.set("discussion_prompts", v)} hint="One prompt per line" />
        <TextArea className="full" label="Reading material" rows={3} value={f.values.reading_material} onChange={(v) => f.set("reading_material", v)} hint="Titles or links" />
      </div>
    </Modal>
  );
}

function ThemeDetailPage() {
  const { id } = useParams();
  const toast = useToast();
  const nav = useNavigate();
  const { data, error, loading, reload } = useApi<{ theme: Theme; contributions: LearningRecord[]; can_manage: boolean; ai_available: boolean }>(`/learning/themes/${id}`);
  const [summary, setSummary] = useState("");
  const [draftEngine, setDraftEngine] = useState<string | null>(null);
  const [busy, setBusy] = useState<"" | "save" | "draft">("");
  const [edit, setEdit] = useState(false);
  useEffect(() => { if (data) setSummary(data.theme.summary); }, [data]);
  if (error) return <ErrorState error={error} onRetry={reload} />;
  if (loading && !data) return <Loading />;
  if (!data) return null;
  const t = data.theme;
  const saveSummary = async () => {
    setBusy("save");
    try {
      await api.patch(`/learning/themes/${t.id}`, { summary });
      toast.success("Summary saved");
      setDraftEngine(null);
      reload();
    } catch (e) { toast.error((e as Error).message); } finally { setBusy(""); }
  };
  const draft = async () => {
    setBusy("draft");
    try {
      const r = await api.post<{ engine: string; text: string }>(`/learning/themes/${t.id}/draft-summary`);
      setSummary(r.text);
      setDraftEngine(r.engine);
      toast.info("Draft generated — review and edit before saving");
    } catch (e) { toast.error((e as Error).message); } finally { setBusy(""); }
  };
  return (
    <>
      <PageHeader
        breadcrumbs={[{ label: "Learning", to: "/learning" }, { label: "Themes", to: "/learning/themes" }, { label: t.title }]}
        title={t.title}
        subtitle={`${monthLabel(t.month)} · participation ${t.participation}`}
        actions={<>
          <Button variant="primary" icon="plus" onClick={() => nav(`/learning?new=1&theme=${t.id}`)}>Contribute</Button>
          {data.can_manage && <Button icon="edit" onClick={() => setEdit(true)}>Edit theme</Button>}
        </>}
      />
      <div className="cols-main-side">
        <div className="stack">
          {t.description && <Card title="About this theme"><RichText text={t.description} /></Card>}
          <Card title={`Shared contributions (${data.contributions.length})`}>
            {data.contributions.length ? <div className="grid grid-2">{data.contributions.map((r) => <RecordCard key={r.id} r={r} />)}</div> : <p className="muted small">No contributions yet — be the first.</p>}
          </Card>
          <Card title="Summary of learning" actions={draftEngine && <AIBadge engine={draftEngine} />}>
            {data.can_manage ? (
              <>
                <TextArea label="Summary" rows={6} value={summary} onChange={setSummary} hint={draftEngine ? "AI draft — check it reflects the contributions before saving." : "Synthesise the main insights shared this month."} />
                <div className="row" style={{ justifyContent: "flex-end" }}>
                  {data.ai_available && <Button variant="ai" icon="sparkles" loading={busy === "draft"} disabled={!data.contributions.length} onClick={draft}>Draft with AI</Button>}
                  <Button variant="primary" loading={busy === "save"} onClick={saveSummary} disabled={summary === t.summary}>Save summary</Button>
                </div>
              </>
            ) : t.summary ? <RichText text={t.summary} /> : <p className="muted small">A summary will be added at the end of the month.</p>}
          </Card>
        </div>
        <aside className="stack">
          {t.discussion_prompts && <Card title="Discussion prompts"><RichText text={t.discussion_prompts} className="small" /></Card>}
          {t.reading_material && <Card title="Reading material"><RichText text={t.reading_material} className="small" /></Card>}
        </aside>
      </div>
      <ThemeFormModal open={edit} existing={t} onClose={() => setEdit(false)} onSaved={() => { setEdit(false); reload(); }} />
    </>
  );
}

// =================================================================== improvements
const IMP_FILTERS = ["", "submitted", "under_review", "accepted", "in_progress", "implemented", "deferred", "rejected"];

function ImprovementsPage() {
  const { lookups } = useLookups();
  const nav = useNavigate();
  const [status, setStatus] = useState("");
  const [area, setArea] = useState("");
  const [priority, setPriority] = useState("");
  const [q, setQ] = useState("");
  const dq = useDebounced(q);
  const { data, error, reload } = useApi<{ items: Improvement[]; counts: Record<string, number>; can_manage: boolean }>("/improvements", { status, area, priority, q: dq });
  const [open, setOpen] = useState(false);
  const total = data ? Object.values(data.counts).reduce((a, b) => a + b, 0) : 0;
  return (
    <>
      <PageHeader title="Continuous improvement register" subtitle="Suggest improvements to how CSI works and follow them through." actions={<Button variant="primary" icon="plus" onClick={() => setOpen(true)}>Suggest an improvement</Button>} />
      <SubNav />
      <div className="filter-bar">
        <div className="segmented" role="group" aria-label="Filter by status">
          {IMP_FILTERS.map((s) => (
            <button key={s || "all"} className={status === s ? "active" : ""} aria-pressed={status === s} onClick={() => setStatus(s)}>
              {s ? statusMeta("improvement", s).label : "All"}
              <span className="count">{s ? (data?.counts[s] ?? 0) : total}</span>
            </button>
          ))}
        </div>
      </div>
      <div className="filter-bar">
        <input className="input" type="search" aria-label="Search improvements" placeholder="Search…" value={q} onChange={(e) => setQ(e.target.value)} />
        <select className="select" aria-label="Filter by area" value={area} onChange={(e) => setArea(e.target.value)}>
          <option value="">All areas</option>
          {(lookups?.taxonomies.improvement_area ?? []).map((a) => <option key={a}>{a}</option>)}
        </select>
        <select className="select" aria-label="Filter by priority" value={priority} onChange={(e) => setPriority(e.target.value)}>
          <option value="">Any priority</option>
          {options("priority").map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}
        </select>
      </div>
      {error ? <ErrorState error={error} onRetry={reload} /> : !data ? <Loading /> : data.items.length ? (
        <div className="card table-wrap">
          <table className="table table-stack">
            <thead><tr><th>Improvement</th><th>Area</th><th>Priority</th><th>Status</th><th>Owner</th><th>Review</th></tr></thead>
            <tbody>
              {data.items.map((i) => (
                <tr key={i.id} className="clickable" onClick={() => nav(`/learning/improvements/${i.id}`)}>
                  <td data-label="Improvement"><Link to={`/learning/improvements/${i.id}`} onClick={(e) => e.stopPropagation()}>{i.title}</Link><div className="tiny muted">Suggested by {i.suggested_by_name ?? "former colleague"} · {relTime(i.created_at)}</div></td>
                  <td data-label="Area">{i.area || "—"}</td>
                  <td data-label="Priority">{i.priority === "normal" ? "Normal" : <PriorityBadge value={i.priority} />}</td>
                  <td data-label="Status"><StatusBadge kind="improvement" value={i.status} /></td>
                  <td data-label="Owner">{i.owner_name ?? <span className="muted">Unassigned</span>}</td>
                  <td data-label="Review">{fmtDate(i.review_date)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <EmptyState icon="trending" title="No improvements found" action={<Button variant="primary" onClick={() => setOpen(true)}>Suggest an improvement</Button>}>Spotted something that could work better? Suggest it here.</EmptyState>
      )}
      <ImprovementFormModal open={open} onClose={() => setOpen(false)} onSaved={(i) => { setOpen(false); reload(); nav(`/learning/improvements/${i.id}`); }} />
    </>
  );
}

function ImprovementFormModal({ open, onClose, onSaved, existing }: { open: boolean; onClose: () => void; onSaved: (i: Improvement) => void; existing?: Improvement | null }) {
  const toast = useToast();
  const { lookups } = useLookups();
  const blank = { title: "", description: "", area: "", origin: "", problem: "", proposed_solution: "", potential_benefit: "", priority: "normal", project_id: "" };
  const f = useForm(blank);
  useEffect(() => {
    if (!open) return;
    f.setValues(existing ? { title: existing.title, description: existing.description, area: existing.area, origin: existing.origin, problem: existing.problem, proposed_solution: existing.proposed_solution, potential_benefit: existing.potential_benefit, priority: existing.priority, project_id: existing.project_id ?? "" } : blank);
    f.setErrors({});
    f.setFormError("");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, existing?.id]);
  const save = () =>
    f.submit(async (v) => {
      const body = { ...v, project_id: v.project_id || null };
      const r = existing ? await api.patch<Improvement>(`/improvements/${existing.id}`, body) : await api.post<Improvement>("/improvements", body);
      toast.success(existing ? "Improvement updated" : "Improvement submitted");
      onSaved(r);
    }, (v): Record<string, string> => (!v.title.trim() ? { title: "Give the improvement a title." } : {}));
  return (
    <Modal open={open} onClose={onClose} wide title={existing ? "Edit improvement" : "Suggest an improvement"} footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" loading={f.submitting} onClick={save}>{existing ? "Save changes" : "Submit"}</Button></>}>
      <FormError message={f.formError} />
      <div className="form-grid">
        <TextInput className="full" label="Title" required value={f.values.title} onChange={(v) => f.set("title", v)} error={f.errors.title} />
        <SelectInput label="Area" value={f.values.area} onChange={(v) => f.set("area", v)} placeholder="Choose an area…" options={(lookups?.taxonomies.improvement_area ?? []).map((a) => ({ value: a, label: a }))} />
        <SelectInput label="Priority" value={f.values.priority} onChange={(v) => f.set("priority", v)} options={options("priority")} />
        <TextInput label="Origin" value={f.values.origin} onChange={(v) => f.set("origin", v)} hint="Where did this come from? e.g. a meeting or project" />
        <ProjectSelect value={f.values.project_id} onChange={(v) => f.set("project_id", v)} error={f.errors.project_id} />
        <TextArea className="full" label="What's the problem?" rows={3} value={f.values.problem} onChange={(v) => f.set("problem", v)} />
        <TextArea className="full" label="Proposed solution" rows={3} value={f.values.proposed_solution} onChange={(v) => f.set("proposed_solution", v)} />
        <TextArea className="full" label="Potential benefit" rows={2} value={f.values.potential_benefit} onChange={(v) => f.set("potential_benefit", v)} />
        <TextArea className="full" label="Additional detail" rows={2} value={f.values.description} onChange={(v) => f.set("description", v)} />
      </div>
    </Modal>
  );
}

function ImprovementDetail() {
  const { id } = useParams();
  const toast = useToast();
  const { data, error, loading, reload } = useApi<{
    improvement: Improvement; history: { id: string; from_value: string | null; to_value: string; note: string; changed_by_name: string | null; changed_at: string }[];
    can_edit: boolean; can_manage: boolean; can_assign: boolean;
  }>(`/improvements/${id}`);
  const [edit, setEdit] = useState(false);
  const [wf, setWf] = useState({ status: "", owner_id: "", review_date: "", outcome: "", note: "" });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<Record<string, string>>({});
  useEffect(() => {
    if (data) setWf({ status: data.improvement.status, owner_id: data.improvement.owner_id ?? "", review_date: data.improvement.review_date ?? "", outcome: data.improvement.outcome, note: "" });
  }, [data]);
  if (error) return <ErrorState error={error} onRetry={reload} />;
  if (loading && !data) return <Loading />;
  if (!data) return null;
  const i = data.improvement;
  const saveWorkflow = async () => {
    setBusy(true);
    try {
      const body: Record<string, unknown> = { status: wf.status, review_date: wf.review_date || null, outcome: wf.outcome, note: wf.note };
      if (data.can_assign) body.owner_id = wf.owner_id || null;
      await api.patch(`/improvements/${i.id}`, body);
      toast.success("Improvement updated");
      setErr({});
      reload();
    } catch (e) {
      const x = e as { fields?: Record<string, string>; message: string };
      setErr(x.fields ?? {});
      toast.error(x.message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <PageHeader
        breadcrumbs={[{ label: "Improvement register", to: "/learning/improvements" }, { label: i.title }]}
        title={i.title}
        subtitle={<span className="row"><StatusBadge kind="improvement" value={i.status} /><PriorityBadge value={i.priority} />{i.area && <span>{i.area}</span>}</span>}
        actions={data.can_edit && <Button icon="edit" onClick={() => setEdit(true)}>Edit</Button>}
      />
      <div className="cols-main-side">
        <div className="stack">
          <Card title="Suggestion">
            <div className="stack">
              {([["Problem", i.problem], ["Proposed solution", i.proposed_solution], ["Potential benefit", i.potential_benefit], ["Additional detail", i.description]] as [string, string][])
                .filter(([, v]) => v?.trim())
                .map(([k, v]) => <div key={k}><h3 className="small muted">{k}</h3><RichText text={v} /></div>)}
              {!i.problem && !i.proposed_solution && !i.description && <p className="muted small">No further detail provided.</p>}
            </div>
          </Card>
          {i.outcome && <Card title="Outcome"><RichText text={i.outcome} /></Card>}
          <Card><Comments entityType="improvement" entityId={i.id} /></Card>
        </div>
        <aside className="stack">
          <Card title="Details">
            <KeyValue items={[
              ["Suggested by", <PersonChip name={i.suggested_by_name} />],
              ["Owner", <PersonChip name={i.owner_name} />],
              ["Origin", i.origin || null],
              ["Project", i.project_id ? <Link to={`/projects/${i.project_id}`}>{i.project_name}</Link> : null],
              ["Review date", fmtDate(i.review_date)],
              ["Submitted", fmtDate(i.created_at)],
            ]} />
          </Card>
          {data.can_manage && (
            <Card title="Progress this improvement">
              <SelectInput label="Status" value={wf.status} onChange={(v) => setWf({ ...wf, status: v })} options={options("improvement")} />
              {data.can_assign && <UserSelect label="Owner" value={wf.owner_id} onChange={(v) => setWf({ ...wf, owner_id: v })} placeholder="Unassigned" error={err.owner_id} />}
              <TextInput label="Review date" type="date" value={wf.review_date} onChange={(v) => setWf({ ...wf, review_date: v })} error={err.review_date} />
              <TextArea label="Outcome" rows={3} value={wf.outcome} onChange={(v) => setWf({ ...wf, outcome: v })} />
              <TextInput label="Note on this change (optional)" value={wf.note} onChange={(v) => setWf({ ...wf, note: v })} />
              <Button variant="primary" loading={busy} onClick={saveWorkflow}>Save</Button>
            </Card>
          )}
          <Card title="Status history">
            {data.history.length ? (
              <ul className="timeline">
                {data.history.map((h) => (
                  <li key={h.id}>
                    <span className="tl-dot"><Icon name={statusMeta("improvement", h.to_value).icon} /></span>
                    <div className="small">
                      <strong>{statusMeta("improvement", h.to_value).label}</strong>
                      {h.note && <div className="muted">{h.note}</div>}
                      <div className="tiny muted">{h.changed_by_name ?? "System"} · {relTime(h.changed_at)}</div>
                    </div>
                  </li>
                ))}
              </ul>
            ) : <p className="muted small">No status changes yet.</p>}
          </Card>
        </aside>
      </div>
      <ImprovementFormModal open={edit} existing={i} onClose={() => setEdit(false)} onSaved={() => { setEdit(false); reload(); }} />
    </>
  );
}
