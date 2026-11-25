import { useState } from "react";
import { api } from "../../lib/api";
import { useApi } from "../../lib/hooks";
import { useLookups, useToast } from "../../lib/app-state";
import { Button, Card, ConfirmDialog, EmptyState, ErrorState, FormError, Loading, Modal, TextArea, TextInput } from "../../components/ui";
import { UserSelect } from "../../components/records";
import { errFields } from "./shared";

interface TeamRow { id: string; name: string; description: string; lead_id: string | null; lead_name: string | null; member_count: number }

export default function TeamsTab() {
  const { data, error, loading, reload } = useApi<TeamRow[]>("/admin/teams");
  const { reload: reloadLookups } = useLookups();
  const toast = useToast();
  const [editing, setEditing] = useState<TeamRow | "new" | null>(null);
  const [deleting, setDeleting] = useState<TeamRow | null>(null);
  const [busy, setBusy] = useState(false);
  const del = async () => {
    if (!deleting) return;
    setBusy(true);
    try {
      await api.del(`/admin/teams/${deleting.id}`);
      toast.success("Team deleted");
      setDeleting(null);
      reload();
      reloadLookups();
    } catch (e) {
      toast.error(errFields(e).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <Card title="Teams" actions={<Button variant="primary" icon="plus" onClick={() => setEditing("new")}>Add team</Button>} pad={false}>
        {error ? <ErrorState error={error} onRetry={reload} /> : loading && !data ? <Loading /> : !data?.length ? (
          <EmptyState icon="briefcase" title="No teams yet" action={<Button onClick={() => setEditing("new")}>Add the first team</Button>}>Teams group people and can be used for team-visibility projects.</EmptyState>
        ) : (
          <div className="table-wrap">
            <table className="table table-stack">
              <thead><tr><th>Team</th><th>Lead</th><th>Active members</th><th><span className="sr-only">Actions</span></th></tr></thead>
              <tbody>
                {data.map((t) => (
                  <tr key={t.id}>
                    <td data-label="Team"><div className="strong">{t.name}</div>{t.description && <div className="tiny muted">{t.description}</div>}</td>
                    <td data-label="Lead">{t.lead_name ?? <span className="muted">—</span>}</td>
                    <td data-label="Members">{t.member_count}</td>
                    <td data-label="Actions">
                      <div className="row" style={{ justifyContent: "flex-end", gap: 4 }}>
                        <Button size="sm" variant="ghost" onClick={() => setEditing(t)}>Edit</Button>
                        <Button size="sm" variant="danger" onClick={() => setDeleting(t)}>Delete</Button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
      {editing && <TeamForm team={editing === "new" ? null : editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); reload(); reloadLookups(); toast.success("Team saved"); }} />}
      <ConfirmDialog open={!!deleting} busy={busy} danger title={`Delete team "${deleting?.name}"?`} confirmLabel="Delete team" message="Members and projects in this team are kept but will no longer belong to a team. Team-visibility projects may become visible only to their members." onConfirm={del} onClose={() => setDeleting(null)} />
    </>
  );
}

function TeamForm({ team, onClose, onSaved }: { team: TeamRow | null; onClose: () => void; onSaved: () => void }) {
  const [f, setF] = useState({ name: team?.name ?? "", description: team?.description ?? "", lead_id: team?.lead_id ?? "" });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState("");
  const [busy, setBusy] = useState(false);
  const save = async () => {
    if (f.name.trim().length < 2) return setErrors({ name: "Enter a team name." });
    setBusy(true);
    try {
      if (team) await api.patch(`/admin/teams/${team.id}`, f);
      else await api.post("/admin/teams", f);
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
    <Modal open onClose={onClose} title={team ? "Edit team" : "Add team"} footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" loading={busy} onClick={save}>Save</Button></>}>
      <FormError message={formError} />
      <TextInput label="Name" required value={f.name} onChange={(v) => setF({ ...f, name: v })} error={errors.name} />
      <TextArea label="Description" rows={2} value={f.description} onChange={(v) => setF({ ...f, description: v })} />
      <UserSelect label="Team lead" value={f.lead_id} onChange={(v) => setF({ ...f, lead_id: v })} placeholder="No lead" />
    </Modal>
  );
}
