import { useApi } from "../../lib/hooks";
import { Badge, Callout, Card, ErrorState, Loading } from "../../components/ui";
import type { Tone } from "../../lib/status";

interface Integration { key: string; name: string; status: "connected" | "configured" | "not_configured" | "planned"; detail: string; fallback: string }
const STATUS: Record<Integration["status"], { label: string; tone: Tone; icon: string }> = {
  connected: { label: "Connected", tone: "ok", icon: "checkCircle" },
  configured: { label: "Configured", tone: "accent", icon: "check" },
  not_configured: { label: "Not configured", tone: "warn", icon: "alertCircle" },
  planned: { label: "Not yet available", tone: "neutral", icon: "clock" },
};

export default function IntegrationsTab() {
  const { data, error, loading, reload } = useApi<{ integrations: Integration[]; ai: { engine: string; note: string } }>("/admin/integrations");
  if (error) return <ErrorState error={error} onRetry={reload} />;
  if (loading && !data) return <Loading />;
  return (
    <div className="stack">
      <Callout icon="info">
        Integrations are configured with server environment variables (never stored in the database or shown here). “Configured” means credentials are present;
        it does not guarantee the external service accepts them — test sign-in after changing them. Features marked “Not yet available” need OAuth scopes approved by CSI's
        Google Workspace administrator and are not implemented in this version; the listed fallback is what CSI Workspace does today.
      </Callout>
      <div className="grid grid-2">
        {data?.integrations.map((i) => {
          const s = STATUS[i.status];
          return (
            <Card key={i.key} title={i.name} actions={<Badge tone={s.tone} icon={s.icon}>{s.label}</Badge>}>
              <div className="adm-int small">
                <div>{i.detail}</div>
                <div className="muted"><strong>Works today:</strong> {i.fallback}</div>
              </div>
            </Card>
          );
        })}
      </div>
      <p className="small muted">Current AI engine: <strong>{data?.ai.engine}</strong>. {data?.ai.note}</p>
    </div>
  );
}
