import { useState } from "react";
import { Route, Routes, useSearchParams } from "react-router-dom";
import { useAuth } from "../../lib/app-state";
import { PageHeader, Tabs, Button } from "../../components/ui";
import ReportDetail from "./ReportDetail";
import FakaweTab from "./fakawe/FakaweTab";
import PeriodsTab from "./fakawe/PeriodsTab";
import ReportListTab from "./fakawe/ReportListTab";
import "./fakawe/fakawe.css";

type TabKey = "fakawe" | "periods" | "call" | "project" | "archive";

function ReportsHome() {
  const { can } = useAuth();
  const canSee = can("fakawe.manage") || can("fakawe.approve") || can("management.view");
  const canManage = can("fakawe.manage");
  const [params, setParams] = useSearchParams();
  const [createOpen, setCreateOpen] = useState(false);
  const tabs: { key: TabKey; label: string }[] = [
    ...(canSee ? [{ key: "fakawe" as const, label: "Fakawe" }, { key: "periods" as const, label: "Reporting periods" }] : []),
    { key: "call", label: "Call reports" },
    { key: "project", label: "Project reports" },
    { key: "archive", label: "Archive" },
  ];
  const requested = params.get("tab") as TabKey | null;
  const tab: TabKey = requested && tabs.some((t) => t.key === requested) ? requested : tabs[0].key;
  const setTab = (k: TabKey) => setParams({ tab: k }, { replace: true });
  return (
    <>
      <PageHeader
        title="Reports & Fakawe"
        subtitle="Capture information once, reuse it for call reports, project reports and the Fakawe digest."
        actions={
          canManage ? (
            <Button icon="plus" onClick={() => { setTab("periods"); setCreateOpen(true); }}>
              New reporting period
            </Button>
          ) : undefined
        }
      />
      <Tabs tabs={tabs} value={tab} onChange={setTab} />
      {tab === "fakawe" && <FakaweTab onCreatePeriod={() => { setTab("periods"); setCreateOpen(true); }} />}
      {tab === "periods" && <PeriodsTab canManage={canManage} createOpen={createOpen} setCreateOpen={setCreateOpen} />}
      {tab === "call" && <ReportListTab type="call_report" emptyText="Call reports are generated from approved meeting records (open a meeting and choose Generate call report)." />}
      {tab === "project" && <ReportListTab type="project_report" emptyText="Project status reports are generated from a project's page." />}
      {tab === "archive" && <ReportListTab archive emptyText="Approved, final and published reports you can access will appear here." />}
    </>
  );
}

export default function ReportsModule() {
  return (
    <Routes>
      <Route index element={<ReportsHome />} />
      <Route path=":id" element={<ReportDetail />} />
    </Routes>
  );
}
