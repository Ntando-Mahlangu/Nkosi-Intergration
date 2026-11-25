/**
 * Transparent project progress + health suggestion. Every number comes with an explanation
 * so the UI can show *how* it was calculated (product requirement 12.11 / 12.4).
 * Health is only ever *suggested* from configured rules; the project owner sets the actual value.
 */
import type { Db } from "../db/index.js";
import { getSetting, orgToday } from "./events.js";

export interface Progress {
  value: number | null;
  method: string;
  explanation: string;
  done: number;
  total: number;
}

export function projectProgress(db: Db, projectId: string): Progress {
  const p = db.get<{ progress_method: string; manual_progress: number | null }>("SELECT progress_method, manual_progress FROM projects WHERE id = ?", projectId);
  if (!p) return { value: null, method: "none", explanation: "Project not found.", done: 0, total: 0 };
  const ms = db.get<{ done: number; total: number; wd: number; wt: number }>(
    "SELECT SUM(status = 'achieved') AS done, COUNT(*) AS total, SUM(CASE WHEN status = 'achieved' THEN weight ELSE 0 END) AS wd, SUM(weight) AS wt FROM milestones WHERE project_id = ? AND status <> 'cancelled'",
    projectId,
  )!;
  const dl = db.get<{ done: number; total: number; wd: number; wt: number }>(
    "SELECT SUM(status IN ('approved','completed')) AS done, COUNT(*) AS total, SUM(CASE WHEN status IN ('approved','completed') THEN weight ELSE 0 END) AS wd, SUM(weight) AS wt FROM deliverables WHERE project_id = ? AND status <> 'cancelled'",
    projectId,
  )!;
  const tk = db.get<{ done: number; total: number }>(
    "SELECT SUM(status = 'completed') AS done, COUNT(*) AS total FROM tasks WHERE project_id = ? AND status NOT IN ('cancelled','suggested')",
    projectId,
  )!;
  const pct = (d: number, t: number) => (t ? Math.round((100 * d) / t) : null);
  switch (p.progress_method) {
    case "manual":
      return { value: p.manual_progress, method: "manual", explanation: p.manual_progress === null ? "Progress is reported by the project owner (not yet reported)." : "Reported by the project owner.", done: 0, total: 0 };
    case "deliverables":
      return { value: pct(dl.done ?? 0, dl.total), method: "deliverables", explanation: `${dl.done ?? 0} of ${dl.total} deliverables approved or completed.`, done: dl.done ?? 0, total: dl.total };
    case "tasks":
      return { value: pct(tk.done ?? 0, tk.total), method: "tasks", explanation: `${tk.done ?? 0} of ${tk.total} tasks completed (all tasks weighted equally).`, done: tk.done ?? 0, total: tk.total };
    case "weighted": {
      const wd = (ms.wd ?? 0) + (dl.wd ?? 0);
      const wt = (ms.wt ?? 0) + (dl.wt ?? 0);
      return { value: pct(wd, wt), method: "weighted", explanation: `Weighted milestones and deliverables: ${wd} of ${wt} weight points complete.`, done: wd, total: wt };
    }
    default:
      return { value: pct(ms.done ?? 0, ms.total), method: "milestones", explanation: `${ms.done ?? 0} of ${ms.total} milestones achieved.`, done: ms.done ?? 0, total: ms.total };
  }
}

export interface HealthSuggestion {
  suggested: "on_track" | "needs_attention" | "at_risk" | "blocked";
  factors: { level: "info" | "attention" | "risk" | "blocked"; text: string }[];
}

export function suggestHealth(db: Db, projectId: string, today = orgToday(db)): HealthSuggestion {
  const rules = getSetting(db, "projects.health_rules", { overdueMilestoneDays: 0, blockedTasksForAttention: 1, staleUpdateDays: 14 });
  const factors: HealthSuggestion["factors"] = [];
  const overdueMs = db.get<{ n: number }>("SELECT COUNT(*) n FROM milestones WHERE project_id = ? AND status IN ('not_started','in_progress') AND target_date IS NOT NULL AND julianday(?) - julianday(target_date) > ?", projectId, today, rules.overdueMilestoneDays)!.n;
  const overdueDl = db.get<{ n: number }>("SELECT COUNT(*) n FROM deliverables WHERE project_id = ? AND status NOT IN ('approved','completed','cancelled') AND due_date IS NOT NULL AND due_date < ?", projectId, today)!.n;
  const blockedTasks = db.get<{ n: number }>("SELECT COUNT(*) n FROM tasks WHERE project_id = ? AND status = 'blocked'", projectId)!.n;
  const overdueTasks = db.get<{ n: number }>("SELECT COUNT(*) n FROM tasks WHERE project_id = ? AND status IN ('todo','in_progress','blocked') AND due_date IS NOT NULL AND due_date < ?", projectId, today)!.n;
  const blockers = db.get<{ n: number }>("SELECT COUNT(*) n FROM risks WHERE project_id = ? AND type = 'blocker' AND status IN ('open','mitigating')", projectId)!.n;
  const highRisks = db.get<{ n: number }>("SELECT COUNT(*) n FROM risks WHERE project_id = ? AND type <> 'blocker' AND severity IN ('high','critical') AND status IN ('open','mitigating')", projectId)!.n;
  const lastUpdate = db.get<{ d: string | null }>("SELECT MAX(created_at) d FROM project_updates WHERE project_id = ?", projectId)!.d;
  const status = db.get<{ status: string }>("SELECT status FROM projects WHERE id = ?", projectId)?.status;

  if (blockers) factors.push({ level: "blocked", text: `${blockers} open blocker${blockers > 1 ? "s" : ""} in the risk register` });
  if (overdueMs) factors.push({ level: "risk", text: `${overdueMs} milestone${overdueMs > 1 ? "s" : ""} past target date` });
  if (highRisks) factors.push({ level: "risk", text: `${highRisks} open high/critical risk${highRisks > 1 ? "s" : ""}` });
  if (overdueDl) factors.push({ level: "attention", text: `${overdueDl} deliverable${overdueDl > 1 ? "s" : ""} overdue` });
  if (blockedTasks >= rules.blockedTasksForAttention) factors.push({ level: "attention", text: `${blockedTasks} blocked task${blockedTasks > 1 ? "s" : ""}` });
  if (overdueTasks) factors.push({ level: "attention", text: `${overdueTasks} overdue task${overdueTasks > 1 ? "s" : ""}` });
  if (status === "active" && (!lastUpdate || (Date.parse(today) - Date.parse(lastUpdate.slice(0, 10))) / 86400000 > rules.staleUpdateDays)) {
    factors.push({ level: "attention", text: lastUpdate ? `No project update for over ${rules.staleUpdateDays} days` : "No project update has been posted yet" });
  }
  const has = (l: string) => factors.some((f) => f.level === l);
  const suggested = has("blocked") ? "blocked" : has("risk") ? "at_risk" : has("attention") ? "needs_attention" : "on_track";
  if (!factors.length) factors.push({ level: "info", text: "No overdue milestones, deliverables, blocked tasks or open high risks." });
  return { suggested, factors };
}
