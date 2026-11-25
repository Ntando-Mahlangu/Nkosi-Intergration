import { NavLink, Navigate, Route, Routes } from "react-router-dom";
import { useAuth } from "../../lib/app-state";
import { PageHeader, EmptyState } from "../../components/ui";
import { Icon } from "../../components/Icon";
import UsersTab from "./UsersTab";
import TeamsTab from "./TeamsTab";
import RolesTab from "./RolesTab";
import SettingsTab from "./SettingsTab";
import TaxonomiesTab from "./TaxonomiesTab";
import TemplatesTab from "./TemplatesTab";
import IntegrationsTab from "./IntegrationsTab";
import AutomationsTab from "./AutomationsTab";
import AuditTab from "./AuditTab";
import DataTab from "./DataTab";
import "./admin.css";

const TABS = [
  { path: "users", label: "Users", icon: "users", perm: "admin.users", el: <UsersTab /> },
  { path: "teams", label: "Teams", icon: "briefcase", perm: "admin.users", el: <TeamsTab /> },
  { path: "roles", label: "Roles & permissions", icon: "shield", perm: "admin.roles", el: <RolesTab /> },
  { path: "settings", label: "Settings", icon: "settings", perm: "admin.settings", el: <SettingsTab /> },
  { path: "taxonomies", label: "Taxonomies", icon: "layers", perm: "admin.settings", el: <TaxonomiesTab /> },
  { path: "templates", label: "Report templates", icon: "report", perm: "admin.settings", el: <TemplatesTab /> },
  { path: "integrations", label: "Integrations", icon: "link", perm: "admin.settings", el: <IntegrationsTab /> },
  { path: "automations", label: "Automations", icon: "zap", perm: "admin.settings", el: <AutomationsTab /> },
  { path: "audit", label: "Audit log", icon: "eye", perm: "admin.audit", el: <AuditTab /> },
  { path: "data", label: "Data & retention", icon: "archive", perm: "admin.data", el: <DataTab /> },
];

export default function AdminModule() {
  const { can } = useAuth();
  const tabs = TABS.filter((t) => can(t.perm));
  if (!tabs.length)
    return (
      <>
        <PageHeader title="Administration" />
        <EmptyState icon="lock" title="Access restricted">You do not have any administration permissions.</EmptyState>
      </>
    );
  return (
    <>
      <PageHeader title="Administration" subtitle="Users, access, configuration and data governance. Every change here is recorded in the audit log." />
      <div className="adm-layout">
        <nav className="adm-nav" aria-label="Administration sections">
          {tabs.map((t) => (
            <NavLink key={t.path} to={`/admin/${t.path}`} className={({ isActive }) => (isActive ? "active" : "")}>
              <Icon name={t.icon} size={16} /> {t.label}
            </NavLink>
          ))}
        </nav>
        <div style={{ minWidth: 0 }}>
          <Routes>
            <Route index element={<Navigate to={tabs[0].path} replace />} />
            {tabs.map((t) => (
              <Route key={t.path} path={t.path} element={t.el} />
            ))}
            <Route path="*" element={<EmptyState icon="lock" title="Section unavailable">This section does not exist or requires a permission you do not have.</EmptyState>} />
          </Routes>
        </div>
      </div>
    </>
  );
}
