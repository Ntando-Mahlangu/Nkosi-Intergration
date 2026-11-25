import React, { useEffect, useRef, useState } from "react";
import { NavLink, useLocation, useNavigate } from "react-router-dom";
import { useAuth } from "../lib/app-state";
import { Icon } from "./Icon";
import { Avatar } from "./ui";

interface NavItem { to: string; label: string; icon: string; perm?: string; anyPerm?: string[]; end?: boolean }

const NAV: { label?: string; items: NavItem[] }[] = [
  {
    items: [
      { to: "/", label: "My Workspace", icon: "home", end: true },
      { to: "/tasks", label: "My Tasks", icon: "tasks" },
      { to: "/meetings", label: "Meetings", icon: "meeting" },
      { to: "/projects", label: "Projects & Programmes", icon: "folder" },
    ],
  },
  {
    label: "Knowledge & reporting",
    items: [
      { to: "/knowledge", label: "Knowledge Hub", icon: "book" },
      { to: "/reports", label: "Reports & Fakawe", icon: "report" },
      { to: "/opportunities", label: "Opportunities", icon: "target" },
      { to: "/learning", label: "Learning & Improvement", icon: "lightbulb" },
    ],
  },
  {
    label: "Oversight",
    items: [
      { to: "/management", label: "Management Intelligence", icon: "chart", perm: "management.view" },
      { to: "/admin", label: "Administration", icon: "settings", anyPerm: ["admin.users", "admin.roles", "admin.settings", "admin.audit", "admin.data"] },
    ],
  },
];

const QUICK_CREATE = [
  { label: "Add task", icon: "tasks", to: "/tasks?new=1" },
  { label: "Submit meeting notes", icon: "meeting", to: "/meetings/new" },
  { label: "Update a project", icon: "folder", to: "/projects?update=1" },
  { label: "Add knowledge item", icon: "book", to: "/knowledge/new" },
  { label: "Create opportunity", icon: "target", to: "/opportunities?new=1" },
  { label: "Share a learning", icon: "lightbulb", to: "/learning?new=1" },
];

function useClickOutside(ref: React.RefObject<HTMLElement>, onOut: () => void) {
  useEffect(() => {
    const h = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onOut();
    };
    document.addEventListener("mousedown", h);
    return () => document.removeEventListener("mousedown", h);
  }, [ref, onOut]);
}

export function Layout({ children }: { children: React.ReactNode }) {
  const { me, can, logout } = useAuth();
  const [navOpen, setNavOpen] = useState(false);
  const [userMenu, setUserMenu] = useState(false);
  const [quickMenu, setQuickMenu] = useState(false);
  const [q, setQ] = useState("");
  const nav = useNavigate();
  const loc = useLocation();
  const userRef = useRef<HTMLDivElement>(null);
  const quickRef = useRef<HTMLDivElement>(null);
  useClickOutside(userRef, () => setUserMenu(false));
  useClickOutside(quickRef, () => setQuickMenu(false));
  useEffect(() => {
    setNavOpen(false);
    setUserMenu(false);
    setQuickMenu(false);
  }, [loc.pathname, loc.search]);

  // "/" focuses search (when not typing in a field)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (e.key === "/" && !["INPUT", "TEXTAREA", "SELECT"].includes(t.tagName) && !t.isContentEditable) {
        e.preventDefault();
        document.getElementById("global-search")?.focus();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  if (!me) return null;
  const visible = (i: NavItem) => (!i.perm || can(i.perm)) && (!i.anyPerm || i.anyPerm.some(can));

  return (
    <div className="shell">
      <a className="skip-link" href="#main">
        Skip to content
      </a>
      {navOpen && <div className="sidebar-scrim mobile-only" onClick={() => setNavOpen(false)} />}
      <aside className={`sidebar ${navOpen ? "open" : ""}`} aria-label="Main navigation">
        <div className="sidebar-brand">
          <span className="brand-mark">CSI</span>
          <span className="brand-text">
            <strong>CSI Workspace</strong>
            <span>{me.org.name}</span>
          </span>
        </div>
        <nav>
          {NAV.map((sec, i) => {
            const items = sec.items.filter(visible);
            if (!items.length) return null;
            return (
              <div className="nav-section" key={i}>
                {sec.label && <div className="nav-label">{sec.label}</div>}
                {items.map((it) => (
                  <NavLink key={it.to} to={it.to} end={it.end} className={({ isActive }) => `nav-link ${isActive ? "active" : ""}`}>
                    <Icon name={it.icon} />
                    <span>{it.label}</span>
                  </NavLink>
                ))}
              </div>
            );
          })}
        </nav>
        <div className="sidebar-foot">
          Connect what CSI knows, plans, does and learns.
          <div className="mt-1">{me.ai.aiAvailable ? "AI assistance: on" : "AI assistance: not configured"}</div>
        </div>
      </aside>

      <div className="main">
        {me.demoMode && (
          <div className="demo-banner" role="note">
            <strong>Demonstration data.</strong> People, organisations and outcomes shown are fictional and illustrative only.
          </div>
        )}
        <header className="topbar">
          <button className="icon-btn mobile-only" aria-label="Open navigation" onClick={() => setNavOpen(true)}>
            <Icon name="menu" />
          </button>
          <form
            className="topbar-search"
            role="search"
            onSubmit={(e) => {
              e.preventDefault();
              if (q.trim()) nav(`/search?q=${encodeURIComponent(q.trim())}`);
            }}
          >
            <Icon name="search" />
            <label htmlFor="global-search" className="sr-only">
              Search CSI Workspace
            </label>
            <input id="global-search" type="search" placeholder="Search projects, tasks, meetings, knowledge…  ( / )" value={q} onChange={(e) => setQ(e.target.value)} autoComplete="off" />
          </form>
          <div className="topbar-actions">
            <div style={{ position: "relative" }} ref={quickRef}>
              <button className="btn btn-primary desktop-only" aria-haspopup="menu" aria-expanded={quickMenu} onClick={() => setQuickMenu((v) => !v)}>
                <Icon name="plus" size={16} /> New
              </button>
              <button className="icon-btn mobile-only" aria-label="Create new" aria-haspopup="menu" aria-expanded={quickMenu} onClick={() => setQuickMenu((v) => !v)}>
                <Icon name="plus" />
              </button>
              {quickMenu && (
                <div className="menu" role="menu">
                  {QUICK_CREATE.map((it) => (
                    <button key={it.to} role="menuitem" className="menu-item" onClick={() => nav(it.to)}>
                      <Icon name={it.icon} size={16} /> {it.label}
                    </button>
                  ))}
                </div>
              )}
            </div>
            <button className="icon-btn" aria-label={`Notifications${me.unreadNotifications ? `, ${me.unreadNotifications} unread` : ""}`} onClick={() => nav("/notifications")}>
              <Icon name="bell" />
              {me.unreadNotifications > 0 && <span className="dot">{me.unreadNotifications > 99 ? "99+" : me.unreadNotifications}</span>}
            </button>
            <div style={{ position: "relative" }} ref={userRef}>
              <button className="menu-trigger" aria-haspopup="menu" aria-expanded={userMenu} onClick={() => setUserMenu((v) => !v)}>
                <Avatar name={me.user.name} />
                <span className="desktop-only small">{me.user.name.split(" ")[0]}</span>
                <Icon name="chevronDown" size={14} className="desktop-only" />
              </button>
              {userMenu && (
                <div className="menu" role="menu">
                  <div className="menu-head">
                    <div className="strong" style={{ color: "var(--text)" }}>{me.user.name}</div>
                    <div>{me.user.role_name}</div>
                  </div>
                  <div className="menu-sep" />
                  <button role="menuitem" className="menu-item" onClick={() => nav("/profile")}>
                    <Icon name="user" size={16} /> Profile & preferences
                  </button>
                  <button role="menuitem" className="menu-item" onClick={() => nav("/notifications")}>
                    <Icon name="bell" size={16} /> Notifications
                  </button>
                  <div className="menu-sep" />
                  <button role="menuitem" className="menu-item" onClick={() => logout().then(() => nav("/login"))}>
                    <Icon name="logout" size={16} /> Sign out
                  </button>
                </div>
              )}
            </div>
          </div>
        </header>
        <main id="main" className="content" tabIndex={-1}>
          {children}
        </main>
        <nav className="bottom-nav" aria-label="Quick navigation">
          <NavLink to="/" end className={({ isActive }) => (isActive ? "active" : "")}>
            <Icon name="home" /> Home
          </NavLink>
          <NavLink to="/tasks" className={({ isActive }) => (isActive ? "active" : "")}>
            <Icon name="tasks" /> Tasks
          </NavLink>
          <NavLink to="/meetings" className={({ isActive }) => (isActive ? "active" : "")}>
            <Icon name="meeting" /> Meetings
          </NavLink>
          <NavLink to="/projects" className={({ isActive }) => (isActive ? "active" : "")}>
            <Icon name="folder" /> Projects
          </NavLink>
          <NavLink to="/notifications" className={({ isActive }) => (isActive ? "active" : "")}>
            <Icon name="bell" /> Alerts
          </NavLink>
        </nav>
      </div>
    </div>
  );
}
