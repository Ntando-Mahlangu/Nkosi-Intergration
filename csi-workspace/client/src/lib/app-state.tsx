/**
 * App-wide state: signed-in user (permissions), lookups (users/projects/taxonomies), toasts.
 */
import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { api, setUnauthorizedHandler, authPost } from "./api";
import { Icon } from "../components/Icon";

// ------------------------------------------------------------------ auth
export interface Me {
  user: {
    id: string;
    name: string;
    email: string;
    role_key: string;
    role_name: string;
    team_id: string | null;
    job_title: string;
    preferences: Record<string, unknown>;
    must_change_password: boolean;
    is_demo: boolean;
    has_password: boolean;
  };
  permissions: string[];
  org: { name: string; timezone: string };
  ai: { engine: string; aiAvailable: boolean; configured: boolean; enabledSetting: boolean; note: string };
  demoMode: boolean;
  unreadNotifications: number;
}

interface AuthCtx {
  me: Me | null;
  loading: boolean;
  can: (perm: string) => boolean;
  refresh: () => Promise<void>;
  logout: () => Promise<void>;
  setUnread: (n: number) => void;
}
const AuthContext = createContext<AuthCtx>(null as unknown as AuthCtx);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [me, setMe] = useState<Me | null>(null);
  const [loading, setLoading] = useState(true);
  const refresh = useCallback(async () => {
    try {
      setMe(await api.get<Me>("/me"));
    } catch {
      setMe(null);
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    setUnauthorizedHandler(() => setMe(null));
    refresh();
  }, [refresh]);
  const value = useMemo<AuthCtx>(
    () => ({
      me,
      loading,
      can: (p) => !!me?.permissions.includes(p),
      refresh,
      logout: async () => {
        await authPost("/logout", {}).catch(() => undefined);
        setMe(null);
      },
      setUnread: (n) => setMe((m) => (m ? { ...m, unreadNotifications: n } : m)),
    }),
    [me, loading, refresh],
  );
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}
export const useAuth = () => useContext(AuthContext);

// ------------------------------------------------------------------ lookups
export interface LookupUser { id: string; name: string; email: string; job_title: string; team_id: string | null; role_key: string }
export interface LookupProject { id: string; name: string; code: string | null; status: string; programme_id: string | null; owner_id: string | null; my_role: string | null }
export interface Lookups {
  users: LookupUser[];
  teams: { id: string; name: string }[];
  programmes: { id: string; name: string; status: string }[];
  projects: LookupProject[];
  taxonomies: Record<string, string[]>;
  permissionsCatalogue: Record<string, string>;
}
interface LookupsCtx {
  lookups: Lookups | null;
  reload: () => Promise<void>;
  userName: (id?: string | null) => string;
  projectName: (id?: string | null) => string;
}
const LookupsContext = createContext<LookupsCtx>(null as unknown as LookupsCtx);

export function LookupsProvider({ children }: { children: React.ReactNode }) {
  const [lookups, setLookups] = useState<Lookups | null>(null);
  const reload = useCallback(async () => {
    try {
      setLookups(await api.get<Lookups>("/lookups"));
    } catch {
      /* shown elsewhere */
    }
  }, []);
  useEffect(() => {
    reload();
  }, [reload]);
  const value = useMemo<LookupsCtx>(() => {
    const users = new Map((lookups?.users ?? []).map((u) => [u.id, u.name]));
    const projects = new Map((lookups?.projects ?? []).map((p) => [p.id, p.name]));
    return {
      lookups,
      reload,
      userName: (id) => (id ? (users.get(id) ?? "Former user") : ""),
      projectName: (id) => (id ? (projects.get(id) ?? "Restricted project") : ""),
    };
  }, [lookups, reload]);
  return <LookupsContext.Provider value={value}>{children}</LookupsContext.Provider>;
}
export const useLookups = () => useContext(LookupsContext);

// ------------------------------------------------------------------ toasts
interface Toast { id: number; kind: "success" | "error" | "info"; text: string }
interface ToastCtx { success: (t: string) => void; error: (t: string) => void; info: (t: string) => void }
const ToastContext = createContext<ToastCtx>(null as unknown as ToastCtx);

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const push = useCallback((kind: Toast["kind"], text: string) => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t.slice(-3), { id, kind, text }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), kind === "error" ? 7000 : 4000);
  }, []);
  const value = useMemo(() => ({ success: (t: string) => push("success", t), error: (t: string) => push("error", t), info: (t: string) => push("info", t) }), [push]);
  return (
    <ToastContext.Provider value={value}>
      {children}
      <div className="toasts" aria-live="polite" aria-atomic="false">
        {toasts.map((t) => (
          <div key={t.id} className={`toast ${t.kind === "error" ? "error" : ""}`} role={t.kind === "error" ? "alert" : "status"}>
            <Icon name={t.kind === "error" ? "alertCircle" : t.kind === "success" ? "checkCircle" : "info"} size={18} />
            <span>{t.text}</span>
            <button aria-label="Dismiss" onClick={() => setToasts((x) => x.filter((y) => y.id !== t.id))}>
              ×
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}
export const useToast = () => useContext(ToastContext);
