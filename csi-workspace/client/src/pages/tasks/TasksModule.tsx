import { useEffect, useMemo, useState } from "react";
import { Route, Routes, useSearchParams } from "react-router-dom";
import { useApi, useDebounced, localToday } from "../../lib/hooks";
import { downloadUrl } from "../../lib/api";
import { useLookups } from "../../lib/app-state";
import { Button, Card, ErrorState, Loading, PageHeader, Segmented, Tabs } from "../../components/ui";
import { Icon } from "../../components/Icon";
import { TaskList, type TaskRow } from "./TaskList";
import { TaskFormModal } from "./TaskFormModal";
import TaskDetailPage from "./TaskDetailPage";
import "./tasks.css";

const VIEWS: { key: string; label: string; empty: string }[] = [
  { key: "all", label: "All my tasks", empty: "You have no outstanding tasks." },
  { key: "today", label: "Today", empty: "Nothing due today." },
  { key: "week", label: "This week", empty: "Nothing due in the next 7 days." },
  { key: "overdue", label: "Overdue", empty: "Nothing overdue — nice work." },
  { key: "upcoming", label: "Upcoming", empty: "No upcoming dated tasks." },
  { key: "awaiting_review", label: "Awaiting review", empty: "None of your work is waiting for review." },
  { key: "suggested", label: "To confirm", empty: "No suggested responsibilities waiting for you." },
  { key: "completed", label: "Completed", empty: "No completed tasks yet." },
  { key: "meeting", label: "Meeting actions", empty: "No outstanding actions from meetings." },
  { key: "project", label: "Project actions", empty: "No outstanding project tasks." },
  { key: "personal", label: "Personal", empty: "No personal tasks." },
];

type Tab = "mine" | "to_review" | "team";

function TasksListPage() {
  const [params, setParams] = useSearchParams();
  const { lookups } = useLookups();
  const tab = (params.get("tab") as Tab) || (params.get("view") === "to_review" ? "to_review" : "mine");
  const view = params.get("view") && params.get("view") !== "to_review" ? params.get("view")! : "all";
  const [q, setQ] = useState(params.get("q") ?? "");
  const [sort, setSort] = useState(params.get("sort") ?? "due");
  const [projectId, setProjectId] = useState(params.get("project_id") ?? "");
  const [creating, setCreating] = useState(params.get("new") === "1");
  const dq = useDebounced(q, 300);

  useEffect(() => {
    if (params.get("new") === "1") setCreating(true);
  }, [params]);

  const setParam = (k: string, v: string | null) => {
    const n = new URLSearchParams(params);
    if (v) n.set(k, v);
    else n.delete(k);
    n.delete("new");
    setParams(n, { replace: true });
  };

  const query = useMemo(() => {
    const base: Record<string, string> = { today: localToday(), sort, q: dq, project_id: projectId };
    if (tab === "to_review") return { ...base, view: "to_review", scope: "visible" };
    if (tab === "team") return { ...base, view, scope: "visible" };
    return { ...base, view, scope: "mine" };
  }, [tab, view, sort, dq, projectId]);

  const { data, error, loading, reload } = useApi<{ items: TaskRow[]; total: number }>("/tasks", query);
  const counts = useApi<{ items: TaskRow[]; total: number }>("/tasks", { view: "to_review", scope: "visible", limit: 1 });
  const viewMeta = VIEWS.find((v) => v.key === view) ?? VIEWS[0];

  const closeCreate = () => {
    setCreating(false);
    if (params.get("new")) setParam("new", null);
  };

  return (
    <>
      <PageHeader
        title="My Tasks"
        subtitle="Everything you are responsible for, in one place."
        actions={
          <>
            <a className="btn" href={downloadUrl("/tasks/export.csv", { ...query, limit: undefined })} download>
              <Icon name="download" size={16} /> Export CSV
            </a>
            <Button variant="primary" icon="plus" onClick={() => setCreating(true)}>
              Add task
            </Button>
          </>
        }
      />
      <Tabs<Tab>
        value={tab}
        onChange={(k) => {
          const n = new URLSearchParams(params);
          n.set("tab", k);
          n.delete("view");
          setParams(n, { replace: true });
        }}
        tabs={[
          { key: "mine", label: "Assigned to me" },
          { key: "to_review", label: "To review", count: counts.data?.total },
          { key: "team", label: "My projects' tasks" },
        ]}
      />
      {tab !== "to_review" && (
        <div className="tsk-views">
          <Segmented label="Task view" value={view} onChange={(k) => setParam("view", k === "all" ? null : k)} options={VIEWS.filter((v) => tab === "mine" || !["suggested", "personal"].includes(v.key)).map((v) => ({ key: v.key, label: v.label }))} />
        </div>
      )}
      <div className="tsk-toolbar">
        <input className="input tsk-search" type="search" placeholder="Search tasks or T-number…" aria-label="Search tasks" value={q} onChange={(e) => setQ(e.target.value)} />
        <select className="select" aria-label="Filter by project" value={projectId} onChange={(e) => setProjectId(e.target.value)}>
          <option value="">All projects</option>
          {(lookups?.projects ?? []).map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
        <select className="select" aria-label="Sort tasks" value={sort} onChange={(e) => setSort(e.target.value)}>
          <option value="due">Sort: due date</option>
          <option value="priority">Sort: priority</option>
          <option value="updated">Sort: recently updated</option>
          <option value="created">Sort: newest</option>
        </select>
        {data && <span className="muted small">{data.total} task{data.total === 1 ? "" : "s"}</span>}
      </div>
      <Card pad={false}>
        {loading && !data ? (
          <Loading />
        ) : error ? (
          <ErrorState error={error} onRetry={reload} />
        ) : (
          <TaskList
            tasks={data?.items ?? []}
            onChanged={() => {
              reload();
              counts.reload();
            }}
            showAssignee={tab !== "mine"}
            emptyTitle={tab === "to_review" ? "Nothing waiting for your review" : dq || projectId ? "No tasks match your filters" : viewMeta.empty}
            emptyText={tab === "mine" && !dq ? "Use “Add task” to capture something new." : undefined}
          />
        )}
      </Card>
      <TaskFormModal open={creating} onClose={closeCreate} onSaved={() => reload()} defaults={projectId ? { project_id: projectId } : undefined} />
    </>
  );
}

export default function TasksModule() {
  return (
    <Routes>
      <Route index element={<TasksListPage />} />
      <Route path=":id" element={<TaskDetailPage />} />
    </Routes>
  );
}
