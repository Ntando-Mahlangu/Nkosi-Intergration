/**
 * Management Intelligence (spec §15). All endpoints require `management.view`.
 *
 * Privacy: everything is aggregated per project/organisation from records the manager can
 * already see. Personal tasks, private learning records and confidential meetings never
 * contribute, restricted projects appear only if the manager is a member, and there are no
 * per-person productivity rankings (spec 26.5).
 */
import { Router } from "express";
import { z } from "zod";
import type { Db } from "../db/index.js";
import { h, parse, badRequest, conflict, forbidden, notFound, zText } from "../lib/http.js";
import { can, currentUser, requirePerm, type AuthUser } from "../lib/context.js";
import { addDays, newId, nowIso } from "../lib/ids.js";
import { activity, audit, notify, orgToday, statusChange } from "../lib/events.js";
import { decisionVisibleSql, opportunityVisibleSql, projectIdVisibleSql, projectVisibleSql } from "../lib/access.js";
import { projectProgress, suggestHealth } from "../lib/progress.js";

export const managementRouter = Router();

managementRouter.use((req, _res, next) => {
  try {
    requirePerm(currentUser(req), "management.view");
    next();
  } catch (e) {
    next(e);
  }
});

const SEV_RANK: Record<string, number> = { critical: 4, high: 3, medium: 2, low: 1 };
const humanize = (s: string) => s.replace(/_/g, " ");

/** Project-linked, non-personal tasks in projects the user can see. */
function taskScope(u: AuthUser, t = "t") {
  const f = projectIdVisibleSql(u, `${t}.project_id`);
  return { sql: `(${t}.project_id IS NOT NULL AND ${t}.is_personal = 0 AND ${f.sql})`, params: f.params };
}

// ------------------------------------------------------------------ overview
managementRouter.get(
  "/overview",
  h((req, res) => {
    const u = currentUser(req);
    const db = req.ctx.db;
    const today = orgToday(db);
    const in14 = addDays(today, 14);
    const pf = projectVisibleSql(u, "p");
    const pid = projectIdVisibleSql(u, "x.project_id");
    const ts = taskScope(u);

    const statusDist = db.all<{ status: string; n: number }>(`SELECT p.status, COUNT(*) n FROM projects p WHERE ${pf.sql} GROUP BY p.status`, ...pf.params);
    const healthDist = db.all<{ health: string; n: number }>(`SELECT p.health, COUNT(*) n FROM projects p WHERE ${pf.sql} AND p.status NOT IN ('completed','cancelled') GROUP BY p.health`, ...pf.params);
    const one = (sql: string, ...params: (string | number)[]) => db.get<{ n: number }>(sql, ...params)!.n;

    const activeProjects = one(`SELECT COUNT(*) n FROM projects p WHERE ${pf.sql} AND p.status IN ('active','at_risk')`, ...(pf.params as (string | number)[]));
    const atRisk = one(`SELECT COUNT(*) n FROM projects p WHERE ${pf.sql} AND p.status NOT IN ('completed','cancelled') AND (p.status = 'at_risk' OR p.health = 'at_risk')`, ...(pf.params as (string | number)[]));
    const blocked = one(`SELECT COUNT(*) n FROM projects p WHERE ${pf.sql} AND p.status NOT IN ('completed','cancelled') AND p.health = 'blocked'`, ...(pf.params as (string | number)[]));

    const P = pid.params as (string | number)[];
    const upcomingMilestones = one(`SELECT COUNT(*) n FROM milestones x WHERE x.status IN ('not_started','in_progress') AND x.target_date BETWEEN ? AND ? AND ${pid.sql}`, today, in14, ...P);
    const overdueMilestones = one(`SELECT COUNT(*) n FROM milestones x WHERE x.status IN ('not_started','in_progress') AND x.target_date < ? AND ${pid.sql}`, today, ...P);
    const outstandingDeliverables = one(`SELECT COUNT(*) n FROM deliverables x WHERE x.status NOT IN ('approved','completed','cancelled') AND ${pid.sql}`, ...P);
    const overdueDeliverables = one(`SELECT COUNT(*) n FROM deliverables x WHERE x.status NOT IN ('approved','completed','cancelled') AND x.due_date < ? AND ${pid.sql}`, today, ...P);

    const T = ts.params as (string | number)[];
    const openActions = one(`SELECT COUNT(*) n FROM tasks t WHERE t.status IN ('todo','in_progress','blocked','awaiting_review') AND ${ts.sql}`, ...T);
    const overdueActions = one(`SELECT COUNT(*) n FROM tasks t WHERE t.status IN ('todo','in_progress','blocked') AND t.due_date < ? AND ${ts.sql}`, today, ...T);
    const awaitingReview = one(`SELECT COUNT(*) n FROM tasks t WHERE t.status = 'awaiting_review' AND ${ts.sql}`, ...T);

    const df = decisionVisibleSql(u, "d");
    const decisionsAttention = one(`SELECT COUNT(*) n FROM decisions d WHERE (d.status = 'pending_approval' OR (d.status = 'proposed' AND d.requires_management = 1)) AND ${df.sql}`, ...(df.params as (string | number)[]));

    const deadlines = db.all(
      `SELECT rp.id, rp.name, rp.submission_deadline, rp.status, uo.name AS owner_name,
         (SELECT r.status FROM reports r WHERE r.report_type = 'fakawe' AND r.period_id = rp.id ORDER BY r.created_at DESC LIMIT 1) AS report_status
       FROM reporting_periods rp LEFT JOIN users uo ON uo.id = rp.owner_id
       WHERE rp.status NOT IN ('approved','archived') AND rp.submission_deadline IS NOT NULL AND rp.submission_deadline >= ?
       ORDER BY rp.submission_deadline LIMIT 5`,
      addDays(today, -7),
    );

    const of = opportunityVisibleSql(u, "o");
    const pipeline = db.all<{ stage: string; n: number; value: number | null; weighted: number | null }>(
      `SELECT o.stage, COUNT(*) n, SUM(o.estimated_value) value, SUM(CASE WHEN o.estimated_value IS NOT NULL AND o.probability IS NOT NULL THEN o.estimated_value * o.probability / 100.0 END) weighted
       FROM opportunities o WHERE ${of.sql} GROUP BY o.stage`,
      ...of.params,
    );

    res.json({
      today,
      projects: { active: activeProjects, at_risk: atRisk, blocked, status: statusDist, health: healthDist },
      milestones: { upcoming_14d: upcomingMilestones, overdue: overdueMilestones },
      deliverables: { outstanding: outstandingDeliverables, overdue: overdueDeliverables },
      actions: { open: openActions, overdue: overdueActions, awaiting_review: awaitingReview, note: "Project-linked actions only; personal tasks are never included." },
      decisions: { requiring_attention: decisionsAttention },
      reporting_deadlines: deadlines,
      pipeline,
    });
  }),
);

// ------------------------------------------------------------------ portfolio
interface PortfolioRow {
  id: string;
  name: string;
  code: string | null;
  status: string;
  health: string;
  health_note: string;
  priority: string;
  owner_id: string | null;
  owner_name: string | null;
  programme_id: string | null;
  programme_name: string | null;
  target_date: string | null;
  visibility: string;
  progress: number | null;
  progress_method: string;
  progress_explanation: string;
  next_milestone: string | null;
  next_milestone_date: string | null;
  outstanding_actions: number;
  overdue_actions: number;
  risk_level: string | null;
  suggested_health: string;
  health_factors: { level: string; text: string }[];
}

export function portfolio(db: Db, u: AuthUser, today: string): PortfolioRow[] {
  const pf = projectVisibleSql(u, "p");
  const rows = db.all<Omit<PortfolioRow, "progress" | "progress_method" | "progress_explanation" | "suggested_health" | "health_factors">>(
    `SELECT p.id, p.name, p.code, p.status, p.health, p.health_note, p.priority, p.owner_id, uo.name AS owner_name, p.programme_id, pg.name AS programme_name, p.target_date, p.visibility,
       (SELECT ml.title FROM milestones ml WHERE ml.project_id = p.id AND ml.status IN ('not_started','in_progress') ORDER BY ml.target_date IS NULL, ml.target_date LIMIT 1) AS next_milestone,
       (SELECT ml.target_date FROM milestones ml WHERE ml.project_id = p.id AND ml.status IN ('not_started','in_progress') ORDER BY ml.target_date IS NULL, ml.target_date LIMIT 1) AS next_milestone_date,
       (SELECT COUNT(*) FROM tasks t WHERE t.project_id = p.id AND t.is_personal = 0 AND t.status IN ('todo','in_progress','blocked','awaiting_review')) AS outstanding_actions,
       (SELECT COUNT(*) FROM tasks t WHERE t.project_id = p.id AND t.is_personal = 0 AND t.status IN ('todo','in_progress','blocked') AND t.due_date < ?) AS overdue_actions,
       (SELECT r.severity FROM risks r WHERE r.project_id = p.id AND r.status IN ('open','mitigating') ORDER BY CASE r.severity WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END LIMIT 1) AS risk_level
     FROM projects p LEFT JOIN users uo ON uo.id = p.owner_id LEFT JOIN programmes pg ON pg.id = p.programme_id
     WHERE ${pf.sql}`,
    today,
    ...pf.params,
  );
  return rows.map((r) => {
    const prog = projectProgress(db, r.id);
    const hs = suggestHealth(db, r.id, today);
    return { ...r, progress: prog.value, progress_method: prog.method, progress_explanation: prog.explanation, suggested_health: hs.suggested, health_factors: hs.factors };
  });
}

const HEALTH_RANK: Record<string, number> = { blocked: 0, at_risk: 1, needs_attention: 2, on_track: 3, completed: 4 };

managementRouter.get(
  "/portfolio",
  h((req, res) => {
    const u = currentUser(req);
    const db = req.ctx.db;
    const q = parse(
      z.object({
        status: z.string().max(40).optional(),
        health: z.string().max(40).optional(),
        owner_id: z.string().max(64).optional(),
        programme_id: z.string().max(64).optional(),
        q: z.string().max(120).optional(),
        include_closed: z.enum(["0", "1"]).optional(),
        sort: z.enum(["name", "status", "health", "progress", "deadline", "risk", "outstanding"]).optional().default("health"),
        dir: z.enum(["asc", "desc"]).optional().default("asc"),
      }),
      req.query,
    );
    const today = orgToday(db);
    let rows = portfolio(db, u, today);
    if (q.status) rows = rows.filter((r) => r.status === q.status);
    else if (q.include_closed !== "1") rows = rows.filter((r) => !["completed", "cancelled"].includes(r.status));
    if (q.health) rows = rows.filter((r) => r.health === q.health);
    if (q.owner_id) rows = rows.filter((r) => r.owner_id === q.owner_id);
    if (q.programme_id) rows = rows.filter((r) => r.programme_id === q.programme_id);
    if (q.q) {
      const s = q.q.toLowerCase();
      rows = rows.filter((r) => r.name.toLowerCase().includes(s) || (r.code ?? "").toLowerCase().includes(s));
    }
    const key: Record<string, (r: PortfolioRow) => string | number> = {
      name: (r) => r.name.toLowerCase(),
      status: (r) => r.status,
      health: (r) => HEALTH_RANK[r.health] ?? 9,
      progress: (r) => r.progress ?? -1,
      deadline: (r) => r.target_date ?? "9999",
      risk: (r) => -(SEV_RANK[r.risk_level ?? ""] ?? 0),
      outstanding: (r) => -r.outstanding_actions,
    };
    const k = key[q.sort];
    rows.sort((a, b) => {
      const x = k(a), y = k(b);
      const c = x < y ? -1 : x > y ? 1 : a.name.localeCompare(b.name);
      return q.dir === "desc" ? -c : c;
    });
    res.json({ items: rows, today });
  }),
);

// ------------------------------------------------------------------ attention required
export interface AttentionItem {
  type: string;
  id: string;
  title: string;
  project: string | null;
  link: string;
  severity: "critical" | "high" | "medium";
  why: string;
}

export function attentionItems(db: Db, u: AuthUser, today: string): AttentionItem[] {
  const items: AttentionItem[] = [];
  const pf = projectVisibleSql(u, "p");
  const pid = (col: string) => projectIdVisibleSql(u, col);

  for (const p of db.all<{ id: string; name: string; health_note: string }>(`SELECT p.id, p.name, p.health_note FROM projects p WHERE ${pf.sql} AND p.health = 'blocked' AND p.status NOT IN ('completed','cancelled')`, ...pf.params)) {
    items.push({ type: "project", id: p.id, title: p.name, project: p.name, link: `/projects/${p.id}`, severity: "critical", why: `Project marked as blocked by its owner${p.health_note ? `: ${p.health_note}` : "."}` });
  }

  const m = pid("ml.project_id");
  for (const r of db.all<{ id: string; title: string; target_date: string; project_id: string; project: string; owner: string | null }>(
    `SELECT ml.id, ml.title, ml.target_date, ml.project_id, p.name project, uo.name owner FROM milestones ml JOIN projects p ON p.id = ml.project_id LEFT JOIN users uo ON uo.id = ml.owner_id
     WHERE ml.status IN ('not_started','in_progress') AND ml.target_date < ? AND ${m.sql}`,
    today, ...m.params,
  )) {
    const days = Math.round((Date.parse(today) - Date.parse(r.target_date)) / 86400000);
    items.push({ type: "milestone", id: r.id, title: r.title, project: r.project, link: `/projects/${r.project_id}`, severity: days > 14 ? "high" : "medium", why: `Milestone ${days === 1 ? "1 day" : `${days} days`} past its target date (${r.target_date})${r.owner ? `; owner ${r.owner}` : "; no owner"}.` });
  }

  const d = pid("dv.project_id");
  for (const r of db.all<{ id: string; name: string; due_date: string | null; status: string; project_id: string; project: string }>(
    `SELECT dv.id, dv.name, dv.due_date, dv.status, dv.project_id, p.name project FROM deliverables dv JOIN projects p ON p.id = dv.project_id
     WHERE ((dv.status NOT IN ('approved','completed','cancelled') AND dv.due_date < ?) OR dv.status = 'changes_requested') AND ${d.sql}`,
    today, ...d.params,
  )) {
    const overdue = r.due_date && r.due_date < today;
    items.push({
      type: "deliverable", id: r.id, title: r.name, project: r.project, link: `/projects/${r.project_id}`, severity: overdue ? "high" : "medium",
      why: overdue ? `Deliverable overdue since ${r.due_date} (status: ${humanize(r.status)}).` : "Reviewer requested changes; awaiting resubmission.",
    });
  }

  const rk = pid("rk.project_id");
  for (const r of db.all<{ id: string; title: string; type: string; severity: string; project_id: string; project: string; owner: string | null; review_date: string | null }>(
    `SELECT rk.id, rk.title, rk.type, rk.severity, rk.project_id, p.name project, uo.name owner, rk.review_date FROM risks rk JOIN projects p ON p.id = rk.project_id LEFT JOIN users uo ON uo.id = rk.owner_id
     WHERE rk.status IN ('open','mitigating') AND (rk.type = 'blocker' OR rk.severity IN ('high','critical')) AND ${rk.sql}`,
    ...rk.params,
  )) {
    const extra = [r.owner ? `owner ${r.owner}` : "no owner assigned", r.review_date && r.review_date < today ? `review date ${r.review_date} has passed` : ""].filter(Boolean).join("; ");
    items.push({
      type: "risk", id: r.id, title: r.title, project: r.project, link: `/projects/${r.project_id}`,
      severity: r.severity === "critical" || r.type === "blocker" ? "critical" : "high",
      why: `Unresolved ${r.type === "blocker" ? "blocker" : `${r.severity}-severity ${r.type}`} (${extra}).`,
    });
  }

  const df = decisionVisibleSql(u, "dc");
  for (const r of db.all<{ id: string; title: string; status: string; project: string | null; project_id: string | null; created_at: string }>(
    `SELECT dc.id, dc.title, dc.status, p.name project, dc.project_id, dc.created_at FROM decisions dc LEFT JOIN projects p ON p.id = dc.project_id
     WHERE (dc.status = 'pending_approval' OR (dc.status = 'proposed' AND dc.requires_management = 1)) AND ${df.sql}`,
    ...df.params,
  )) {
    const age = Math.round((Date.parse(today) - Date.parse(r.created_at.slice(0, 10))) / 86400000);
    items.push({ type: "decision", id: r.id, title: r.title, project: r.project, link: "/management/decisions", severity: age > 7 ? "high" : "medium", why: `Decision ${r.status === "pending_approval" ? "awaiting management approval" : "proposed for management"}${age === 0 ? " since today" : ` for ${age === 1 ? "1 day" : `${age} days`}`}.` });
  }

  // Tasks whose dependency is not yet complete.
  const ts = taskScope(u, "t");
  for (const r of db.all<{ id: string; title: string; project_id: string; project: string; to_type: string; to_id: string; due_date: string | null }>(
    `SELECT t.id, t.title, t.project_id, p.name project, dp.to_type, dp.to_id, t.due_date FROM dependencies dp
     JOIN tasks t ON dp.from_type = 'task' AND dp.from_id = t.id JOIN projects p ON p.id = t.project_id
     WHERE t.status IN ('todo','in_progress','blocked') AND ${ts.sql} AND (
       (dp.to_type = 'task' AND EXISTS (SELECT 1 FROM tasks t2 WHERE t2.id = dp.to_id AND t2.status NOT IN ('completed','cancelled')))
       OR (dp.to_type = 'milestone' AND EXISTS (SELECT 1 FROM milestones m2 WHERE m2.id = dp.to_id AND m2.status NOT IN ('achieved','cancelled')))
       OR (dp.to_type = 'deliverable' AND EXISTS (SELECT 1 FROM deliverables d2 WHERE d2.id = dp.to_id AND d2.status NOT IN ('approved','completed','cancelled'))))`,
    ...ts.params,
  )) {
    items.push({ type: "task", id: r.id, title: r.title, project: r.project, link: `/tasks/${r.id}`, severity: r.due_date && r.due_date <= addDays(today, 3) ? "high" : "medium", why: `Waiting on an unfinished ${r.to_type}${r.due_date ? `; task due ${r.due_date}` : ""}.` });
  }

  for (const p of db.all<{ id: string; name: string; last: string | null }>(
    `SELECT p.id, p.name, (SELECT MAX(created_at) FROM project_updates pu WHERE pu.project_id = p.id) last FROM projects p WHERE ${pf.sql} AND p.status IN ('active','at_risk')`,
    ...pf.params,
  )) {
    const age = p.last ? Math.round((Date.parse(today) - Date.parse(p.last.slice(0, 10))) / 86400000) : null;
    if (age === null || age > 14) items.push({ type: "project", id: p.id, title: p.name, project: p.name, link: `/projects/${p.id}`, severity: "medium", why: age === null ? "Active project with no update posted yet." : `No project update for ${age} days.` });
  }

  const of = opportunityVisibleSql(u, "o");
  for (const o of db.all<{ id: string; name: string; follow_up_date: string; owner: string | null; next_action: string }>(
    `SELECT o.id, o.name, o.follow_up_date, uo.name owner, o.next_action FROM opportunities o LEFT JOIN users uo ON uo.id = o.owner_id
     WHERE o.follow_up_date < ? AND o.stage NOT IN ('secured','lost','on_hold') AND ${of.sql}`,
    today, ...of.params,
  )) {
    items.push({ type: "opportunity", id: o.id, title: o.name, project: null, link: `/opportunities/${o.id}`, severity: "medium", why: `Follow-up was due ${o.follow_up_date}${o.next_action ? ` (next action: ${o.next_action})` : ""}${o.owner ? `; owner ${o.owner}` : ""}.` });
  }

  const sevOrder = { critical: 0, high: 1, medium: 2 };
  return items.sort((a, b) => sevOrder[a.severity] - sevOrder[b.severity] || a.title.localeCompare(b.title));
}

managementRouter.get(
  "/attention",
  h((req, res) => {
    const u = currentUser(req);
    const db = req.ctx.db;
    const items = attentionItems(db, u, orgToday(db));
    res.json({ items, counts: { critical: items.filter((i) => i.severity === "critical").length, high: items.filter((i) => i.severity === "high").length, medium: items.filter((i) => i.severity === "medium").length } });
  }),
);

// ------------------------------------------------------------------ trends
export interface Series {
  key: string;
  label: string;
  description: string;
  points: { week_start: string; value: number }[];
  sufficient: boolean;
  reason?: string;
}

export function weekStart(date: string): string {
  const dow = new Date(date + "T00:00:00Z").getUTCDay();
  return addDays(date, -((dow + 6) % 7));
}

export function trends(db: Db, u: AuthUser, today: string, weeks = 10): Series[] {
  const first = addDays(weekStart(today), -7 * (weeks - 1));
  const starts = Array.from({ length: weeks }, (_, i) => addDays(first, 7 * i));
  const ts = taskScope(u, "t");
  const pid = projectIdVisibleSql(u, "ml.project_id");
  const of = opportunityVisibleSql(u, "o");

  const bucket = (dates: string[]) => starts.map((s) => ({ week_start: s, value: dates.filter((d) => d >= s && d <= addDays(s, 6)).length }));

  const completions = bucket(db.all<{ d: string }>(`SELECT substr(t.completed_at,1,10) d FROM tasks t WHERE t.status = 'completed' AND t.completed_at IS NOT NULL AND substr(t.completed_at,1,10) >= ? AND ${ts.sql}`, first, ...ts.params).map((r) => r.d));

  const taskRows = db.all<{ due: string; created: string; completed: string | null; status: string }>(
    `SELECT t.due_date due, substr(t.created_at,1,10) created, substr(t.completed_at,1,10) completed, t.status FROM tasks t WHERE t.due_date IS NOT NULL AND t.status NOT IN ('cancelled','suggested') AND ${ts.sql}`,
    ...ts.params,
  );
  const overdue = starts.map((s) => {
    const end = addDays(s, 6) < today ? addDays(s, 6) : today;
    return { week_start: s, value: taskRows.filter((t) => t.created <= end && t.due < end && (!t.completed || t.completed > end)).length };
  });

  const milestones = bucket(db.all<{ d: string }>(`SELECT ml.completed_date d FROM milestones ml WHERE ml.status = 'achieved' AND ml.completed_date >= ? AND ${pid.sql}`, first, ...pid.params).map((r) => r.d));
  const oppsCreated = bucket(db.all<{ d: string }>(`SELECT substr(o.created_at,1,10) d FROM opportunities o WHERE substr(o.created_at,1,10) >= ? AND ${of.sql}`, first, ...of.params).map((r) => r.d));
  const oppsSecured = bucket(
    db.all<{ d: string }>(
      `SELECT substr(COALESCE((SELECT MAX(sh.changed_at) FROM status_history sh WHERE sh.entity_type = 'opportunity' AND sh.entity_id = o.id AND sh.to_value = 'secured'), o.updated_at),1,10) d
       FROM opportunities o WHERE o.stage = 'secured' AND ${of.sql}`,
      ...of.params,
    ).map((r) => r.d),
  );

  const mk = (key: string, label: string, description: string, points: { week_start: string; value: number }[], minWeeks = 4): Series => {
    const withData = points.filter((p) => p.value > 0).length;
    const sufficient = withData >= minWeeks;
    return { key, label, description, points, sufficient, reason: sufficient ? undefined : `Only ${withData} of ${points.length} weeks have data — at least ${minWeeks} are needed for a meaningful trend.` };
  };
  return [
    mk("task_completions", "Project actions completed", "Project-linked actions marked complete each week.", completions),
    mk("overdue_actions", "Overdue actions (end of week)", "Approximate number of project actions past their due date at the end of each week, reconstructed from due and completion dates.", overdue),
    mk("milestones_achieved", "Milestones achieved", "Milestones marked achieved each week.", milestones),
    mk("opportunities_created", "Opportunities identified", "New opportunities recorded each week.", oppsCreated),
    mk("opportunities_secured", "Opportunities secured", "Opportunities moved to Secured each week.", oppsSecured, 3),
  ];
}

managementRouter.get(
  "/trends",
  h((req, res) => {
    const u = currentUser(req);
    const db = req.ctx.db;
    const today = orgToday(db);
    res.json({ today, series: trends(db, u, today) });
  }),
);

// ------------------------------------------------------------------ decision log (management view + approvals)
managementRouter.get(
  "/decisions",
  h((req, res) => {
    const u = currentUser(req);
    const db = req.ctx.db;
    const q = parse(z.object({ status: z.string().max(40).optional(), scope: z.enum(["attention", "all"]).optional().default("all"), project_id: z.string().max(64).optional() }), req.query);
    const df = decisionVisibleSql(u, "d");
    const where = [df.sql];
    const params = [...df.params];
    if (q.scope === "attention") where.push("(d.status = 'pending_approval' OR (d.status = 'proposed' AND d.requires_management = 1))");
    if (q.status) {
      where.push("d.status = ?");
      params.push(q.status);
    }
    if (q.project_id) {
      where.push("d.project_id = ?");
      params.push(q.project_id);
    }
    const items = db.all(
      `SELECT d.*, p.name AS project_name, m.title AS meeting_title, um.name AS decision_maker_name, uc.name AS created_by_name
       FROM decisions d LEFT JOIN projects p ON p.id = d.project_id LEFT JOIN meetings m ON m.id = d.meeting_id
       LEFT JOIN users um ON um.id = d.decision_maker_id LEFT JOIN users uc ON uc.id = d.created_by
       WHERE ${where.join(" AND ")} ORDER BY CASE WHEN d.status IN ('pending_approval','proposed') THEN 0 ELSE 1 END, COALESCE(d.decision_date, substr(d.created_at,1,10)) DESC LIMIT 300`,
      ...params,
    );
    res.json({ items, can_approve: can(u, "decision.approve") });
  }),
);

managementRouter.post(
  "/decisions/:id/decide",
  h((req, res) => {
    const u = currentUser(req);
    requirePerm(u, "decision.approve");
    const db = req.ctx.db;
    const b = parse(z.object({ outcome: z.enum(["approved", "rejected"]), note: zText(2000).optional().default("") }), req.body);
    const df = decisionVisibleSql(u, "d");
    const d = db.get<{ id: string; title: string; status: string; project_id: string | null; created_by: string | null; context: string }>(`SELECT d.* FROM decisions d WHERE d.id = ? AND ${df.sql}`, req.params.id, ...df.params);
    if (!d) throw notFound("Decision not found.");
    if (!["proposed", "pending_approval"].includes(d.status)) throw conflict(`This decision is already "${humanize(d.status)}".`);
    if (b.outcome === "rejected" && !b.note.trim()) throw badRequest("Please explain why the decision is rejected.", { fields: { note: "A reason is required when rejecting." } });
    const now = nowIso();
    db.update("decisions", d.id, { status: b.outcome, decision_maker_id: u.id, decision_date: orgToday(db), updated_at: now });
    statusChange(db, u.id, "decision", d.id, "status", d.status, b.outcome, b.note);
    if (b.note.trim()) db.insert("comments", { id: newId("cmt"), entity_type: "decision", entity_id: d.id, author_id: u.id, body: b.note, kind: "review_feedback", created_at: now });
    activity(db, u, "decision.recorded", { type: "decision", id: d.id, label: d.title }, { projectId: d.project_id, detail: `Decision ${b.outcome}` });
    audit(db, req, `decision.${b.outcome}`, { type: "decision", id: d.id }, { from: d.status, note: b.note });
    notify(db, { userId: d.created_by, actorId: u.id, type: "decision_required", title: `Decision ${b.outcome}: ${d.title}`, body: b.note, link: d.project_id ? `/projects/${d.project_id}` : "/management/decisions" });
    res.json({ ok: true, status: b.outcome });
  }),
);

// Explicitly unavailable: per-person metrics (privacy by design, spec 26.5).
managementRouter.get(
  "/people",
  h(() => {
    throw forbidden("CSI Workspace does not produce per-person productivity metrics. Use project-level views instead.");
  }),
);
