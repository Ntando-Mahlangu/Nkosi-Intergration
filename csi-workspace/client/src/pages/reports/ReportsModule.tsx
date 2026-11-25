import { Route, Routes } from "react-router-dom";
import { PageHeader, EmptyState } from "../../components/ui";
import ReportDetail from "./ReportDetail";

// TODO(module): implemented by the Reports & Fakawe module owner. Keep the ":id" route → ReportDetail.
function ReportsHome() {
  return (
    <>
      <PageHeader title="Reports & Fakawe" />
      <EmptyState title="Coming soon" />
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
