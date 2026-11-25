/**
 * My CSI Workspace — the personal landing page (spec §8 / §24).
 * Every number is fetched from the API (derived from real records), every card is clickable.
 */
import { useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useApi, localToday } from "../../lib/hooks";
import { useAuth } from "../../lib/app-state";
import { fmtDate, plural } from "../../lib/format";
import { Icon } from "../../components/Icon";
import { Badge, Button, Card, EmptyState, ErrorState, LinkButton, Loading, ProgressBar, StatCard, StatusBadge } from "../../components/ui";
import { ActivityList, SectionTitle, type ActivityRow } from "../../components/records";
import { TaskList, type TaskRow } from "../tasks/TaskList";
import { TaskFormModal } from "../tasks/TaskFormModal";
import "../tasks/tasks.css";

interface Summary {
  today: string;
  user: { first_name: string; name: string; role_name: string };
  counts: {
    open: number;
    due_today: number;
    overdue: number;
    due_this_week: number;
    completed_this_week: number;
    awaiting_review: { total: number; to_review_by_me: number; my_submissions: number; suggested_for_me: number };
  };
}
interface WsProject {
  id: string;
  name: string;
  status: string;
  health: string;
  owner_name: string | null;
  my_role: string | null;
  progress: { value: number | null; explanation: string };
  next_milestone: { title: string; target_date: string | null } | null;
  next_deadline: { label: string; date: string } | null;
  my_outstanding: number;
  my_overdue: number;
}
interface WsMeeting {
  id: string;
  title: string;
  meeting_date: string;
  start_time: string | null;
  end_time: string | null;
  project_id: string | null;
  project_name: string | null;
  meeting_link: string;
  location: string;
  preparation_required: boolean;
  preparation_notes: string;
  is_today: boolean;
  outstanding_prior_actions: number;
}

const CHIPS: { key: string; label: string }[] = [
  { key: "all", label: "All" },
  { key: "today", label: "Today" },
  { key: "overdue", label: "Overdue" },
  { key: "week", label: "This week" },
  { key: "meeting", label: "From meetings" },
];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function greeting() {
  const h = new Date().getHours();
  return h < 12 ? "Good morning" : h < 17 ? "Good afternoon" : "Good evening";
}

function contextLine(c: Summary["counts"]): string {
  const parts: string[] = [];
  if (c.due_today) parts.push(`${plural(c.due_today, "task")} due today`);
  if (c.overdue) parts.push(`${c.overdue} overdue`);
  if (c.awaiting_review.to_review_by_me) parts.push(`${plural(c.awaiting_review.to_review_by_me, "item")} waiting for your review`);
  if (c.awaiting_review.suggested_for_me) parts.push(`${plural(c.awaiting_review.suggested_for_me, "suggested action")} to confirm`);
  if (!parts.length) return c.open ? `Nothing urgent today. ${plural(c.open, "open task")} on your list.` : "Your list is clear.";
  return parts.join(" · ");
}

export default function WorkspacePage() {
  const nav = useNavigate();
  const { me, can } = useAuth();
  const today = localToday();
  const [chip, setChip] = useState("all");
  const [adding, setAdding] = useState(false);
  const summary = useApi<Summary>("/workspace/summary", { today });
  const tasks = useApi<{ items: TaskRow[]; total: number }>("/tasks", { view: chip, scope: "mine", today, sort: "due", limit: 8 });
  const suggested = useApi<{ items: TaskRow[]; total: number }>("/tasks", { view: "suggested", scope: "mine", limit: 3 });
  const projects = useApi<WsProject[]>("/workspace/projects", { today });
  const meetings = useApi<WsMeeting[]>("/workspace/meetings", { today });
  const activity = useApi<ActivityRow[]>("/workspace/activity");

  const refreshAll = () => {
    summary.reload();
    tasks.reload();
    suggested.reload();
    projects.reload();
  };
  const dateText = useMemo(() => new Date().toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long", year: "numeric" }), []);
  const c = summary.data?.counts;
  const isAdmin = ["admin.users", "admin.settings", "admin.roles", "admin.audit", "admin.data"].some(can);

  return (
    <>
      <div className="ws-header">
        <div>
          <h1>My CSI Workspace</h1>
          <div className="ws-greeting">
            {greeting()}, {me?.user.name.split(" ")[0]} · <span>{dateText}</span>
          </div>
          {c && <div className="ws-context">{contextLine(c)}</div>}
        </div>
        <Button variant="primary" icon="plus" onClick={() => setAdding(true)}>
          Add task
        </Button>
      </div>

      {summary.error ? (
        <ErrorState error={summary.error} onRetry={summary.reload} />
      ) : (
        <div className="grid grid-3 ws-stats">
          <StatCard
            label="Open tasks"
            icon="tasks"
            value={c ? c.open : "–"}
            hint={c ? (c.overdue ? `${c.overdue} overdue · ${c.due_this_week} due this week` : `${c.due_this_week} due this week`) : " "}
            tone={c?.overdue ? "danger" : undefined}
            onClick={() => nav("/tasks")}
            ariaLabel={`Open tasks: ${c?.open ?? "loading"}. View outstanding tasks.`}
          />
          <StatCard
            label="Due today"
            icon="calendar"
            value={c ? c.due_today : "–"}
            hint={c ? (c.due_today ? "Focus for today" : "Nothing due today") : " "}
            tone={c?.due_today ? "warn" : undefined}
            onClick={() => nav("/tasks?view=today")}
            ariaLabel={`Due today: ${c?.due_today ?? "loading"}. View tasks due today.`}
          />
          <StatCard
            label="Awaiting review"
            icon="eye"
            value={c ? c.awaiting_review.total : "–"}
            hint={c ? `${c.awaiting_review.to_review_by_me} to review · ${c.awaiting_review.my_submissions} submitted by you` : " "}
            tone={c?.awaiting_review.to_review_by_me ? "accent" : undefined}
            onClick={() => nav(c && c.awaiting_review.to_review_by_me > 0 ? "/tasks?tab=to_review" : "/tasks?view=awaiting_review")}
            ariaLabel={`Awaiting review: ${c?.awaiting_review.total ?? "loading"}. Open your review queue.`}
          />
        </div>
      )}

      {suggested.data && suggested.data.total > 0 && (
        <div className="tsk-suggest mb-3" role="region" aria-label="Needs your confirmation">
          <Icon name="sparkles" />
          <div style={{ flex: 1, minWidth: 220 }}>
            <strong>Needs your confirmation:</strong> {plural(suggested.data.total, "action")} from meetings {suggested.data.total === 1 ? "was" : "were"} suggested for you. They are not your responsibility until you accept.
            <div className="small mt-1">
              {suggested.data.items.map((t) => (
                <div key={t.id}>
                  <Link to={`/tasks/${t.id}`}>{t.title}</Link>
                  {t.meeting_title && <span className="muted"> — {t.meeting_title}</span>}
                </div>
              ))}
            </div>
          </div>
          <LinkButton to="/tasks?view=suggested" size="sm">
            Review
          </LinkButton>
        </div>
      )}

      <div className="cols-main-side">
        <div className="stack" style={{ gap: 26 }}>
          <section>
            <SectionTitle
              meta={tasks.data ? `${tasks.data.items.length} of ${tasks.data.total}` : undefined}
              action={
                <Link to={chip === "all" ? "/tasks" : `/tasks?view=${chip}`} className="small">
                  View all
                </Link>
              }
            >
              My Outstanding Actions
            </SectionTitle>
            <div className="ws-chips mb-2" role="group" aria-label="Filter outstanding actions">
              {CHIPS.map((ch) => (
                <button key={ch.key} className={`ws-chip ${chip === ch.key ? "active" : ""}`} aria-pressed={chip === ch.key} onClick={() => setChip(ch.key)}>
                  {ch.label}
                </button>
              ))}
            </div>
            <Card pad={false}>
              {tasks.loading && !tasks.data ? (
                <Loading />
              ) : tasks.error ? (
                <ErrorState error={tasks.error} onRetry={tasks.reload} />
              ) : (
                <TaskList
                  tasks={tasks.data?.items ?? []}
                  onChanged={refreshAll}
                  emptyTitle={chip === "all" ? "You're all caught up" : "Nothing in this view"}
                  emptyText={chip === "all" ? "No outstanding actions. Add a task to capture something new." : undefined}
                />
              )}
            </Card>
          </section>

          <section>
            <SectionTitle action={<Link to="/projects" className="small">All projects</Link>}>My Active Projects</SectionTitle>
            {projects.loading && !projects.data ? (
              <Loading />
            ) : projects.error ? (
              <ErrorState error={projects.error} onRetry={projects.reload} />
            ) : projects.data && projects.data.length ? (
              <div className="grid grid-2">
                {projects.data.map((p) => (
                  <div key={p.id} className="card clickable" onClick={() => nav(`/projects/${p.id}`)}>
                    <div className="ws-project">
                      <div className="row-between" style={{ alignItems: "flex-start" }}>
                        <h3>
                          <Link to={`/projects/${p.id}`} onClick={(e) => e.stopPropagation()}>
                            {p.name}
                          </Link>
                        </h3>
                        <StatusBadge kind="health" value={p.health} />
                      </div>
                      <div className="row small muted">
                        <StatusBadge kind="project" value={p.status} />
                        <span>{p.my_role ? `You: ${p.my_role}` : ""}</span>
                        <span>Owner: {p.owner_name ?? "—"}</span>
                      </div>
                      <div title={p.progress.explanation}>
                        <ProgressBar value={p.progress.value} label={p.progress.value === null ? "Progress not yet measurable" : "Progress"} />
                      </div>
                      <div className="meta">
                        {p.next_milestone && (
                          <span>
                            <Icon name="milestone" size={12} /> Next milestone: {p.next_milestone.title}
                            {p.next_milestone.target_date ? ` (${fmtDate(p.next_milestone.target_date)})` : ""}
                          </span>
                        )}
                        {p.next_deadline && (
                          <span>
                            <Icon name="calendar" size={12} /> Upcoming deadline: {p.next_deadline.label} — {fmtDate(p.next_deadline.date)}
                          </span>
                        )}
                      </div>
                      <div className="row small">
                        {p.my_outstanding > 0 ? (
                          <Link to={`/tasks?project_id=${p.id}`} onClick={(e) => e.stopPropagation()}>
                            {plural(p.my_outstanding, "action")} for you
                          </Link>
                        ) : (
                          <span className="muted">No actions for you</span>
                        )}
                        {p.my_overdue > 0 && <Badge tone="danger" icon="alert">{p.my_overdue} overdue</Badge>}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <Card>
                <EmptyState icon="folder" title="No active projects">
                  When you are added to a project it will appear here.
                </EmptyState>
              </Card>
            )}
          </section>
        </div>

        <aside className="stack" style={{ gap: 20 }}>
          <Card title="Quick actions">
            <div className="ws-quick">
              <Button size="sm" icon="tasks" onClick={() => setAdding(true)}>
                Add task
              </Button>
              <LinkButton to="/meetings/new" size="sm" icon="meeting">
                Meeting notes
              </LinkButton>
              <LinkButton to="/projects?update=1" size="sm" icon="folder">
                Update project
              </LinkButton>
              <LinkButton to="/knowledge/new" size="sm" icon="book">
                Add knowledge
              </LinkButton>
              <LinkButton to="/opportunities?new=1" size="sm" icon="target">
                Opportunity
              </LinkButton>
              <LinkButton to="/reports" size="sm" icon="report">
                View reports
              </LinkButton>
            </div>
          </Card>

          <Card title="Upcoming meetings" actions={<Link to="/meetings" className="small">All</Link>} pad={false}>
            {meetings.loading && !meetings.data ? (
              <Loading />
            ) : meetings.data && meetings.data.length ? (
              <div>
                {meetings.data.map((m) => {
                  const [, mo, d] = m.meeting_date.split("-").map(Number);
                  return (
                    <div className="ws-meeting" key={m.id}>
                      <div className={`ws-date ${m.is_today ? "today" : ""}`} aria-hidden>
                        <div className="d">{d}</div>
                        <div className="m">{MONTHS[mo - 1]}</div>
                      </div>
                      <div style={{ minWidth: 0, flex: 1 }}>
                        <Link to={`/meetings/${m.id}`} className="strong" style={{ color: "var(--text)" }}>
                          {m.title}
                        </Link>
                        <div className="tiny muted">
                          {m.is_today ? "Today" : fmtDate(m.meeting_date)}
                          {m.start_time ? ` · ${m.start_time}${m.end_time ? `–${m.end_time}` : ""}` : ""}
                          {m.project_name ? ` · ${m.project_name}` : ""}
                        </div>
                        <div className="row mt-1" style={{ gap: 6 }}>
                          {m.preparation_required && (
                            <Badge tone="warn" icon="file" title={m.preparation_notes || "Preparation required"}>
                              Prep required
                            </Badge>
                          )}
                          {m.outstanding_prior_actions > 0 && m.project_id && (
                            <Link className="tiny" to={`/tasks?tab=team&project_id=${m.project_id}&view=meeting`}>
                              {plural(m.outstanding_prior_actions, "open action")} from earlier meetings
                            </Link>
                          )}
                          {/^https?:\/\//.test(m.meeting_link) && (
                            <a className="tiny" href={m.meeting_link} target="_blank" rel="noopener noreferrer">
                              Join link <Icon name="external" size={10} />
                            </a>
                          )}
                        </div>
                        {m.preparation_required && m.preparation_notes && <div className="tiny muted mt-1">{m.preparation_notes}</div>}
                      </div>
                    </div>
                  );
                })}
              </div>
            ) : (
              <EmptyState icon="calendar" title="No meetings in the next two weeks" />
            )}
          </Card>

          <Card title="Recent activity">
            {activity.loading && !activity.data ? <Loading /> : <ActivityList rows={activity.data} empty="No recent activity on your work." />}
          </Card>

          {(can("management.view") || isAdmin) && (
            <Card title="Organisation">
              <div className="ws-links">
                {can("management.view") && (
                  <LinkButton to="/management" icon="chart" size="sm">
                    Management Intelligence
                  </LinkButton>
                )}
                {isAdmin && (
                  <LinkButton to="/admin" icon="settings" size="sm">
                    Administration
                  </LinkButton>
                )}
              </div>
            </Card>
          )}
        </aside>
      </div>

      <TaskFormModal open={adding} onClose={() => setAdding(false)} onSaved={refreshAll} />
    </>
  );
}
