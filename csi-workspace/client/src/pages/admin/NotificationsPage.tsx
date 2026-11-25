import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { api } from "../../lib/api";
import { useApi } from "../../lib/hooks";
import { useAuth, useToast } from "../../lib/app-state";
import { relTime, fmtDateTime } from "../../lib/format";
import { Button, Card, EmptyState, ErrorState, Loading, PageHeader, Segmented } from "../../components/ui";
import { Icon } from "../../components/Icon";
import "./admin.css";

interface Ntf { id: string; type: string; title: string; body: string; entity_type: string | null; link: string; read_at: string | null; archived_at: string | null; created_at: string }
interface NtfList { items: Ntf[]; total: number; unread: number }
interface NtfType { key: string; label: string }

const TYPE_ICON: Record<string, string> = {
  task_assigned: "user", task_due_soon: "clock", task_overdue: "alert", task_completed: "checkCircle", review_requested: "eye", changes_requested: "edit",
  task_suggested: "sparkles", meeting_upcoming: "calendar", meeting_actions: "sparkles", milestone_due: "milestone", risk_identified: "alert", deliverable_due: "package",
  deliverable_submitted: "send", report_review: "report", fakawe_draft: "report", opportunity_follow_up: "target", knowledge_review: "book", decision_required: "flag", system: "info",
};
const PAGE = 30;

export default function NotificationsPage() {
  const { setUnread } = useAuth();
  const toast = useToast();
  const nav = useNavigate();
  const [filter, setFilter] = useState<"unread" | "all" | "archived">("unread");
  const [type, setType] = useState("");
  const [limit, setLimit] = useState(PAGE);
  const { data, error, loading, reload, setData } = useApi<NtfList>("/notifications", { filter, type, limit });
  const types = useApi<{ types: NtfType[] }>("/notifications/types");

  const apply = (unread: number) => setUnread(unread);
  const open = async (n: Ntf) => {
    if (!n.read_at) {
      try {
        const r = await api.post<{ unread: number }>(`/notifications/${n.id}/read`);
        apply(r.unread);
      } catch {
        /* navigation still useful */
      }
    }
    if (n.link) nav(n.link);
    else reload();
  };
  const act = async (path: string, msg: string) => {
    try {
      const r = await api.post<{ unread: number }>(path);
      apply(r.unread);
      toast.success(msg);
      reload();
    } catch (e) {
      toast.error((e as Error).message);
    }
  };
  const toggleRead = async (n: Ntf) => {
    const r = await api.post<{ unread: number }>(`/notifications/${n.id}/${n.read_at ? "unread" : "read"}`).catch((e) => { toast.error(e.message); return null; });
    if (!r) return;
    apply(r.unread);
    setData((d) => (d ? { ...d, unread: r.unread, items: d.items.map((x) => (x.id === n.id ? { ...x, read_at: n.read_at ? null : new Date().toISOString() } : x)).filter((x) => filter !== "unread" || !x.read_at) } : d));
  };

  return (
    <>
      <PageHeader
        title="Notifications"
        subtitle="Assignments, reviews, reminders and updates relevant to you."
        actions={
          <>
            <Button icon="check" onClick={() => act("/notifications/read-all", "All notifications marked as read")} disabled={!data?.unread}>Mark all read</Button>
            <Button icon="archive" onClick={() => act("/notifications/archive-read", "Read notifications archived")}>Archive read</Button>
            <Button variant="ghost" icon="settings" onClick={() => nav("/profile#notifications")}>Preferences</Button>
          </>
        }
      />
      <div className="filter-bar">
        <Segmented label="Show" value={filter} onChange={(v) => { setFilter(v); setLimit(PAGE); }} options={[{ key: "unread", label: "Unread", count: data?.unread }, { key: "all", label: "All" }, { key: "archived", label: "Archived" }]} />
        <select className="select" aria-label="Notification type" value={type} onChange={(e) => setType(e.target.value)}>
          <option value="">All types</option>
          {types.data?.types.map((t) => <option key={t.key} value={t.key}>{t.label}</option>)}
        </select>
      </div>
      <Card pad={false}>
        {error ? <ErrorState error={error} onRetry={reload} /> : loading && !data ? <Loading /> : !data?.items.length ? (
          <EmptyState icon="bell" title={filter === "unread" ? "You're all caught up" : "No notifications"}>
            {filter === "unread" ? "New assignments, review requests and reminders will appear here." : "Nothing matches this view."}
          </EmptyState>
        ) : (
          <div role="list">
            {data.items.map((n) => (
              <div key={n.id} role="listitem" className={`ntf-item ${n.read_at ? "" : "unread"}`}>
                <span className={`ntf-dot ${n.read_at ? "read" : ""}`} aria-hidden />
                <Icon name={TYPE_ICON[n.type] ?? "bell"} />
                <button className="ntf-open" onClick={() => open(n)} aria-label={`${n.read_at ? "" : "Unread: "}${n.title}`}>
                  <div className="ntf-title">{n.title}</div>
                  {n.body && <div className="small muted">{n.body}</div>}
                  <div className="tiny muted" title={fmtDateTime(n.created_at)}>{relTime(n.created_at)}</div>
                </button>
                <div className="row" style={{ flexWrap: "nowrap" }}>
                  {!n.archived_at && <button className="btn btn-ghost btn-sm" onClick={() => toggleRead(n)}>{n.read_at ? "Mark unread" : "Mark read"}</button>}
                  {!n.archived_at ? (
                    <button className="btn btn-ghost btn-sm" aria-label="Archive notification" onClick={() => act(`/notifications/${n.id}/archive`, "Archived")}><Icon name="archive" size={14} /></button>
                  ) : (
                    <button className="btn btn-ghost btn-sm" onClick={() => act(`/notifications/${n.id}/unread`, "Restored")}>Restore</button>
                  )}
                </div>
              </div>
            ))}
            {data.total > data.items.length && (
              <div className="card-footer" style={{ justifyContent: "center" }}>
                <Button size="sm" onClick={() => setLimit(limit + PAGE)}>Show more ({data.total - data.items.length} more)</Button>
              </div>
            )}
          </div>
        )}
      </Card>
    </>
  );
}
