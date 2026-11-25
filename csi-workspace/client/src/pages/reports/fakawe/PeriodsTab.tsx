import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../../../lib/api";
import { useApi } from "../../../lib/hooks";
import { useLookups, useToast } from "../../../lib/app-state";
import { fmtDate } from "../../../lib/format";
import { Button, ConfirmDialog, EmptyState, ErrorState, FormError, Loading, Modal, SelectInput, StatusBadge, TextInput, Field } from "../../../components/ui";
import { UserSelect } from "../../../components/records";
import type { PeriodRow } from "./shared";

interface Form {
  name: string;
  frequency: string;
  start_date: string;
  end_date: string;
  submission_deadline: string;
  owner_id: string;
  approver_id: string;
  recipients: string[];
}
const empty: Form = { name: "", frequency: "weekly", start_date: "", end_date: "", submission_deadline: "", owner_id: "", approver_id: "", recipients: [] };

export function PeriodFormModal({ open, onClose, onSaved, period }: { open: boolean; onClose: () => void; onSaved: () => void; period?: PeriodRow | null }) {
  const toast = useToast();
  const { lookups } = useLookups();
  const [form, setForm] = useState<Form>(empty);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!open) return;
    setErrors({});
    setErr("");
    setForm(
      period
        ? { name: period.name, frequency: period.frequency, start_date: period.start_date, end_date: period.end_date, submission_deadline: period.submission_deadline ?? "", owner_id: period.owner_id ?? "", approver_id: period.approver_id ?? "", recipients: period.recipients ?? [] }
        : empty,
    );
  }, [open, period]);
  const set = <K extends keyof Form>(k: K, v: Form[K]) => setForm((f) => ({ ...f, [k]: v }));
  const save = async () => {
    const e: Record<string, string> = {};
    if (!form.start_date) e.start_date = "Choose a start date.";
    if (form.frequency === "custom" && !form.end_date) e.end_date = "Choose an end date.";
    if (form.frequency === "custom" && form.end_date && form.start_date && form.end_date < form.start_date) e.end_date = "Must be on or after the start date.";
    setErrors(e);
    if (Object.keys(e).length) return setErr("Please check the highlighted fields.");
    setBusy(true);
    setErr("");
    const body = { ...form, name: form.name || undefined, end_date: form.frequency === "custom" ? form.end_date : null, submission_deadline: form.submission_deadline || null, owner_id: form.owner_id || null, approver_id: form.approver_id || null };
    try {
      if (period) await api.patch(`/fakawe/${period.id}`, body);
      else await api.post("/fakawe", body);
      toast.success(period ? "Reporting period updated" : "Reporting period created");
      onSaved();
      onClose();
    } catch (x) {
      const ex = x as { message: string; fields?: Record<string, string> };
      setErr(ex.message);
      setErrors(ex.fields ?? {});
    } finally {
      setBusy(false);
    }
  };
  const users = lookups?.users ?? [];
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={period ? "Edit reporting period" : "New reporting period"}
      wide
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={save} loading={busy}>
            {period ? "Save changes" : "Create period"}
          </Button>
        </>
      }
    >
      <FormError message={err} />
      <div className="form-grid">
        <TextInput className="full" label="Name" value={form.name} onChange={(v) => set("name", v)} error={errors.name} hint="Optional — a name is generated from the dates if left blank." />
        <SelectInput
          label="Frequency"
          required
          value={form.frequency}
          onChange={(v) => set("frequency", v)}
          options={[
            { value: "weekly", label: "Weekly (7 days)" },
            { value: "biweekly", label: "Biweekly (14 days)" },
            { value: "monthly", label: "Monthly (to month end)" },
            { value: "custom", label: "Custom dates" },
          ]}
        />
        <TextInput label="Start date" type="date" required value={form.start_date} onChange={(v) => set("start_date", v)} error={errors.start_date} />
        {form.frequency === "custom" ? (
          <TextInput label="End date" type="date" required value={form.end_date} onChange={(v) => set("end_date", v)} error={errors.end_date} />
        ) : (
          <div className="field">
            <span className="label">End date</span>
            <span className="small muted">Calculated from the frequency.</span>
          </div>
        )}
        <TextInput label="Submission deadline" type="date" value={form.submission_deadline} onChange={(v) => set("submission_deadline", v)} error={errors.submission_deadline} hint="Defaults to the period end date." />
        <UserSelect label="Report owner" value={form.owner_id} onChange={(v) => set("owner_id", v)} placeholder="Me" />
        <UserSelect label="Approver" value={form.approver_id} onChange={(v) => set("approver_id", v)} placeholder="No approver" hint="Receives a notification when a draft is generated." />
        <Field label="Recipients" className="full" hint="People who should receive the approved digest. Distribution never goes beyond the report's audience.">
          <div className="row" style={{ gap: 4 }}>
            {users.map((u) => {
              const on = form.recipients.includes(u.id);
              return (
                <button type="button" key={u.id} className={`btn btn-sm ${on ? "btn-primary" : ""}`} aria-pressed={on} onClick={() => set("recipients", on ? form.recipients.filter((x) => x !== u.id) : [...form.recipients, u.id])}>
                  {u.name}
                </button>
              );
            })}
          </div>
        </Field>
      </div>
    </Modal>
  );
}

export default function PeriodsTab({ canManage, createOpen, setCreateOpen }: { canManage: boolean; createOpen: boolean; setCreateOpen: (v: boolean) => void }) {
  const { data, loading, error, reload } = useApi<{ items: PeriodRow[] }>("/fakawe");
  const toast = useToast();
  const [edit, setEdit] = useState<PeriodRow | null>(null);
  const [archive, setArchive] = useState<PeriodRow | null>(null);
  const [busy, setBusy] = useState(false);
  if (loading && !data) return <Loading />;
  if (error) return <ErrorState error={error} onRetry={reload} />;
  const rows = data?.items ?? [];
  const doArchive = async () => {
    if (!archive) return;
    setBusy(true);
    try {
      await api.post(`/fakawe/${archive.id}/archive`);
      toast.success("Period archived");
      setArchive(null);
      reload();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="stack">
      {canManage && (
        <div className="row" style={{ justifyContent: "flex-end" }}>
          <Button variant="primary" icon="plus" onClick={() => setCreateOpen(true)}>
            New reporting period
          </Button>
        </div>
      )}
      {rows.length === 0 ? (
        <EmptyState icon="calendar" title="No reporting periods yet">Reporting periods define the dates a Fakawe digest covers.</EmptyState>
      ) : (
        <div className="card table-wrap">
          <table className="table table-stack">
            <thead>
              <tr>
                <th>Period</th>
                <th>Dates</th>
                <th>Deadline</th>
                <th>Owner</th>
                <th>Status</th>
                <th>Report</th>
                {canManage && <th><span className="sr-only">Actions</span></th>}
              </tr>
            </thead>
            <tbody>
              {rows.map((p) => (
                <tr key={p.id}>
                  <td data-label="Period" className="strong">{p.name}</td>
                  <td data-label="Dates">{fmtDate(p.start_date)} – {fmtDate(p.end_date)}</td>
                  <td data-label="Deadline">{fmtDate(p.submission_deadline)}</td>
                  <td data-label="Owner">{p.owner_name ?? "—"}</td>
                  <td data-label="Status"><StatusBadge kind="period" value={p.status} /></td>
                  <td data-label="Report">{p.report_id ? <Link to={`/reports/${p.report_id}`}><StatusBadge kind="report" value={p.report_status} /></Link> : <span className="muted small">Not generated</span>}</td>
                  {canManage && (
                    <td>
                      {p.status !== "archived" && (
                        <div className="row" style={{ justifyContent: "flex-end" }}>
                          <Button size="sm" icon="edit" onClick={() => setEdit(p)}>Edit</Button>
                          <Button size="sm" icon="archive" variant="ghost" onClick={() => setArchive(p)}>Archive</Button>
                        </div>
                      )}
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <PeriodFormModal open={createOpen || !!edit} period={edit} onClose={() => { setCreateOpen(false); setEdit(null); }} onSaved={reload} />
      <ConfirmDialog open={!!archive} title="Archive reporting period?" message={`"${archive?.name}" will be closed. Its report remains available in the archive.`} confirmLabel="Archive" onConfirm={doArchive} onClose={() => setArchive(null)} busy={busy} />
    </div>
  );
}
