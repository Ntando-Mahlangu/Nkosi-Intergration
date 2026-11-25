import { Navigate, Route, Routes, useLocation } from "react-router-dom";
import { useAuth } from "./lib/app-state";
import { Layout } from "./components/Layout";
import { Loading, PageHeader, EmptyState, LinkButton } from "./components/ui";
import Login from "./pages/Login";
import ForcedPasswordChange from "./pages/ChangePassword";
import WorkspacePage from "./pages/workspace/WorkspacePage";
import TasksModule from "./pages/tasks/TasksModule";
import MeetingsModule from "./pages/meetings/MeetingsModule";
import ReportsModule from "./pages/reports/ReportsModule";
import ProjectsModule from "./pages/projects/ProjectsModule";
import KnowledgeModule from "./pages/knowledge/KnowledgeModule";
import SearchPage from "./pages/knowledge/SearchPage";
import ManagementModule from "./pages/management/ManagementModule";
import OpportunitiesModule from "./pages/opportunities/OpportunitiesModule";
import LearningModule from "./pages/learning/LearningModule";
import AdminModule from "./pages/admin/AdminModule";
import NotificationsPage from "./pages/admin/NotificationsPage";
import ProfilePage from "./pages/admin/ProfilePage";

function NotFound() {
  return (
    <>
      <PageHeader title="Page not found" />
      <EmptyState icon="search" title="We couldn't find that page" action={<LinkButton to="/" variant="primary">Go to My Workspace</LinkButton>}>
        The link may be out of date, or the record may have been removed or restricted.
      </EmptyState>
    </>
  );
}

export default function App() {
  const { me, loading } = useAuth();
  const loc = useLocation();
  if (loading) return <Loading label="Loading CSI Workspace…" />;
  if (!me) {
    if (loc.pathname === "/login") return <Login />;
    return <Navigate to="/login" replace />;
  }
  if (me.user.must_change_password) return <ForcedPasswordChange />;
  return (
    <Layout>
      <Routes>
        <Route path="/" element={<WorkspacePage />} />
        <Route path="/login" element={<Navigate to="/" replace />} />
        <Route path="/tasks/*" element={<TasksModule />} />
        <Route path="/meetings/*" element={<MeetingsModule />} />
        <Route path="/reports/*" element={<ReportsModule />} />
        <Route path="/projects/*" element={<ProjectsModule />} />
        <Route path="/knowledge/*" element={<KnowledgeModule />} />
        <Route path="/search" element={<SearchPage />} />
        <Route path="/management/*" element={<ManagementModule />} />
        <Route path="/opportunities/*" element={<OpportunitiesModule />} />
        <Route path="/learning/*" element={<LearningModule />} />
        <Route path="/admin/*" element={<AdminModule />} />
        <Route path="/notifications" element={<NotificationsPage />} />
        <Route path="/profile" element={<ProfilePage />} />
        <Route path="*" element={<NotFound />} />
      </Routes>
    </Layout>
  );
}
