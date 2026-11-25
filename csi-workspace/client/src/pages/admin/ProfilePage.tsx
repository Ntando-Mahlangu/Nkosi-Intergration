import { useEffect, useState } from "react";
import { useLocation } from "react-router-dom";
import { api } from "../../lib/api";
import { useApi } from "../../lib/hooks";
import { useAuth, useLookups, useToast } from "../../lib/app-state";
import { Avatar, Badge, Button, Callout, Card, FormError, KeyValue, Loading, PageHeader, TextInput } from "../../components/ui";
import { ChangePasswordForm } from "../ChangePassword";
import "./admin.css";

interface NtfType { key: string; label: string; muted: boolean; mutable: boolean }

export default function ProfilePage() {
  const { me, refresh } = useAuth();
  const { lookups, reload: reloadLookups } = useLookups();
  const toast = useToast();
  const loc = useLocation();
  const [name, setName] = useState(me?.user.name ?? "");
  const [title, setTitle] = useState(me?.user.job_title ?? "");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (loc.hash === "#notifications") setTimeout(() => document.getElementById("notifications")?.scrollIntoView({ behavior: "smooth" }), 100);
  }, [loc.hash]);
  if (!me) return <Loading />;
  const team = lookups?.teams.find((t) => t.id === me.user.team_id)?.name;

  const saveProfile = async (e: React.FormEvent) => {
    e.preventDefault();
    if (name.trim().length < 2) return setErrors({ name: "Enter your full name." });
    setBusy(true);
    setFormError("");
    try {
      await api.patch("/me", { name: name.trim(), job_title: title.trim() });
      toast.success("Profile updated");
      setErrors({});
      refresh();
      reloadLookups();
    } catch (err) {
      const x = err as { message: string; fields?: Record<string, string> };
      setFormError(x.message);
      setErrors(x.fields ?? {});
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <PageHeader title="Profile & preferences" />
      <div className="grid grid-2" style={{ alignItems: "start" }}>
        <div className="stack">
          <Card title="Your profile">
            <div className="row mb-2">
              <Avatar name={me.user.name} size="lg" />
              <div>
                <div className="strong">{me.user.name}</div>
                <div className="small muted">{me.user.email}</div>
              </div>
            </div>
            <form onSubmit={saveProfile} noValidate>
              <FormError message={formError} />
              <TextInput label="Full name" required value={name} onChange={setName} error={errors.name} />
              <TextInput label="Job title" value={title} onChange={setTitle} error={errors.job_title} />
              <Button type="submit" variant="primary" loading={busy}>Save profile</Button>
            </form>
          </Card>
          <Card title="Access">
            <KeyValue items={[
              ["Role", me.user.role_name],
              ["Team", team ?? "—"],
              ["Sign-in", me.user.has_password ? "Password" : "Google Workspace"],
            ]} />
            <p className="small muted mt-2">Your role and team are managed by an administrator. Access to projects also depends on project membership.</p>
          </Card>
          <Card title="AI assistance">
            <div className="row mb-1"><Badge tone="ai" icon="sparkles">{me.ai.aiAvailable ? "AI available" : "Rule-based only"}</Badge></div>
            <p className="small">{me.ai.note}</p>
          </Card>
        </div>
        <div className="stack">
          <Card title={me.user.has_password ? "Change password" : "Set a password"}>
            {!me.user.has_password && <p className="small muted">You sign in with Google. Setting a password is optional and lets you sign in with email too.</p>}
            <ChangePasswordForm requireCurrent={me.user.has_password} onDone={refresh} />
            <p className="tiny muted mt-1">Changing your password signs you out on other devices.</p>
          </Card>
          <NotificationPrefs />
        </div>
      </div>
    </>
  );
}

function NotificationPrefs() {
  const toast = useToast();
  const { refresh } = useAuth();
  const { data, loading, reload } = useApi<{ types: NtfType[] }>("/notifications/types");
  const [muted, setMuted] = useState<string[] | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (data) setMuted(data.types.filter((t) => t.muted).map((t) => t.key));
  }, [data]);
  const save = async () => {
    setBusy(true);
    try {
      await api.patch("/notifications/preferences", { mutedNotifications: muted });
      toast.success("Notification preferences saved");
      reload();
      refresh();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div id="notifications">
      <Card title="Notification preferences" footer={<Button variant="primary" loading={busy} onClick={save} disabled={!muted}>Save preferences</Button>}>
        {loading || !data || !muted ? <Loading /> : (
          <>
            <p className="small muted">Choose which in-app notifications you receive. Important system notifications cannot be turned off.</p>
            {data.types.map((t) => (
              <label key={t.key} className="check" style={{ display: "flex", marginBottom: 8 }}>
                <input type="checkbox" disabled={!t.mutable} checked={!muted.includes(t.key)} onChange={(e) => setMuted(e.target.checked ? muted.filter((x) => x !== t.key) : [...muted, t.key])} />
                <span className="small">{t.label}</span>
              </label>
            ))}
            <Callout icon="info">Email notifications are not yet available; everything is delivered in the notification centre.</Callout>
          </>
        )}
      </Card>
    </div>
  );
}
