import { useEffect, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { authGet, authPost } from "../lib/api";
import { useAuth } from "../lib/app-state";
import { Button, FormError, TextInput, Callout } from "../components/ui";
import { Icon } from "../components/Icon";

interface AuthConfig { orgName: string; googleSignIn: boolean; demoMode: boolean; demoAccounts: { email: string; name: string; role: string }[]; demoPassword: string | null }

const GOOGLE_ERRORS: Record<string, string> = {
  state: "Sign-in expired. Please try again.",
  denied: "Google sign-in was cancelled.",
  google: "Google sign-in failed. Please try again or use your password.",
  domain: "That Google account is not from CSI's Workspace domain.",
  not_provisioned: "Your account has not been set up in CSI Workspace yet. Please ask an administrator.",
};

export default function Login() {
  const { me, refresh } = useAuth();
  const nav = useNavigate();
  const [params] = useSearchParams();
  const [cfg, setCfg] = useState<AuthConfig | null>(null);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState(GOOGLE_ERRORS[params.get("error") ?? ""] ?? "");
  const [fields, setFields] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    authGet<AuthConfig>("/config").then(setCfg).catch(() => undefined);
  }, []);
  useEffect(() => {
    if (me) nav("/", { replace: true });
  }, [me, nav]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    const f: Record<string, string> = {};
    if (!/^\S+@\S+\.\S+$/.test(email)) f.email = "Enter a valid email.";
    if (!password) f.password = "Enter your password.";
    setFields(f);
    if (Object.keys(f).length) return;
    setBusy(true);
    try {
      await authPost("/login", { email, password });
      await refresh();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="auth-page">
      <aside className="auth-aside">
        <div className="row">
          <span className="brand-mark">CSI</span>
          <strong style={{ color: "#fff" }}>CSI Workspace</strong>
        </div>
        <div>
          <h1>One connected workspace for knowledge, people, projects and execution.</h1>
          <p className="mt-2">Connect what CSI knows, what CSI plans, what CSI does, and what CSI learns.</p>
        </div>
        <p className="tiny">{cfg?.orgName ?? "Change Science Institute"}</p>
      </aside>
      <main className="auth-main">
        <div className="auth-card">
          <h1 className="mb-1">Sign in</h1>
          <p className="muted mb-3">Use your CSI account to continue.</p>
          <FormError message={error} />
          {cfg?.googleSignIn && (
            <>
              <a className="btn" style={{ width: "100%" }} href="/auth/google">
                <Icon name="user" size={16} /> Continue with Google Workspace
              </a>
              <div className="row muted small" style={{ margin: "16px 0" }}>
                <span style={{ flex: 1, height: 1, background: "var(--border)" }} /> or <span style={{ flex: 1, height: 1, background: "var(--border)" }} />
              </div>
            </>
          )}
          <form onSubmit={submit} noValidate>
            <TextInput label="Email" type="email" autoComplete="username" value={email} onChange={setEmail} error={fields.email} required />
            <TextInput label="Password" type="password" autoComplete="current-password" value={password} onChange={setPassword} error={fields.password} required />
            <Button type="submit" variant="primary" loading={busy} className="mt-1" style={{ width: "100%" }}>
              Sign in
            </Button>
          </form>
          {cfg && cfg.demoAccounts.length > 0 && (
            <div className="mt-3">
              <Callout tone="warn" icon="info">
                <strong>Demo environment.</strong> Choose a fictional account to explore different roles.{" "}
                {cfg.demoPassword ? (
                  <>Password for every demo account: <code>{cfg.demoPassword}</code></>
                ) : (
                  "The demo password was printed in the server log when the data was seeded."
                )}
                <div className="stack-sm mt-1">
                  {cfg.demoAccounts.map((a) => (
                    <button key={a.email} type="button" className="btn btn-sm btn-ghost" style={{ justifyContent: "flex-start" }} onClick={() => { setEmail(a.email); if (cfg.demoPassword) setPassword(cfg.demoPassword); }}>
                      {a.name} — {a.role}
                    </button>
                  ))}
                </div>
              </Callout>
            </div>
          )}
        </div>
      </main>
    </div>
  );
}
