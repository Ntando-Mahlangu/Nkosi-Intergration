import { useEffect, useState } from "react";
import { api, downloadUrl } from "../../lib/api";
import { useApi } from "../../lib/hooks";
import { useAuth, useLookups, useToast } from "../../lib/app-state";
import { humanize } from "../../lib/format";
import { Badge, Button, Callout, Card, Checkbox, ErrorState, FormError, Loading, Modal, SelectInput, TextArea, TextInput } from "../../components/ui";
import { Icon } from "../../components/Icon";
import { errFields } from "./shared";

export default function DataTab() {
  return (
    <div className="stack">
      <ImportWizard />
      <Exports />
      <Retention />
      <PurgeDemo />
    </div>
  );
}

// ------------------------------------------------------------------ import
interface Preview {
  headers: string[];
  fields: { key: string; label: string; required: boolean }[];
  mapping: Record<string, string>;
  missingRequired: string[];
  summary: { total: number; valid: number; invalid: number; duplicates: number };
  rows: { row: number; values: Record<string, string>; errors: string[]; warnings: string[]; duplicate: boolean }[];
}

function ImportWizard() {
  const toast = useToast();
  const { reload: reloadLookups } = useLookups();
  const [step, setStep] = useState(1);
  const [entity, setEntity] = useState("tasks");
  const [csv, setCsv] = useState("");
  const [preview, setPreview] = useState<Preview | null>(null);
  const [mapping, setMapping] = useState<Record<string, string>>({});
  const [skipDuplicates, setSkipDuplicates] = useState(true);
  const [result, setResult] = useState<{ created: number; skippedInvalid: number; skippedDuplicates: number; total: number } | null>(null);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);

  const reset = () => {
    setStep(1); setCsv(""); setPreview(null); setMapping({}); setResult(null); setErr("");
  };
  const onFile = (f: File | undefined) => {
    if (!f) return;
    if (f.size > 1_500_000) return setErr("File is too large (max ~1.5 MB). Split it into smaller files.");
    if (!/\.(csv|txt)$/i.test(f.name)) return setErr("Choose a .csv file. Export Excel or Google Sheets as CSV first.");
    const reader = new FileReader();
    reader.onload = () => setCsv(String(reader.result ?? ""));
    reader.onerror = () => setErr("Could not read that file.");
    reader.readAsText(f);
  };
  const runPreview = async (m?: Record<string, string>) => {
    setErr("");
    setBusy(true);
    try {
      const p = await api.post<Preview>("/admin/import/preview", { entity, csv, mapping: m });
      setPreview(p);
      setMapping(p.mapping);
      setStep(m ? 3 : 2);
    } catch (e) {
      setErr(errFields(e).message);
    } finally {
      setBusy(false);
    }
  };
  const commit = async () => {
    setBusy(true);
    setErr("");
    try {
      const r = await api.post<typeof result>("/admin/import/commit", { entity, csv, mapping, skipInvalid: true, skipDuplicates });
      setResult(r);
      setStep(4);
      toast.success(`Imported ${r!.created} ${entity}`);
      reloadLookups();
    } catch (e) {
      setErr(errFields(e).message);
    } finally {
      setBusy(false);
    }
  };
  const steps = ["Choose data", "Map fields", "Review", "Done"];
  return (
    <Card title="Import from CSV" actions={step > 1 && <Button size="sm" variant="ghost" onClick={reset}>Start over</Button>}>
      <div className="adm-steps" aria-label="Import steps">
        {steps.map((s, i) => <span key={s} className={step === i + 1 ? "on" : ""} aria-current={step === i + 1 ? "step" : undefined}>{i + 1}. {s}</span>)}
      </div>
      <FormError message={err} />
      {step === 1 && (
        <>
          <div className="form-grid">
            <SelectInput label="What are you importing?" value={entity} onChange={setEntity} options={[{ value: "tasks", label: "Tasks (e.g. an existing task register)" }, { value: "projects", label: "Projects (e.g. a project tracker)" }]} />
            <div className="field">
              <label htmlFor="csv-file">Upload CSV file</label>
              <input id="csv-file" className="input" type="file" accept=".csv,text/csv,.txt" onChange={(e) => onFile(e.target.files?.[0])} />
              <span className="hint">From Excel or Google Sheets: File → Download → CSV. <a href={downloadUrl(`/admin/import/template/${entity}.csv`)}>Download a template</a></span>
            </div>
          </div>
          <TextArea label="…or paste CSV text" rows={6} value={csv} onChange={setCsv} placeholder={entity === "tasks" ? "title,assignee_email,project,due_date,priority\nDraft brief,person@example.org,Unmasking,2026-12-01,high" : "name,owner_email,status,start_date,target_date"} />
          <div className="form-actions"><Button variant="primary" disabled={!csv.trim()} loading={busy} onClick={() => runPreview()}>Continue</Button></div>
        </>
      )}
      {step === 2 && preview && (
        <>
          <p className="small muted">We matched your columns where we could. Check each field — unmapped optional fields are left empty. Nothing is saved until you confirm.</p>
          <div className="form-grid">
            {preview.fields.map((f) => (
              <SelectInput key={f.key} label={f.label} required={f.required} value={mapping[f.key] ?? ""} onChange={(v) => setMapping({ ...mapping, [f.key]: v })} placeholder="— not imported —" options={preview.headers.map((hd) => ({ value: hd, label: hd }))} />
            ))}
          </div>
          <div className="form-actions">
            <Button onClick={() => setStep(1)}>Back</Button>
            <Button variant="primary" loading={busy} disabled={preview.fields.some((f) => f.required && !mapping[f.key])} onClick={() => runPreview(Object.fromEntries(Object.entries(mapping).filter(([, v]) => v)))}>Preview import</Button>
          </div>
        </>
      )}
      {step === 3 && preview && (
        <>
          <div className="row mb-2">
            <Badge>{preview.summary.total} rows</Badge>
            <Badge tone="ok" icon="check">{preview.summary.valid} valid</Badge>
            {preview.summary.invalid > 0 && <Badge tone="danger" icon="alertCircle">{preview.summary.invalid} with errors (will be skipped)</Badge>}
            {preview.summary.duplicates > 0 && <Badge tone="warn" icon="alert">{preview.summary.duplicates} possible duplicates</Badge>}
          </div>
          <div className="table-wrap card" style={{ maxHeight: 380, overflowY: "auto" }}>
            <table className="table adm-preview">
              <thead><tr><th>Row</th>{preview.fields.filter((f) => mapping[f.key]).map((f) => <th key={f.key}>{f.label}</th>)}<th>Issues</th></tr></thead>
              <tbody>
                {preview.rows.map((r) => (
                  <tr key={r.row} className={r.errors.length ? "bad" : r.duplicate ? "dup" : ""}>
                    <td>{r.row}</td>
                    {preview.fields.filter((f) => mapping[f.key]).map((f) => <td key={f.key} className="small">{r.values[f.key]}</td>)}
                    <td className={r.errors.length ? "err" : "small muted"}>
                      {r.errors.map((e, i) => <div key={i}><Icon name="alertCircle" size={12} /> {e}</div>)}
                      {r.warnings.map((w, i) => <div key={"w" + i}>{w}</div>)}
                      {!r.errors.length && !r.warnings.length && "OK"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {preview.rows.length < preview.summary.total && <p className="small muted">Showing the first {preview.rows.length} rows.</p>}
          <Checkbox label="Skip possible duplicates" checked={skipDuplicates} onChange={setSkipDuplicates} />
          <div className="form-actions">
            <Button onClick={() => setStep(2)}>Back to mapping</Button>
            <Button variant="primary" loading={busy} disabled={!preview.summary.valid} onClick={commit}>Import {preview.summary.valid - (skipDuplicates ? preview.rows.filter((r) => !r.errors.length && r.duplicate).length : 0)} {entity}</Button>
          </div>
        </>
      )}
      {step === 4 && result && (
        <Callout tone="ok" icon="checkCircle">
          Imported <strong>{result.created}</strong> of {result.total} rows. Skipped {result.skippedInvalid} with errors and {result.skippedDuplicates} possible duplicates. The import is recorded in the audit log.
        </Callout>
      )}
    </Card>
  );
}

// ------------------------------------------------------------------ exports
function Exports() {
  const { data } = useApi<string[]>("/admin/exports");
  return (
    <Card title="Export">
      <p className="small muted">CSV exports include only records <em>you</em> are authorised to see — restricted projects, other people's personal tasks and confidential meetings are excluded even for administrators. Every export is audited.</p>
      <div className="row">
        {(data ?? []).map((e) => (
          <a key={e} className="btn btn-sm" href={downloadUrl(`/admin/export/${e}.csv`)}><Icon name="download" size={14} /> {humanize(e)}</a>
        ))}
      </div>
    </Card>
  );
}

// ------------------------------------------------------------------ retention
interface RetentionRow { key: string; label: string; min: number; days: number }
function Retention() {
  const toast = useToast();
  const { data, error, reload } = useApi<RetentionRow[]>("/admin/retention");
  const [vals, setVals] = useState<Record<string, string>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (data) setVals(Object.fromEntries(data.map((r) => [r.key, String(r.days)])));
  }, [data]);
  if (error) return <ErrorState error={error} onRetry={reload} />;
  if (!data) return <Loading />;
  const save = async () => {
    const body: Record<string, number> = {};
    const e: Record<string, string> = {};
    for (const r of data) {
      const n = Number(vals[r.key]);
      if (!Number.isInteger(n) || n < 0) e[r.key] = "Enter a whole number of days (0 = keep).";
      else body[r.key] = n;
    }
    setErrors(e);
    if (Object.keys(e).length) return;
    setBusy(true);
    try {
      await api.patch("/admin/retention", body);
      toast.success("Retention policy saved");
      reload();
    } catch (err) {
      const x = errFields(err);
      setErrors(x.fields);
      toast.error(x.message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card title="Retention policy" footer={<Button variant="primary" loading={busy} onClick={save}>Save retention policy</Button>}>
      <p className="small muted">Applied daily by the “Retention policy enforcement” automation. 0 means keep indefinitely. Meetings, tasks, reports and knowledge items are business records and are never deleted automatically.</p>
      <div className="form-grid">
        {data.map((r) => (
          <TextInput key={r.key} label={`${r.label} (days)`} type="number" min={0} value={vals[r.key] ?? ""} onChange={(v) => setVals({ ...vals, [r.key]: v })} error={errors[r.key]} hint={`Minimum ${r.min} days unless 0.`} />
        ))}
      </div>
    </Card>
  );
}

// ------------------------------------------------------------------ purge demo
function PurgeDemo() {
  const { me } = useAuth();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [confirm, setConfirm] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  if (!me?.demoMode) return null;
  const purge = async () => {
    setBusy(true);
    setErr("");
    try {
      const r = await api.post<{ deleted: Record<string, number> }>("/admin/purge-demo", { confirm });
      toast.success(`Demo data removed (${Object.values(r.deleted).reduce((a, b) => a + b, 0)} records)`);
      setOpen(false);
      setTimeout(() => window.location.assign("/"), 800);
    } catch (e) {
      setErr(errFields(e).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card title="Demonstration data">
      <p className="small">This workspace contains fictional demonstration records. Before a real pilot, remove them. Records marked as demo (people, projects, tasks, meetings, knowledge, reports…) are deleted permanently; anything created by real users is kept.</p>
      {me.user.is_demo && <Callout tone="warn" icon="info">You are signed in with a demo account, which will be deleted. Create a real administrator account (Users tab) and sign in with it to purge.</Callout>}
      <div className="mt-2"><Button variant="danger" icon="trash" onClick={() => setOpen(true)}>Remove demo data…</Button></div>
      <Modal open={open} onClose={() => setOpen(false)} title="Remove all demonstration data?" footer={<><Button onClick={() => setOpen(false)}>Cancel</Button><Button variant="danger" loading={busy} disabled={confirm !== "DELETE DEMO DATA"} onClick={purge}>Delete permanently</Button></>}>
        <FormError message={err} />
        <p>This cannot be undone. Type <strong>DELETE DEMO DATA</strong> to confirm.</p>
        <TextInput label="Confirmation" value={confirm} onChange={setConfirm} autoComplete="off" />
      </Modal>
    </Card>
  );
}
