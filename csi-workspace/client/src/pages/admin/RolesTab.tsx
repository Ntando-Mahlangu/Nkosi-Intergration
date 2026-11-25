import React, { useEffect, useState } from "react";
import { api } from "../../lib/api";
import { useApi } from "../../lib/hooks";
import { useAuth, useToast } from "../../lib/app-state";
import { Badge, Button, Callout, Card, ErrorState, FormError, Loading, Modal, TextArea, TextInput, ConfirmDialog } from "../../components/ui";
import { errFields } from "./shared";

interface Role { key: string; name: string; description: string; permissions: string[]; is_system: number; user_count: number }

const GROUPS: { label: string; prefix: string[] }[] = [
  { label: "Projects & tasks", prefix: ["project.", "programme.", "task.", "meeting."] },
  { label: "Reporting", prefix: ["report.", "fakawe."] },
  { label: "Knowledge & learning", prefix: ["knowledge.", "learning.", "ai."] },
  { label: "Opportunities", prefix: ["opportunity."] },
  { label: "Management", prefix: ["management.", "decision."] },
  { label: "Administration", prefix: ["admin."] },
];

export default function RolesTab() {
  const { refresh } = useAuth();
  const toast = useToast();
  const { data, error, loading, reload } = useApi<{ roles: Role[]; catalogue: Record<string, string> }>("/admin/roles");
  const [draft, setDraft] = useState<Record<string, string[]>>({});
  const [saving, setSaving] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [deleting, setDeleting] = useState<Role | null>(null);
  useEffect(() => {
    if (data) setDraft(Object.fromEntries(data.roles.map((r) => [r.key, [...r.permissions]])));
  }, [data]);

  if (error) return <ErrorState error={error} onRetry={reload} />;
  if (loading || !data) return <Loading />;
  const perms = Object.keys(data.catalogue);
  const dirty = (r: Role) => JSON.stringify([...(draft[r.key] ?? [])].sort()) !== JSON.stringify([...r.permissions].sort());
  const toggle = (role: string, p: string) => setDraft((d) => ({ ...d, [role]: d[role]?.includes(p) ? d[role].filter((x) => x !== p) : [...(d[role] ?? []), p] }));
  const save = async (r: Role) => {
    setSaving(r.key);
    try {
      await api.patch(`/admin/roles/${r.key}`, { permissions: draft[r.key] });
      toast.success(`${r.name} permissions saved`);
      await reload();
      refresh();
    } catch (e) {
      toast.error(errFields(e).message);
    } finally {
      setSaving(null);
    }
  };
  const del = async () => {
    if (!deleting) return;
    try {
      await api.del(`/admin/roles/${deleting.key}`);
      toast.success("Role deleted");
      setDeleting(null);
      reload();
    } catch (e) {
      toast.error(errFields(e).message);
      setDeleting(null);
    }
  };

  return (
    <div className="stack">
      <Callout icon="shield">
        Permissions are enforced on the server for every request. Roles are deliberately separate from privacy: no role — including Management or System Administrator —
        can see restricted projects they are not a member of, other people's personal tasks, confidential meetings or private learning records.
      </Callout>
      <Card title="Roles & permissions" actions={<Button variant="primary" icon="plus" onClick={() => setCreating(true)}>Custom role</Button>} pad={false}>
        <div className="table-wrap">
          <table className="table adm-matrix">
            <thead>
              <tr>
                <th>Permission</th>
                {data.roles.map((r) => (
                  <th key={r.key} title={r.description} style={{ minWidth: 110 }}>
                    <div style={{ textTransform: "none", letterSpacing: 0 }}>{r.name}</div>
                    <div className="tiny muted" style={{ textTransform: "none", fontWeight: 400 }}>{r.user_count} active user{r.user_count === 1 ? "" : "s"}</div>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {GROUPS.map((g) => {
                const rows = perms.filter((p) => g.prefix.some((x) => p.startsWith(x)));
                if (!rows.length) return null;
                return (
                  <React.Fragment key={g.label}>
                    <tr className="group"><td colSpan={data.roles.length + 1}>{g.label}</td></tr>
                    {rows.map((p) => (
                      <tr key={p}>
                        <td><div className="small strong">{data.catalogue[p]}</div><div className="tiny muted">{p}</div></td>
                        {data.roles.map((r) => (
                          <td key={r.key}>
                            <input type="checkbox" aria-label={`${r.name}: ${data.catalogue[p]}`} checked={!!draft[r.key]?.includes(p)} onChange={() => toggle(r.key, p)} />
                          </td>
                        ))}
                      </tr>
                    ))}
                  </React.Fragment>
                );
              })}
              <tr>
                <td className="small muted">Save or remove</td>
                {data.roles.map((r) => (
                  <td key={r.key}>
                    <div className="stack-sm" style={{ alignItems: "center" }}>
                      <Button size="sm" variant={dirty(r) ? "primary" : "secondary"} disabled={!dirty(r)} loading={saving === r.key} onClick={() => save(r)}>Save</Button>
                      {r.is_system ? <Badge>Built-in</Badge> : <Button size="sm" variant="ghost" onClick={() => setDeleting(r)}>Delete</Button>}
                    </div>
                  </td>
                ))}
              </tr>
            </tbody>
          </table>
        </div>
      </Card>
      <p className="small muted">Safeguard: changes that would leave no active user able to manage roles are refused. All changes are audited as “permission.change”.</p>
      {creating && <NewRole perms={perms} catalogue={data.catalogue} onClose={() => setCreating(false)} onSaved={() => { setCreating(false); reload(); toast.success("Role created"); }} />}
      <ConfirmDialog open={!!deleting} danger title={`Delete role "${deleting?.name}"?`} confirmLabel="Delete role" message="Only roles with no users (active or deactivated) can be deleted." onConfirm={del} onClose={() => setDeleting(null)} />
    </div>
  );
}

function NewRole({ perms, catalogue, onClose, onSaved }: { perms: string[]; catalogue: Record<string, string>; onClose: () => void; onSaved: () => void }) {
  const [f, setF] = useState({ key: "", name: "", description: "", permissions: ["meeting.create", "knowledge.contribute", "ai.use"] as string[] });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState("");
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    try {
      await api.post("/admin/roles", f);
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
    <Modal open wide onClose={onClose} title="Create custom role" footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" loading={busy} onClick={save}>Create role</Button></>}>
      <FormError message={formError} />
      <div className="form-grid">
        <TextInput label="Name" required value={f.name} onChange={(v) => setF({ ...f, name: v, key: f.key || v.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "") })} error={errors.name} />
        <TextInput label="Key" required value={f.key} onChange={(v) => setF({ ...f, key: v })} error={errors.key} hint="Lowercase identifier, e.g. finance_officer" />
      </div>
      <TextArea label="Description" rows={2} value={f.description} onChange={(v) => setF({ ...f, description: v })} />
      <fieldset>
        <legend>Permissions</legend>
        {perms.map((p) => (
          <label key={p} className="check" style={{ display: "flex", marginBottom: 6 }}>
            <input type="checkbox" checked={f.permissions.includes(p)} onChange={() => setF({ ...f, permissions: f.permissions.includes(p) ? f.permissions.filter((x) => x !== p) : [...f.permissions, p] })} />
            <span className="small">{catalogue[p]} <span className="muted tiny">({p})</span></span>
          </label>
        ))}
      </fieldset>
    </Modal>
  );
}
