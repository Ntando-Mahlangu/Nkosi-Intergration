import { useState } from "react";
import { api } from "../../lib/api";
import { useApi } from "../../lib/hooks";
import { useToast } from "../../lib/app-state";
import { fmtDateTime, relTime } from "../../lib/format";
import { Badge, Button, Card, ErrorState, Loading, Callout, EmptyState } from "../../components/ui";
import { errFields } from "./shared";

interface Rule { key: string; name: string; description: string; trigger: string; action: string; enabled: number; config: Record<string, unknown>; last_run_at: string | null; last_result: string }
interface Run { id: string; rule_key: string; started_at: string; finished_at: string | null; outcome: string; detail: string }

export default function AutomationsTab() {
  const { data, error, loading, reload } = useApi<{ rules: Rule[]; runs: Run[] }>("/admin/automations");
  const toast = useToast();
  const [busy, setBusy] = useState<string | null>(null);
  if (error) return <ErrorState error={error} onRetry={reload} />;
  if (loading && !data) return <Loading />;
  const toggle = async (r: Rule) => {
    setBusy(r.key);
    try {
      await api.patch(`/admin/automations/${r.key}`, { enabled: !r.enabled });
      toast.success(`${r.name} ${r.enabled ? "disabled" : "enabled"}`);
      reload();
    } catch (e) {
      toast.error(errFields(e).message);
    } finally {
      setBusy(null);
    }
  };
  const run = async (r: Rule) => {
    setBusy(r.key);
    try {
      const res = await api.post<{ outcome: string; detail: string }>(`/admin/automations/${r.key}/run`);
      (res.outcome === "ok" ? toast.success : toast.error)(`${r.name}: ${res.detail}`);
      reload();
    } catch (e) {
      toast.error(errFields(e).message);
    } finally {
      setBusy(null);
    }
  };
  const names = new Map((data?.rules ?? []).map((r) => [r.key, r.name]));
  return (
    <div className="stack">
      <Callout icon="zap">
        Scheduled rules run hourly on the server. Each reminder is sent at most once per record per day (deduplicated), and people can mute notification types in their profile.
        Disabled rules never run on schedule; “Run now” runs a rule once even if disabled.
      </Callout>
      <Card title="Rules" pad={false}>
        <div className="list">
          {data?.rules.map((r) => (
            <div className="list-item" key={r.key}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div className="title">{r.name} {r.enabled ? <Badge tone="ok" icon="check">Enabled</Badge> : <Badge icon="pause">Disabled</Badge>}</div>
                <div className="small muted">{r.description}</div>
                <div className="meta"><span>When: {r.trigger}</span><span>Then: {r.action}</span>{r.last_run_at && <span title={fmtDateTime(r.last_run_at)}>Last run {relTime(r.last_run_at)} — {r.last_result}</span>}</div>
              </div>
              <div className="row">
                <Button size="sm" onClick={() => run(r)} loading={busy === r.key} disabled={r.trigger.startsWith("meeting")}>Run now</Button>
                <Button size="sm" variant={r.enabled ? "ghost" : "primary"} onClick={() => toggle(r)} disabled={busy === r.key}>{r.enabled ? "Disable" : "Enable"}</Button>
              </div>
            </div>
          ))}
        </div>
      </Card>
      <Card title="Recent runs" pad={false}>
        {!data?.runs.length ? <EmptyState icon="clock" title="No runs yet">Rules run shortly after the server starts and then every hour.</EmptyState> : (
          <div className="table-wrap">
            <table className="table table-stack">
              <thead><tr><th>Rule</th><th>Started</th><th>Outcome</th><th>Detail</th></tr></thead>
              <tbody>
                {data.runs.map((r) => (
                  <tr key={r.id}>
                    <td data-label="Rule">{names.get(r.rule_key) ?? r.rule_key}</td>
                    <td data-label="Started" className="nowrap">{fmtDateTime(r.started_at)}</td>
                    <td data-label="Outcome"><Badge tone={r.outcome === "ok" ? "ok" : r.outcome === "error" ? "danger" : "neutral"}>{r.outcome || "running"}</Badge></td>
                    <td data-label="Detail" className="small">{r.detail}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}
