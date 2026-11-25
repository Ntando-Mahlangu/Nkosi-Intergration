import { fmtDate } from "../../lib/format";

/**
 * Accessible inline-SVG weekly bar chart. Each bar has a <title>, and an equivalent data
 * table is provided for screen readers.
 */
export function BarChart({ points, label }: { points: { week_start: string; value: number }[]; label: string }) {
  const W = 560, H = 160, padL = 28, padB = 22, padT = 10;
  const max = Math.max(1, ...points.map((p) => p.value));
  const bw = (W - padL) / points.length;
  const ticks = [0, Math.ceil(max / 2), max].filter((v, i, a) => a.indexOf(v) === i);
  return (
    <figure style={{ margin: 0 }}>
      <svg className="mgt-chart" viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`${label}: weekly values`}>
        {ticks.map((t) => {
          const y = H - padB - ((H - padB - padT) * t) / max;
          return (
            <g key={t}>
              <line className="axis" x1={padL} x2={W} y1={y} y2={y} strokeDasharray={t ? "2 3" : undefined} />
              <text x={padL - 6} y={y + 3} textAnchor="end">{t}</text>
            </g>
          );
        })}
        {points.map((p, i) => {
          const h = ((H - padB - padT) * p.value) / max;
          const x = padL + i * bw + bw * 0.18;
          return (
            <g key={p.week_start}>
              <rect className="bar" x={x} y={H - padB - h} width={bw * 0.64} height={Math.max(h, p.value ? 1 : 0)} rx={3}>
                <title>{`Week of ${fmtDate(p.week_start)}: ${p.value}`}</title>
              </rect>
              {(i % 2 === 0 || points.length <= 6) && (
                <text x={x + bw * 0.32} y={H - 6} textAnchor="middle">{fmtDate(p.week_start)}</text>
              )}
            </g>
          );
        })}
      </svg>
      <table className="sr-only">
        <caption>{label}</caption>
        <thead><tr><th>Week starting</th><th>Value</th></tr></thead>
        <tbody>{points.map((p) => <tr key={p.week_start}><td>{p.week_start}</td><td>{p.value}</td></tr>)}</tbody>
      </table>
    </figure>
  );
}
