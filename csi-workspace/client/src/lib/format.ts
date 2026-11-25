const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export function fmtDate(d?: string | null, opts: { year?: boolean } = {}): string {
  if (!d) return "—";
  const s = d.slice(0, 10);
  const [y, m, day] = s.split("-").map(Number);
  if (!y || !m || !day) return d;
  const showYear = opts.year ?? y !== new Date().getFullYear();
  return `${day} ${MONTHS[m - 1]}${showYear ? ` ${y}` : ""}`;
}

export function fmtDateTime(iso?: string | null): string {
  if (!iso) return "—";
  const dt = new Date(iso);
  if (Number.isNaN(dt.getTime())) return iso;
  return `${dt.getDate()} ${MONTHS[dt.getMonth()]} ${dt.getFullYear() !== new Date().getFullYear() ? dt.getFullYear() + " " : ""}${String(dt.getHours()).padStart(2, "0")}:${String(dt.getMinutes()).padStart(2, "0")}`;
}

export function relTime(iso?: string | null): string {
  if (!iso) return "";
  const diff = (Date.now() - new Date(iso).getTime()) / 1000;
  if (diff < 60) return "just now";
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  if (diff < 86400 * 7) return `${Math.floor(diff / 86400)}d ago`;
  return fmtDateTime(iso);
}

/** Days from today (local) to a YYYY-MM-DD date. Negative = past. */
export function daysUntil(date?: string | null, today?: string): number | null {
  if (!date) return null;
  const t = today ?? new Date().toISOString().slice(0, 10);
  return Math.round((Date.parse(date.slice(0, 10)) - Date.parse(t)) / 86400000);
}

/** Human due label + css class: "Overdue by 3d" / "Due today" / "Due tomorrow" / "Due 12 Dec". */
export function dueLabel(date?: string | null, today?: string, done = false): { text: string; cls: string } {
  if (!date) return { text: "No due date", cls: "muted" };
  const n = daysUntil(date, today)!;
  if (done) return { text: `Due ${fmtDate(date)}`, cls: "muted" };
  if (n < 0) return { text: `Overdue by ${-n}d`, cls: "overdue" };
  if (n === 0) return { text: "Due today", cls: "due-today" };
  if (n === 1) return { text: "Due tomorrow", cls: "" };
  return { text: `Due ${fmtDate(date)}`, cls: "" };
}

export function money(n?: number | null, currency = "ZAR"): string {
  if (n === null || n === undefined) return "—";
  try {
    return new Intl.NumberFormat("en-ZA", { style: "currency", currency, maximumFractionDigits: 0 }).format(n);
  } catch {
    return `${currency} ${n.toLocaleString()}`;
  }
}

export const initials = (name?: string | null) =>
  (name ?? "?")
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]!.toUpperCase())
    .join("");

export const plural = (n: number, one: string, many = one + "s") => `${n} ${n === 1 ? one : many}`;

export const humanize = (s?: string | null) => (s ? s.replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase()) : "");
