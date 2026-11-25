import { NavLink, Route, Routes } from "react-router-dom";
import { useAuth } from "../../lib/app-state";
import { EmptyState, LinkButton, PageHeader } from "../../components/ui";
import { Icon } from "../../components/Icon";
import Overview from "./Overview";
import Attention from "./Attention";
import Portfolio from "./Portfolio";
import Decisions from "./Decisions";
import Trends from "./Trends";
import "./management.css";

const LINKS = [
  { to: "/management", label: "Overview", icon: "chart", end: true },
  { to: "/management/attention", label: "Attention required", icon: "alert" },
  { to: "/management/portfolio", label: "Portfolio", icon: "folder" },
  { to: "/management/decisions", label: "Decisions", icon: "flag" },
  { to: "/management/trends", label: "Trends", icon: "trending" },
];

export default function ManagementModule() {
  const { can } = useAuth();
  if (!can("management.view"))
    return (
      <>
        <PageHeader title="Management Intelligence" />
        <EmptyState icon="lock" title="Access restricted" action={<LinkButton to="/" variant="primary">Back to My Workspace</LinkButton>}>
          Management dashboards are available to users with the management role.
        </EmptyState>
      </>
    );
  return (
    <>
      <PageHeader title="Management Intelligence" subtitle="What CSI is working on, what is progressing, and what needs attention." />
      <nav className="mgt-nav" aria-label="Management sections">
        {LINKS.map((l) => (
          <NavLink key={l.to} to={l.to} end={l.end} className={({ isActive }) => (isActive ? "active" : "")}>
            <Icon name={l.icon} size={15} /> {l.label}
          </NavLink>
        ))}
      </nav>
      <Routes>
        <Route index element={<Overview />} />
        <Route path="attention" element={<Attention />} />
        <Route path="portfolio" element={<Portfolio />} />
        <Route path="decisions" element={<Decisions />} />
        <Route path="trends" element={<Trends />} />
        <Route path="*" element={<EmptyState icon="search" title="Section not found" />} />
      </Routes>
    </>
  );
}
