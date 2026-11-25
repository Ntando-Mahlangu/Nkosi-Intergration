import { useState } from "react";
import { api } from "../../lib/api";
import { useApi, useDebounced } from "../../lib/hooks";
import { useAuth, useLookups, useToast } from "../../lib/app-state";
import { fmtDateTime, relTime } from "../../lib/format";
import { Badge, Button, Callout, Card, ConfirmDialog, EmptyState, ErrorState, FormError, Loading, Modal, SelectInput, TextInput, Avatar } from "../../components/ui";
import { SecretModal, errFields } from "./shared";

interface UserRow {
  id: string; name: string; email: string; role_key: string; role_name: string; team_id: string | null; team_name: string | null; job_title: string;
  auth_provider: string; active: number; must_change_password: number; last_login_at: string | null; is_demo: number; has_password: number;
}
interface RoleOpt { key: string; name: string }
interface SessionRow { id: string; created_at: string; last_seen_at: string; expires_at: string; user_agent: string; ip: string }

export default function UsersTab() {
  const { me, can } = useAuth();
  const { lookups, reload: reloadLookups } = useLookups();
  const toast = useToast();
  const [q, setQ] = useState("");
  const [role, setRole] = useState("");
  const [team, setTeam] = useState("");
  const [active, setActive] = useState("1");
  const dq = useDebounced(q);
  const { data, error, loading, reload } = useApi<UserRow[]>("/admin/users", { q: dq, role, team, active });
  const roles = useApi<{ roles: RoleOpt[] }>(can("admin.roles") ? "/admin/roles" : null);
  const roleOpts = roles.data?.roles.map((r) => ({ value: r.key, label: r.name })) ?? [
    { value: "employee", label: "Employee" }, { value: "project_manager", label: "Project Owner / Manager" }, { value: "management", label: "Management" },
    { value: "knowledge_manager", label: "Knowledge Manager / Reporting Coordinator" }, { value: "admin", label: "System Administrator" },
  ];
  const teamOpts = (lookups?.teams ?? []).map((t) => ({ value: t.id, label: t.name }));

  const [editing, setEditing] = useState<UserRow | "new" | null>(null);
  const [secret, setSecret] = useState<{ who: string; pw: string } | null>(null);
  const [confirm, setConfirm] = useState<{ kind: "deactivate" | "reset"; user: UserRow } | null>(null);
  const [busy, setBusy] = useState(false);
  const [sessionsFor, setSessionsFor] = useState<UserRow | null>(null);

  const act = async () => {
    if (!confirm) return;
    setBusy(true);
    try {
      if (confirm.kind === "deactivate") {
        await api.post(`/admin/users/${confirm.user.id}/deactivate`);
        toast.success(`${confirm.user.name} deactivated and signed out`);
      } else {
        const r = await api.post<{ temporaryPassword: string }>(`/admin/users/${confirm.user.id}/reset-password`);
        setSecret({ who: confirm.user.name, pw: r.temporaryPassword });
      }
      setConfirm(null);
      reload();
    } catch (e) {
      toast.error(errFields(e).message);
    } finally {
      setBusy(false);
    }
  };
  const reactivate = async (u: UserRow) => {
    try {
      await api.post(`/admin/users/${u.id}/reactivate`);
      toast.success(`${u.name} reactivated`);
      reload();
      reloadLookups();
    } catch (e) {
      toast.error(errFields(e).message);
    }
  };

  return (
    <div className="stack">
      <Card
        title="Users"
        actions={<Button variant="primary" icon="plus" onClick={() => setEditing("new")}>Add user</Button>}
        pad={false}
      >
        <div className="card-body" style={{ paddingBottom: 0 }}>
          <div className="filter-bar">
            <input className="input" type="search" placeholder="Search name, email or title" aria-label="Search users" value={q} onChange={(e) => setQ(e.target.value)} style={{ minWidth: 220 }} />
            <select className="select" aria-label="Filter by role" value={role} onChange={(e) => setRole(e.target.value)}>
              <option value="">All roles</option>
              {roleOpts.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
            <select className="select" aria-label="Filter by team" value={team} onChange={(e) => setTeam(e.target.value)}>
              <option value="">All teams</option>
              {teamOpts.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
            <select className="select" aria-label="Filter by status" value={active} onChange={(e) => setActive(e.target.value)}>
              <option value="1">Active</option>
              <option value="0">Deactivated</option>
              <option value="">All</option>
            </select>
          </div>
        </div>
        {error ? <ErrorState error={error} onRetry={reload} /> : loading && !data ? <Loading /> : !data?.length ? (
          <EmptyState icon="users" title="No users match these filters" />
        ) : (
          <div className="table-wrap">
            <table className="table table-stack">
              <thead><tr><th>Person</th><th>Role</th><th>Team</th><th>Sign-in</th><th>Last sign-in</th><th><span className="sr-only">Actions</span></th></tr></thead>
              <tbody>
                {data.map((u) => (
                  <tr key={u.id}>
                    <td data-label="Person">
                      <div className="row" style={{ flexWrap: "nowrap" }}>
                        <Avatar name={u.name} size="sm" />
                        <div style={{ minWidth: 0 }}>
                          <div className="strong">{u.name} {u.id === me?.user.id && <span className="muted small">(you)</span>}</div>
                          <div className="tiny muted truncate">{u.email}{u.job_title ? ` · ${u.job_title}` : ""}</div>
                        </div>
                      </div>
                    </td>
                    <td data-label="Role">{u.role_name}</td>
                    <td data-label="Team">{u.team_name ?? <span className="muted">—</span>}</td>
                    <td data-label="Sign-in">
                      <div className="row" style={{ gap: 4 }}>
                        {!u.active && <Badge tone="danger" icon="ban">Deactivated</Badge>}
                        {u.has_password ? <Badge>Password</Badge> : null}
                        {u.auth_provider === "google" && <Badge tone="accent">Google</Badge>}
                        {u.must_change_password ? <Badge tone="warn" icon="lock">Must change password</Badge> : null}
                        {u.is_demo ? <Badge tone="warn">Demo</Badge> : null}
                      </div>
                    </td>
                    <td data-label="Last sign-in" className="small">{u.last_login_at ? relTime(u.last_login_at) : <span className="muted">Never</span>}</td>
                    <td data-label="Actions">
                      <div className="row" style={{ justifyContent: "flex-end", gap: 4 }}>
                        <Button size="sm" variant="ghost" onClick={() => setEditing(u)}>Edit</Button>
                        <Button size="sm" variant="ghost" onClick={() => setSessionsFor(u)}>Sessions</Button>
                        {u.active ? (
                          <>
                            <Button size="sm" variant="ghost" onClick={() => setConfirm({ kind: "reset", user: u })}>Reset password</Button>
                            {u.id !== me?.user.id && <Button size="sm" variant="danger" onClick={() => setConfirm({ kind: "deactivate", user: u })}>Deactivate</Button>}
                          </>
                        ) : (
                          <Button size="sm" onClick={() => reactivate(u)}>Reactivate</Button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
      <Callout icon="info">
        Users are never deleted — deactivating removes access immediately while preserving their history (tasks, decisions, audit records).
        Google Workspace sign-in only works for accounts provisioned here.
      </Callout>

      {editing && (
        <UserForm
          user={editing === "new" ? null : editing}
          roleOpts={roleOpts}
          teamOpts={teamOpts}
          onClose={() => setEditing(null)}
          onSaved={(pw, name) => {
            setEditing(null);
            reload();
            reloadLookups();
            if (pw) setSecret({ who: name, pw });
            else toast.success("User saved");
          }}
        />
      )}
      <SecretModal open={!!secret} title="Temporary password" who={secret?.who ?? ""} secret={secret?.pw ?? null} onClose={() => setSecret(null)} />
      <ConfirmDialog
        open={!!confirm}
        busy={busy}
        danger={confirm?.kind === "deactivate"}
        title={confirm?.kind === "deactivate" ? `Deactivate ${confirm.user.name}?` : `Reset password for ${confirm?.user.name}?`}
        confirmLabel={confirm?.kind === "deactivate" ? "Deactivate" : "Reset password"}
        message={confirm?.kind === "deactivate" ? "They will be signed out everywhere and can no longer sign in. Their records are kept and you can reactivate them later." : "A new one-time password will be generated, all their sessions will be signed out, and they must choose a new password at next sign-in."}
        onConfirm={act}
        onClose={() => setConfirm(null)}
      />
      {sessionsFor && <SessionsModal user={sessionsFor} onClose={() => setSessionsFor(null)} />}
    </div>
  );
}

function UserForm({ user, roleOpts, teamOpts, onClose, onSaved }: { user: UserRow | null; roleOpts: { value: string; label: string }[]; teamOpts: { value: string; label: string }[]; onClose: () => void; onSaved: (pw: string | null, name: string) => void }) {
  const [f, setF] = useState({ name: user?.name ?? "", email: user?.email ?? "", role_key: user?.role_key ?? "employee", team_id: user?.team_id ?? "", job_title: user?.job_title ?? "", auth: "password" });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState("");
  const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof f, v: string) => setF((s) => ({ ...s, [k]: v }));
  const save = async () => {
    const e: Record<string, string> = {};
    if (f.name.trim().length < 2) e.name = "Enter the person's full name.";
    if (!user && !/^\S+@\S+\.\S+$/.test(f.email)) e.email = "Enter a valid email address.";
    setErrors(e);
    if (Object.keys(e).length) return;
    setBusy(true);
    setFormError("");
    try {
      if (user) {
        await api.patch(`/admin/users/${user.id}`, { name: f.name, role_key: f.role_key, team_id: f.team_id, job_title: f.job_title });
        onSaved(null, f.name);
      } else {
        const r = await api.post<{ temporaryPassword: string | null }>("/admin/users", f);
        onSaved(r.temporaryPassword, f.name);
      }
    } catch (err) {
      const x = errFields(err);
      setFormError(x.message);
      setErrors(x.fields);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal open onClose={onClose} title={user ? `Edit ${user.name}` : "Add user"} footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" onClick={save} loading={busy}>{user ? "Save changes" : "Create user"}</Button></>}>
      <FormError message={formError} />
      <TextInput label="Full name" required value={f.name} onChange={(v) => set("name", v)} error={errors.name} />
      <TextInput label="Email" type="email" required value={f.email} onChange={(v) => set("email", v)} error={errors.email} disabled={!!user} hint={user ? "Email addresses identify accounts and cannot be changed." : undefined} />
      <div className="form-grid">
        <SelectInput label="Role" required value={f.role_key} onChange={(v) => set("role_key", v)} options={roleOpts} error={errors.role_key} />
        <SelectInput label="Team" value={f.team_id} onChange={(v) => set("team_id", v)} options={teamOpts} placeholder="No team" error={errors.team_id} />
      </div>
      <TextInput label="Job title" value={f.job_title} onChange={(v) => set("job_title", v)} />
      {!user && (
        <SelectInput label="Sign-in method" value={f.auth} onChange={(v) => set("auth", v)} options={[{ value: "password", label: "Temporary password (shown once)" }, { value: "google", label: "Google Workspace only (no password)" }]} hint="Google sign-in must be configured under Integrations for Google-only accounts to sign in." />
      )}
      {user && user.role_key !== f.role_key && <Callout tone="warn" icon="shield">Changing a role changes what this person can access. They will be signed out so new permissions apply cleanly. The change is recorded in the audit log.</Callout>}
    </Modal>
  );
}

function SessionsModal({ user, onClose }: { user: UserRow; onClose: () => void }) {
  const toast = useToast();
  const { data, loading, reload } = useApi<SessionRow[]>(`/admin/users/${user.id}/sessions`);
  const [busy, setBusy] = useState(false);
  const revoke = async () => {
    setBusy(true);
    try {
      const r = await api.del<{ revoked: number }>(`/admin/users/${user.id}/sessions`);
      toast.success(`${r.revoked} session(s) signed out`);
      reload();
    } catch (e) {
      toast.error(errFields(e).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal open onClose={onClose} title={`Active sessions — ${user.name}`} wide footer={<><Button onClick={onClose}>Close</Button><Button variant="danger" onClick={revoke} loading={busy} disabled={!data?.length}>Sign out all sessions</Button></>}>
      {loading && !data ? <Loading /> : !data?.length ? <EmptyState icon="lock" title="No active sessions" /> : (
        <div className="table-wrap">
          <table className="table">
            <thead><tr><th>Started</th><th>Last seen</th><th>Expires</th><th>Device</th><th>IP</th></tr></thead>
            <tbody>
              {data.map((s) => (
                <tr key={s.id}><td>{fmtDateTime(s.created_at)}</td><td>{relTime(s.last_seen_at)}</td><td>{fmtDateTime(s.expires_at)}</td><td className="small truncate" style={{ maxWidth: 260 }}>{s.user_agent || "—"}</td><td className="small">{s.ip || "—"}</td></tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Modal>
  );
}
