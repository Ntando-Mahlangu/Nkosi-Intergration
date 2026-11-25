import { useState } from "react";
import { downloadUrl } from "../../lib/api";
import { useApi, useDebounced } from "../../lib/hooks";
import { fmtDateTime } from "../../lib/format";
import { Button, Card, EmptyState, ErrorState, Loading } from "../../components/ui";
import { Icon } from "../../components/Icon";

interface AuditRow { id: string; user_name: string | null; user_email: string; action: string; entity_type: string | null; entity_id: string | null; changes: string; ip: string; created_at: string }
const PAGE = 50;

function Changes({ json }: { json: string }) {
  const [open, setOpen] = useState(false);
  if (!json || json === "{}") return <span className="muted">—</span>;
  let pretty = json;
  try {
    pretty = JSON.stringify(JSON.parse(json), null, 1);
  } catch {
    /* raw */
  }
  return open ? (
    <div>
      <pre className="adm-json">{pretty}</pre>
      <button className="btn btn-ghost btn-sm" onClick={() => setOpen(false)}>Hide</button>
    </div>
  ) : (
    <button className="btn btn-ghost btn-sm" onClick={() => setOpen(true)}>View details</button>
  );
}

export default function AuditTab() {
  const [action, setAction] = useState("");
  const [user, setUser] = useState("");
  const [entity, setEntity] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [offset, setOffset] = useState(0);
  const du = useDebounced(user);
  const filters = { action, user: du, entity_type: entity, from, to };
  const { data, error, loading, reload } = useApi<{ items: AuditRow[]; total: number; actions: string[] }>("/admin/audit", { ...filters, limit: PAGE, offset });
  const setF = (fn: () => void) => {
    fn();
    setOffset(0);
  };
  return (
    <Card title="Audit log" actions={<a className="btn btn-sm" href={downloadUrl("/admin/audit.csv", filters)}><Icon name="download" size={14} /> Export CSV</a>} pad={false}>
      <div className="card-body" style={{ paddingBottom: 0 }}>
        <div className="filter-bar">
          <select className="select" aria-label="Action" value={action} onChange={(e) => setF(() => setAction(e.target.value))}>
            <option value="">All actions</option>
            {data?.actions.map((a) => <option key={a} value={a}>{a}</option>)}
          </select>
          <input className="input" type="search" placeholder="User email" aria-label="User" value={user} onChange={(e) => setF(() => setUser(e.target.value))} />
          <select className="select" aria-label="Record type" value={entity} onChange={(e) => setF(() => setEntity(e.target.value))}>
            <option value="">All record types</option>
            {["user", "role", "project", "task", "meeting", "report", "knowledge", "settings", "automation", "tasks", "projects", "system"].map((x) => <option key={x} value={x}>{x}</option>)}
          </select>
          <label className="small muted">From <input className="input" type="date" value={from} onChange={(e) => setF(() => setFrom(e.target.value))} style={{ minWidth: 0, width: "auto" }} /></label>
          <label className="small muted">To <input className="input" type="date" value={to} onChange={(e) => setF(() => setTo(e.target.value))} style={{ minWidth: 0, width: "auto" }} /></label>
        </div>
      </div>
      {error ? <ErrorState error={error} onRetry={reload} /> : loading && !data ? <Loading /> : !data?.items.length ? <EmptyState icon="eye" title="No audit entries match these filters" /> : (
        <>
          <div className="table-wrap">
            <table className="table table-stack">
              <thead><tr><th>When</th><th>Who</th><th>Action</th><th>Record</th><th>Details</th></tr></thead>
              <tbody>
                {data.items.map((a) => (
                  <tr key={a.id}>
                    <td data-label="When" className="nowrap small">{fmtDateTime(a.created_at)}</td>
                    <td data-label="Who" className="small">{a.user_name ?? (a.user_email || "System")}{a.ip && <div className="tiny muted">{a.ip}</div>}</td>
                    <td data-label="Action"><code className="small">{a.action}</code></td>
                    <td data-label="Record" className="small">{a.entity_type ? `${a.entity_type}${a.entity_id ? ` · ${a.entity_id}` : ""}` : "—"}</td>
                    <td data-label="Details"><Changes json={a.changes} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="card-footer" style={{ justifyContent: "space-between" }}>
            <span className="small muted">{offset + 1}–{Math.min(offset + PAGE, data.total)} of {data.total}</span>
            <div className="row">
              <Button size="sm" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - PAGE))}>Previous</Button>
              <Button size="sm" disabled={offset + PAGE >= data.total} onClick={() => setOffset(offset + PAGE)}>Next</Button>
            </div>
          </div>
        </>
      )}
    </Card>
  );
}
