import { useState } from "react";
import { api } from "../../lib/api";
import { useApi } from "../../lib/hooks";
import { useToast } from "../../lib/app-state";
import { Badge, Button, Card, Checkbox, ConfirmDialog, EmptyState, ErrorState, FormError, Loading, Modal, SelectInput, TextInput } from "../../components/ui";
import { Icon } from "../../components/Icon";
import { errFields } from "./shared";

interface Section { key: string; title: string; enabled: boolean }
interface Template { id: string; report_type: string; name: string; header_text: string; sections: Section[]; is_default: number; active: number }
const TYPE_LABEL: Record<string, string> = { call_report: "Call reports", fakawe: "Fakawe digests", project_report: "Project reports" };

export default function TemplatesTab() {
  const { data, error, loading, reload } = useApi<Template[]>("/admin/templates");
  const toast = useToast();
  const [editing, setEditing] = useState<Template | "new" | null>(null);
  const [deleting, setDeleting] = useState<Template | null>(null);
  if (error) return <ErrorState error={error} onRetry={reload} />;
  if (loading && !data) return <Loading />;
  const del = async () => {
    try {
      await api.del(`/admin/templates/${deleting!.id}`);
      toast.success("Template deleted");
      reload();
    } catch (e) {
      toast.error(errFields(e).message);
    }
    setDeleting(null);
  };
  return (
    <div className="stack">
      <div className="row-between">
        <p className="muted small" style={{ margin: 0 }}>Templates control which sections appear in generated reports and in what order. Empty sections are omitted automatically.</p>
        <Button variant="primary" icon="plus" onClick={() => setEditing("new")}>New template</Button>
      </div>
      {Object.keys(TYPE_LABEL).map((type) => {
        const list = (data ?? []).filter((t) => t.report_type === type);
        return (
          <Card key={type} title={TYPE_LABEL[type]} pad={false}>
            {!list.length ? <EmptyState icon="report" title="No templates" /> : (
              <div className="list">
                {list.map((t) => (
                  <div className="list-item" key={t.id}>
                    <Icon name="report" />
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div className="title">{t.name} {t.is_default ? <Badge tone="accent" icon="check">Default</Badge> : null} {!t.active && <Badge>Inactive</Badge>}</div>
                      <div className="meta">{t.sections.filter((s) => s.enabled).map((s) => s.title).join(" · ")}</div>
                    </div>
                    <Button size="sm" variant="ghost" onClick={() => setEditing(t)}>Edit</Button>
                    {!t.is_default && <Button size="sm" variant="danger" onClick={() => setDeleting(t)}>Delete</Button>}
                  </div>
                ))}
              </div>
            )}
          </Card>
        );
      })}
      {editing && <TemplateForm tpl={editing === "new" ? null : editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); reload(); toast.success("Template saved"); }} />}
      <ConfirmDialog open={!!deleting} danger title={`Delete template "${deleting?.name}"?`} confirmLabel="Delete" message="Existing reports keep their content. Reporting periods using this template will fall back to the default." onConfirm={del} onClose={() => setDeleting(null)} />
    </div>
  );
}

function TemplateForm({ tpl, onClose, onSaved }: { tpl: Template | null; onClose: () => void; onSaved: () => void }) {
  const [f, setF] = useState({
    report_type: tpl?.report_type ?? "call_report",
    name: tpl?.name ?? "",
    header_text: tpl?.header_text ?? "Change Science Institute",
    sections: tpl?.sections ?? [{ key: "overview", title: "Overview", enabled: true }],
    is_default: !!tpl?.is_default,
    active: tpl ? !!tpl.active : true,
  });
  const [newSection, setNewSection] = useState("");
  const [formError, setFormError] = useState("");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const upd = (i: number, patch: Partial<Section>) => setF({ ...f, sections: f.sections.map((s, j) => (j === i ? { ...s, ...patch } : s)) });
  const move = (i: number, d: number) => {
    const s = [...f.sections];
    const j = i + d;
    if (j < 0 || j >= s.length) return;
    [s[i], s[j]] = [s[j], s[i]];
    setF({ ...f, sections: s });
  };
  const addSection = () => {
    const title = newSection.trim();
    if (!title) return;
    let key = title.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "").slice(0, 40) || "section";
    while (f.sections.some((s) => s.key === key)) key = `${key.slice(0, 36)}_${Math.floor(Math.random() * 99)}`;
    setF({ ...f, sections: [...f.sections, { key, title, enabled: true }] });
    setNewSection("");
  };
  const save = async () => {
    if (!f.name.trim()) return setErrors({ name: "Enter a template name." });
    setBusy(true);
    try {
      if (tpl) {
        const { report_type: _t, ...rest } = f;
        void _t;
        await api.patch(`/admin/templates/${tpl.id}`, rest);
      } else await api.post("/admin/templates", f);
      onSaved();
    } catch (e) {
      const x = errFields(e);
      setFormError(x.message);
      setErrors(x.fields);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal open wide onClose={onClose} title={tpl ? `Edit template — ${tpl.name}` : "New report template"} footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" loading={busy} onClick={save}>Save template</Button></>}>
      <FormError message={formError} />
      <div className="form-grid">
        <SelectInput label="Report type" value={f.report_type} onChange={(v) => setF({ ...f, report_type: v })} disabled={!!tpl} options={Object.entries(TYPE_LABEL).map(([value, label]) => ({ value, label }))} />
        <TextInput label="Template name" required value={f.name} onChange={(v) => setF({ ...f, name: v })} error={errors.name} />
        <TextInput label="Header text" className="full" value={f.header_text} onChange={(v) => setF({ ...f, header_text: v })} />
      </div>
      <fieldset>
        <legend>Sections (in order)</legend>
        {errors.sections && <div className="error small">{errors.sections}</div>}
        {f.sections.map((s, i) => (
          <div key={s.key} className="adm-term">
            <input type="checkbox" checked={s.enabled} onChange={(e) => upd(i, { enabled: e.target.checked })} aria-label={`Include ${s.title}`} />
            <input className="input adm-term-label" value={s.title} onChange={(e) => upd(i, { title: e.target.value })} aria-label="Section title" />
            <button className="btn btn-ghost btn-sm" onClick={() => move(i, -1)} disabled={i === 0} aria-label={`Move ${s.title} up`}>↑</button>
            <button className="btn btn-ghost btn-sm" onClick={() => move(i, 1)} disabled={i === f.sections.length - 1} aria-label={`Move ${s.title} down`}>↓</button>
            <button className="btn btn-ghost btn-sm" onClick={() => setF({ ...f, sections: f.sections.filter((_, j) => j !== i) })} disabled={f.sections.length === 1} aria-label={`Remove ${s.title}`}><Icon name="trash" size={14} /></button>
          </div>
        ))}
        <form className="row mt-1" onSubmit={(e) => { e.preventDefault(); addSection(); }}>
          <input className="input" style={{ flex: 1 }} placeholder="Add a custom section" aria-label="New section title" value={newSection} onChange={(e) => setNewSection(e.target.value)} />
          <Button size="sm" type="submit" icon="plus" disabled={!newSection.trim()}>Add section</Button>
        </form>
        <p className="tiny muted mt-1">Custom sections appear in generated drafts for people to fill in; built-in sections are populated from source records.</p>
      </fieldset>
      <Checkbox label="Default template for this report type" checked={f.is_default} onChange={(v) => setF({ ...f, is_default: v })} />
      <Checkbox label="Active" checked={f.active} onChange={(v) => setF({ ...f, active: v })} />
    </Modal>
  );
}
