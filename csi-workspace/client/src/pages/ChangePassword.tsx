import { useState } from "react";
import { authPost } from "../lib/api";
import { useAuth, useToast } from "../lib/app-state";
import { Button, Card, FormError, TextInput } from "../components/ui";

/** Shown instead of the app when an administrator has required a password change. Also used from Profile. */
export function ChangePasswordForm({ requireCurrent = true, onDone }: { requireCurrent?: boolean; onDone?: () => void }) {
  const toast = useToast();
  const [cur, setCur] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [err, setErr] = useState("");
  const [fields, setFields] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErr("");
    if (next !== confirm) return setFields({ confirm: "Passwords do not match." });
    setBusy(true);
    try {
      await authPost("/change-password", { currentPassword: cur, newPassword: next });
      toast.success("Password updated");
      setCur(""); setNext(""); setConfirm(""); setFields({});
      onDone?.();
    } catch (e2) {
      const x = e2 as { message: string; fields?: Record<string, string> };
      setErr(x.message);
      setFields(x.fields ?? {});
    } finally {
      setBusy(false);
    }
  };
  return (
    <form onSubmit={submit} noValidate>
      <FormError message={err} />
      {requireCurrent && <TextInput label="Current password" type="password" autoComplete="current-password" value={cur} onChange={setCur} error={fields.currentPassword} required />}
      <TextInput label="New password" type="password" autoComplete="new-password" value={next} onChange={setNext} error={fields.newPassword} hint="At least 10 characters, including letters and numbers." required />
      <TextInput label="Confirm new password" type="password" autoComplete="new-password" value={confirm} onChange={setConfirm} error={fields.confirm} required />
      <Button type="submit" variant="primary" loading={busy}>Update password</Button>
    </form>
  );
}

export default function ForcedPasswordChange() {
  const { refresh, logout } = useAuth();
  return (
    <div className="auth-main" style={{ minHeight: "100vh" }}>
      <div className="auth-card">
        <Card title="Choose a new password">
          <p className="muted small">Your administrator requires you to set a new password before continuing.</p>
          <ChangePasswordForm onDone={refresh} />
          <Button variant="ghost" className="mt-2" onClick={logout}>Sign out</Button>
        </Card>
      </div>
    </div>
  );
}
