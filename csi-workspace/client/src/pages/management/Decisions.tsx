import { useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../../lib/api";
import { useApi } from "../../lib/hooks";
import { useToast } from "../../lib/app-state";
import { fmtDate } from "../../lib/format";
import { Button, EmptyState, ErrorState, FormError, Loading, Modal, Segmented, StatusBadge, TextArea, Badge } from "../../components/ui";

interface Decision {
  id: string; title: string; description: string; context: string; consequences: string; status: string; requires_management: number; decision_date: string | null; created_at: string;
  project_id: string | null; project_name: string | null; meeting_id: string | null; meeting_title: string | null; decision_maker_name: string | null; created_by_name: string | null;
}

export default function Decisions() {
  const [scope, setScope] = useState<"attention" | "all">("attention");
  const { data, loading, error, reload } = useApi<{ items: Decision[]; can_approve: boolean }>("/management/decisions", { scope });
  const toast = useToast();
  const [acting, setActing] = useState<{ d: Decision; outcome: "approved" | "rejected" } | null>(null);
  const [note, setNote] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const decide = async () => {
    if (!acting) return;
    if (acting.outcome === "rejected" && !note.trim()) return setErr("Please give a reason for rejecting.");
    setBusy(true);
    setErr("");
    try {
      await api.post(`/management/decisions/${acting.d.id}/decide`, { outcome: acting.outcome, note });
      toast.success(`Decision ${acting.outcome}`);
      setActing(null);
      setNote("");
      reload();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="stack">
      <Segmented label="Decision scope" value={scope} onChange={setScope} options={[{ key: "attention", label: "Requiring attention" }, { key: "all", label: "Decision log" }]} />
      {loading && !data ? (
        <Loading />
      ) : error ? (
        <ErrorState error={error} onRetry={reload} />
      ) : !data?.items.length ? (
        <EmptyState icon="flag" title={scope === "attention" ? "No decisions waiting" : "No decisions recorded"}>{scope === "attention" ? "Proposed and pending decisions escalated to management appear here." : "Decisions recorded in meetings and projects appear here."}</EmptyState>
      ) : (
        <div className="card list">
          {data.items.map((d) => (
            <div className="list-item" key={d.id}>
              <div style={{ minWidth: 0, flex: 1 }}>
                <div className="row">
                  <span className="title">{d.title}</span>
                  <StatusBadge kind="decision" value={d.status} />
                  {d.requires_management ? <Badge tone="accent" icon="users">Management</Badge> : null}
                </div>
                {d.context && <div className="small" style={{ color: "var(--text-2)" }}>{d.context}</div>}
                {d.description && <div className="small muted">{d.description}</div>}
                <div className="meta">
                  {d.project_id && <Link to={`/projects/${d.project_id}`}>{d.project_name}</Link>}
                  {d.meeting_id && <Link to={`/meetings/${d.meeting_id}`}>From: {d.meeting_title}</Link>}
                  <span>{d.decision_date ? `Decided ${fmtDate(d.decision_date)}` : `Raised ${fmtDate(d.created_at)}`}</span>
                  {d.decision_maker_name && <span>Decision maker: {d.decision_maker_name}</span>}
                  {d.created_by_name && <span>Recorded by {d.created_by_name}</span>}
                </div>
              </div>
              {data.can_approve && ["proposed", "pending_approval"].includes(d.status) && (
                <div className="row">
                  <Button size="sm" variant="primary" icon="check" onClick={() => { setActing({ d, outcome: "approved" }); setNote(""); setErr(""); }}>Approve</Button>
                  <Button size="sm" variant="danger" icon="x" onClick={() => { setActing({ d, outcome: "rejected" }); setNote(""); setErr(""); }}>Reject</Button>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
      <Modal
        open={!!acting}
        onClose={() => setActing(null)}
        title={acting?.outcome === "approved" ? "Approve decision" : "Reject decision"}
        footer={
          <>
            <Button onClick={() => setActing(null)}>Cancel</Button>
            <Button variant={acting?.outcome === "approved" ? "primary" : "danger"} onClick={decide} loading={busy}>{acting?.outcome === "approved" ? "Approve" : "Reject"}</Button>
          </>
        }
      >
        <FormError message={err} />
        <p className="strong">{acting?.d.title}</p>
        <TextArea label={acting?.outcome === "rejected" ? "Reason (required)" : "Note (optional)"} required={acting?.outcome === "rejected"} value={note} onChange={setNote} rows={3} hint="Recorded in the decision history and shared with the person who raised it." />
      </Modal>
    </div>
  );
}
