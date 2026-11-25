import { useApi } from "../../lib/hooks";
import { Card, ErrorState, Loading, Callout } from "../../components/ui";
import { Icon } from "../../components/Icon";
import { BarChart } from "./BarChart";

interface Series { key: string; label: string; description: string; points: { week_start: string; value: number }[]; sufficient: boolean; reason?: string }

export default function Trends() {
  const { data, loading, error, reload } = useApi<{ series: Series[] }>("/management/trends");
  if (loading && !data) return <Loading />;
  if (error) return <ErrorState error={error} onRetry={reload} />;
  const series = data?.series ?? [];
  const shown = series.filter((s) => s.sufficient);
  return (
    <div className="stack">
      <Callout tone="accent" icon="info">Trends are shown only where there is enough data to be meaningful. All series are aggregated across projects — CSI Workspace does not chart individual people's output.</Callout>
      {shown.length > 0 && (
        <div className="grid grid-2">
          {shown.map((s) => (
            <Card key={s.key} title={s.label}>
              <p className="small muted">{s.description}</p>
              <BarChart points={s.points} label={s.label} />
            </Card>
          ))}
        </div>
      )}
      {series.filter((s) => !s.sufficient).length > 0 && (
        <Card title="Not enough data yet">
          <ul className="stack-sm" style={{ listStyle: "none", padding: 0, margin: 0 }}>
            {series.filter((s) => !s.sufficient).map((s) => (
              <li key={s.key} className="small row" style={{ flexWrap: "nowrap", alignItems: "flex-start" }}>
                <Icon name="chart" size={14} />
                <span><strong>{s.label}:</strong> <span className="muted">{s.reason}</span></span>
              </li>
            ))}
          </ul>
        </Card>
      )}
    </div>
  );
}
