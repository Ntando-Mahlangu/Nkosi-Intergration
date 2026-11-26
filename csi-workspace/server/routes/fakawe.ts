/**
 * Fakawe organisational reporting (spec §14).
 *
 * Reporting periods + a dashboard per period + draft generation. Generation only uses
 * authoritative records (approved meetings/call reports, completed work, recorded decisions,
 * posted project updates …) dated inside the period, visible to the generating user, and never
 * from restricted projects, confidential meetings, personal tasks or private learning records —
 * because a Fakawe digest is distributed more widely than its sources.
 *
 * The generated report is always a DRAFT. Review/approval/publishing happens through the
 * generic report workflow (/api/reports/:id/transition).
 */
import { Router } from "express";
import { z } from "zod";
import type { SQLInputValue } from "node:sqlite";
import type { Db } from "../db/index.js";
import { h, parse, parsePatch, badRequest, conflict, forbidden, notFound, zDate, zOptDate, zOptId, zTitle } from "../lib/http.js";
import { can, currentUser, type AuthUser } from "../lib/context.js";
import { addDays, newId, nowIso } from "../lib/ids.js";
import { activity, audit, getSetting, notify, orgToday } from "../lib/events.js";
import { decisionVisibleSql, meetingVisibleSql, opportunityVisibleSql, projectVisibleSql, reportVisibleSql } from "../lib/access.js";
import { draftFromFacts } from "../ai/service.js";

export const fakaweRouter = Router();

// ------------------------------------------------------------------ helpers
const canManage = (u: AuthUser) => can(u, "fakawe.manage");
const canSee = (u: AuthUser) => can(u, "fakawe.manage") || can(u, "fakawe.approve") || can(u, "management.view");

function requireSee(u: AuthUser) {
  if (!canSee(u)) throw forbidden("Reporting periods are available to reporting coordinators and management.");
}
function requireManage(u: AuthUser) {
  if (!canManage(u)) throw forbidden("Only reporting coordinators can manage Fakawe reporting.");
}

interface Period {
  id: string;
  name: string;
  frequency: string;
  start_date: string;
  end_date: string;
  submission_deadline: string | null;
  owner_id: string | null;
  approver_id: string | null;
  recipients: string;
  template_id: string | null;
  status: string;
  created_at: string;
}

function getPeriod(db: Db, id: string): Period {
  const p = db.get<Period>("SELECT * FROM reporting_periods WHERE id = ?", id);
  if (!p) throw notFound("Reporting period not found.");
  return p;
}

export function computeEndDate(frequency: string, start: string, end?: string | null): string {
  if (frequency === "weekly") return addDays(start, 6);
  if (frequency === "biweekly") return addDays(start, 13);
  if (frequency === "monthly") {
    const d = new Date(start + "T00:00:00Z");
    const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0));
    return last.toISOString().slice(0, 10);
  }
  if (!end) throw badRequest("Custom periods need an end date.", { fields: { end_date: "Choose an end date." } });
  return end;
}

/**
 * Projects eligible as Fakawe sources for this user: visible to them AND not restricted.
 * Returned as a SQL fragment `<col> IN (...)`.
 */
function scopeProjects(u: AuthUser, col: string) {
  const f = projectVisibleSql(u, "fp");
  return { sql: `${col} IN (SELECT fp.id FROM projects fp WHERE fp.visibility <> 'restricted' AND ${f.sql})`, params: f.params };
}
/** Meetings eligible as sources: visible, not confidential, not attached to a restricted project. */
function scopeMeetings(u: AuthUser, alias = "m") {
  const f = meetingVisibleSql(u, alias);
  return {
    sql: `(${f.sql} AND ${alias}.confidential = 0 AND (${alias}.project_id IS NULL OR ${alias}.project_id NOT IN (SELECT id FROM projects WHERE visibility = 'restricted')))`,
    params: f.params,
  };
}

const inPeriod = (col: string) => `substr(${col}, 1, 10) BETWEEN ? AND ?`;

interface Src {
  type: string;
  id: string;
  label: string;
}
interface Section {
  key: string;
  title: string;
  body?: string;
  items?: string[];
  sources?: Src[];
}

// ------------------------------------------------------------------ data collection
export interface Collected {
  updates: { id: string; project_id: string; project: string; summary: string; achievements: string; next_steps: string; blockers: string; created_at: string }[];
  meetings: { id: string; title: string; meeting_date: string; project: string | null }[];
  callReports: { id: string; title: string; status: string }[];
  completedTasks: { id: string; title: string; project: string; milestone_id: string | null; deliverable_id: string | null }[];
  milestones: { id: string; title: string; project: string; completed_date: string }[];
  deliverables: { id: string; name: string; project: string; status: string }[];
  decisionsMade: { id: string; title: string; project: string | null; status: string }[];
  decisionsRequired: { id: string; title: string; project: string | null; status: string; maker: string | null }[];
  statusChanges: { entity_id: string; project: string; from_value: string | null; to_value: string }[];
  risks: { id: string; title: string; type: string; severity: string; project: string; owner_id: string | null }[];
  upcoming: { id: string; title: string; project: string; date: string; kind: "milestone" | "deliverable" }[];
  outstanding: { id: string; title: string; project: string; due_date: string; assignee_id: string | null }[];
  outstandingTotal: number;
  opportunities: { id: string; name: string; stage: string; organisation: string; created_in_period: number }[];
  lessons: { id: string; title: string; kind: string }[];
  learning: { id: string; title: string; topic: string }[];
  missingUpdates: { id: string; name: string; owner_id: string | null; owner_name: string | null }[];
  conflictingHealth: { id: string; name: string }[];
  pendingMeetings: { id: string; title: string; meeting_date: string; status: string }[];
  unapprovedCallReports: { id: string; title: string; status: string }[];
}

export function collect(db: Db, u: AuthUser, start: string, end: string): Collected {
  const sp = (col: string) => scopeProjects(u, col);
  const P = (f: { params: SQLInputValue[] }) => f.params;

  const pu = sp("pu.project_id");
  const updates = db.all<Collected["updates"][number]>(
    `SELECT pu.id, pu.project_id, p.name AS project, pu.summary, pu.achievements, pu.next_steps, pu.blockers, pu.created_at
     FROM project_updates pu JOIN projects p ON p.id = pu.project_id
     WHERE ${inPeriod("pu.created_at")} AND ${pu.sql} ORDER BY p.name, pu.created_at`,
    start, end, ...P(pu),
  );

  const mf = scopeMeetings(u, "m");
  const meetings = db.all<Collected["meetings"][number]>(
    `SELECT m.id, m.title, m.meeting_date, p.name AS project FROM meetings m LEFT JOIN projects p ON p.id = m.project_id
     WHERE m.status = 'approved' AND m.meeting_date BETWEEN ? AND ? AND ${mf.sql} ORDER BY m.meeting_date`,
    start, end, ...P(mf),
  );
  const pendingMeetings = db.all<Collected["pendingMeetings"][number]>(
    `SELECT m.id, m.title, m.meeting_date, m.status FROM meetings m
     WHERE m.status IN ('notes_submitted','in_review') AND m.meeting_date BETWEEN ? AND ? AND ${mf.sql} ORDER BY m.meeting_date`,
    start, end, ...P(mf),
  );

  const rf = reportVisibleSql(u, "r");
  const mf2 = scopeMeetings(u, "rm");
  const callReportBase = `FROM reports r JOIN meetings rm ON rm.id = r.meeting_id
     WHERE r.report_type = 'call_report' AND rm.meeting_date BETWEEN ? AND ? AND ${rf.sql} AND ${mf2.sql}`;
  const callReports = db.all<Collected["callReports"][number]>(
    `SELECT r.id, r.title, r.status ${callReportBase} AND r.status IN ('approved','final','published') ORDER BY rm.meeting_date`,
    start, end, ...P(rf), ...P(mf2),
  );
  const unapprovedCallReports = db.all<Collected["unapprovedCallReports"][number]>(
    `SELECT r.id, r.title, r.status ${callReportBase} AND r.status IN ('draft','in_review','changes_requested') ORDER BY rm.meeting_date`,
    start, end, ...P(rf), ...P(mf2),
  );

  const ms = sp("ml.project_id");
  const milestones = db.all<Collected["milestones"][number]>(
    `SELECT ml.id, ml.title, p.name AS project, ml.completed_date FROM milestones ml JOIN projects p ON p.id = ml.project_id
     WHERE ml.status = 'achieved' AND ml.completed_date BETWEEN ? AND ? AND ${ms.sql} ORDER BY ml.completed_date`,
    start, end, ...P(ms),
  );

  // Deliverables approved in the period: prefer the status history timestamp, fall back to updated_at.
  const ds = sp("dv.project_id");
  const deliverables = db.all<Collected["deliverables"][number]>(
    `SELECT dv.id, dv.name, p.name AS project, dv.status FROM deliverables dv JOIN projects p ON p.id = dv.project_id
     WHERE dv.status IN ('approved','completed') AND ${ds.sql} AND (
       EXISTS (SELECT 1 FROM status_history sh WHERE sh.entity_type = 'deliverable' AND sh.entity_id = dv.id AND sh.to_value IN ('approved','completed') AND ${inPeriod("sh.changed_at")})
       OR (NOT EXISTS (SELECT 1 FROM status_history sh2 WHERE sh2.entity_type = 'deliverable' AND sh2.entity_id = dv.id AND sh2.to_value IN ('approved','completed')) AND ${inPeriod("dv.updated_at")})
     ) ORDER BY p.name`,
    ...P(ds), start, end, start, end,
  );

  const milestoneIds = new Set(milestones.map((m) => m.id));
  const deliverableIds = new Set(deliverables.map((d) => d.id));
  const ts = sp("t.project_id");
  const completedTasksRaw = db.all<Collected["completedTasks"][number]>(
    `SELECT t.id, t.title, p.name AS project, t.milestone_id, t.deliverable_id FROM tasks t JOIN projects p ON p.id = t.project_id
     WHERE t.status = 'completed' AND t.is_personal = 0 AND t.completed_at IS NOT NULL AND ${inPeriod("t.completed_at")} AND ${ts.sql}
     ORDER BY p.name, t.completed_at`,
    start, end, ...P(ts),
  );
  // Deduplicate: a task that is part of a milestone/deliverable reported as achieved is represented by that item.
  const completedTasks = completedTasksRaw.filter((t) => !(t.milestone_id && milestoneIds.has(t.milestone_id)) && !(t.deliverable_id && deliverableIds.has(t.deliverable_id)));

  const df = decisionVisibleSql(u, "d");
  const decScope = `(d.project_id IS NULL OR d.project_id NOT IN (SELECT id FROM projects WHERE visibility = 'restricted'))
     AND (d.meeting_id IS NULL OR d.meeting_id NOT IN (SELECT id FROM meetings WHERE confidential = 1))`;
  const decisionsMade = db.all<Collected["decisionsMade"][number]>(
    `SELECT d.id, d.title, p.name AS project, d.status FROM decisions d LEFT JOIN projects p ON p.id = d.project_id
     WHERE d.status IN ('made','approved') AND COALESCE(d.decision_date, substr(d.created_at,1,10)) BETWEEN ? AND ? AND ${df.sql} AND ${decScope}
     ORDER BY d.decision_date`,
    start, end, ...P(df),
  );
  const decisionsRequired = db.all<Collected["decisionsRequired"][number]>(
    `SELECT d.id, d.title, p.name AS project, d.status, um.name AS maker FROM decisions d LEFT JOIN projects p ON p.id = d.project_id LEFT JOIN users um ON um.id = d.decision_maker_id
     WHERE d.status IN ('proposed','pending_approval') AND substr(d.created_at,1,10) <= ? AND ${df.sql} AND ${decScope} ORDER BY d.created_at`,
    end, ...P(df),
  );

  const sh = sp("sh.entity_id");
  const statusChanges = db.all<Collected["statusChanges"][number]>(
    `SELECT sh.entity_id, p.name AS project, sh.from_value, sh.to_value FROM status_history sh JOIN projects p ON p.id = sh.entity_id
     WHERE sh.entity_type = 'project' AND sh.field = 'status' AND ${inPeriod("sh.changed_at")} AND ${sh.sql} ORDER BY sh.changed_at`,
    start, end, ...P(sh),
  );

  const rk = sp("rk.project_id");
  const risks = db.all<Collected["risks"][number]>(
    `SELECT rk.id, rk.title, rk.type, rk.severity, p.name AS project, rk.owner_id FROM risks rk JOIN projects p ON p.id = rk.project_id
     WHERE rk.status IN ('open','mitigating') AND (rk.type = 'blocker' OR rk.severity IN ('high','critical')) AND rk.identified_date <= ? AND ${rk.sql}
     ORDER BY CASE rk.severity WHEN 'critical' THEN 0 WHEN 'high' THEN 1 ELSE 2 END, p.name`,
    end, ...P(rk),
  );

  const horizon = addDays(end, 14);
  const um = sp("ml.project_id");
  const ud = sp("dv.project_id");
  const upcoming = [
    ...db.all<{ id: string; title: string; project: string; date: string }>(
      `SELECT ml.id, ml.title, p.name AS project, ml.target_date AS date FROM milestones ml JOIN projects p ON p.id = ml.project_id
       WHERE ml.status IN ('not_started','in_progress') AND ml.target_date > ? AND ml.target_date <= ? AND ${um.sql}`,
      end, horizon, ...P(um),
    ).map((r) => ({ ...r, kind: "milestone" as const })),
    ...db.all<{ id: string; title: string; project: string; date: string }>(
      `SELECT dv.id, dv.name AS title, p.name AS project, dv.due_date AS date FROM deliverables dv JOIN projects p ON p.id = dv.project_id
       WHERE dv.status NOT IN ('approved','completed','cancelled') AND dv.due_date > ? AND dv.due_date <= ? AND ${ud.sql}`,
      end, horizon, ...P(ud),
    ).map((r) => ({ ...r, kind: "deliverable" as const })),
  ].sort((a, b) => a.date.localeCompare(b.date));

  const ot = sp("t.project_id");
  const outstandingWhere = `t.status IN ('todo','in_progress','blocked','awaiting_review') AND t.is_personal = 0 AND t.due_date IS NOT NULL AND t.due_date <= ? AND substr(t.created_at,1,10) <= ? AND ${ot.sql}`;
  const outstandingTotal = db.get<{ n: number }>(`SELECT COUNT(*) n FROM tasks t WHERE ${outstandingWhere}`, end, end, ...P(ot))!.n;
  const outstanding = db.all<Collected["outstanding"][number]>(
    `SELECT t.id, t.title, p.name AS project, t.due_date, t.assignee_id FROM tasks t JOIN projects p ON p.id = t.project_id WHERE ${outstandingWhere} ORDER BY t.due_date LIMIT 15`,
    end, end, ...P(ot),
  );

  // Opportunities: never include confidential ones in a digest.
  const of = opportunityVisibleSql(u, "o");
  const opportunities = db.all<Collected["opportunities"][number]>(
    `SELECT o.id, o.name, o.stage, o.organisation, (${inPeriod("o.created_at")}) AS created_in_period FROM opportunities o
     WHERE o.confidential = 0 AND ${of.sql} AND (
       ${inPeriod("o.created_at")}
       OR EXISTS (SELECT 1 FROM status_history sh WHERE sh.entity_type = 'opportunity' AND sh.entity_id = o.id AND ${inPeriod("sh.changed_at")})
     ) ORDER BY o.stage, o.name`,
    start, end, ...P(of), start, end, start, end,
  );

  const lessons = db.all<Collected["lessons"][number]>(
    `SELECT k.id, k.title, k.item_type AS kind FROM knowledge_items k
     WHERE k.status = 'published' AND k.access_level = 'all_staff' AND k.item_type IN ('lesson','insight')
       AND COALESCE(k.published_date, substr(k.updated_at,1,10)) BETWEEN ? AND ? ORDER BY k.title`,
    start, end,
  );
  const learning = db.all<Collected["learning"][number]>(
    `SELECT l.id, l.title, l.topic FROM learning_records l WHERE l.visibility = 'shared' AND ${inPeriod("l.created_at")}
       AND (l.project_id IS NULL OR l.project_id NOT IN (SELECT id FROM projects WHERE visibility = 'restricted')) ORDER BY l.created_at`,
    start, end,
  );

  const ap = sp("p.id");
  const missingUpdates = db.all<Collected["missingUpdates"][number]>(
    `SELECT p.id, p.name, p.owner_id, uo.name AS owner_name FROM projects p LEFT JOIN users uo ON uo.id = p.owner_id
     WHERE p.status IN ('active','at_risk') AND ${ap.sql}
       AND NOT EXISTS (SELECT 1 FROM project_updates pu WHERE pu.project_id = p.id AND ${inPeriod("pu.created_at")}) ORDER BY p.name`,
    ...P(ap), start, end,
  );
  const conflictingHealth = db.all<Collected["conflictingHealth"][number]>(
    `SELECT p.id, p.name FROM projects p WHERE p.health = 'on_track' AND p.status NOT IN ('completed','cancelled') AND ${ap.sql}
       AND EXISTS (SELECT 1 FROM risks r WHERE r.project_id = p.id AND r.type = 'blocker' AND r.status IN ('open','mitigating'))`,
    ...P(ap),
  );

  return {
    updates, meetings, callReports, completedTasks, milestones, deliverables, decisionsMade, decisionsRequired, statusChanges, risks,
    upcoming, outstanding, outstandingTotal, opportunities, lessons, learning, missingUpdates, conflictingHealth, pendingMeetings, unapprovedCallReports,
  };
}

const humanize = (s: string) => s.replace(/_/g, " ");
const src = (type: string, id: string, label: string): Src => ({ type, id, label });

function qualityFlags(c: Collected): string[] {
  const flags: string[] = [];
  if (c.missingUpdates.length) flags.push(`Missing project updates for this period: ${c.missingUpdates.map((p) => `${p.name}${p.owner_name ? ` (${p.owner_name})` : ""}`).join(", ")}.`);
  for (const p of c.conflictingHealth) flags.push(`Conflicting information: ${p.name} is marked "on track" but has an open blocker in its risk register.`);
  if (c.pendingMeetings.length) flags.push(`${c.pendingMeetings.length} meeting(s) in this period are not yet approved and were not included: ${c.pendingMeetings.map((m) => m.title).join(", ")}.`);
  if (c.unapprovedCallReports.length) flags.push(`${c.unapprovedCallReports.length} call report(s) in this period are not yet approved and were not included.`);
  const ownerless = c.risks.filter((r) => !r.owner_id).length;
  if (ownerless) flags.push(`${ownerless} open high risk/blocker item(s) have no owner.`);
  const unassigned = c.outstanding.filter((t) => !t.assignee_id).length;
  if (unassigned) flags.push(`${unassigned} outstanding action(s) have no assignee.`);
  return flags;
}

export function sourceCount(c: Collected) {
  return {
    project_updates: c.updates.length,
    meetings: c.meetings.length,
    call_reports: c.callReports.length,
    completed_tasks: c.completedTasks.length,
    milestones_achieved: c.milestones.length,
    deliverables_approved: c.deliverables.length,
    decisions_made: c.decisionsMade.length,
    decisions_required: c.decisionsRequired.length,
    open_high_risks: c.risks.length,
    upcoming: c.upcoming.length,
    outstanding_actions: c.outstandingTotal,
    opportunities: c.opportunities.length,
    lessons: c.lessons.length + c.learning.length,
  };
}

/** Rough manual-effort estimate: ~3 min per source record collated by hand + 20 min drafting. */
export function minutesSaved(c: Collected): number {
  const n = Object.values(sourceCount(c)).reduce((a, b) => a + b, 0);
  return n ? 20 + n * 3 : 0;
}
export const MINUTES_SAVED_BASIS = "Estimate only: about 3 minutes to find and summarise each source record by hand, plus 20 minutes of drafting. Not measured time.";

function templateSummary(c: Collected, period: Period): string {
  const parts: string[] = [];
  parts.push(`This digest covers ${period.start_date} to ${period.end_date} and is compiled only from approved or recorded information in CSI Workspace.`);
  const done: string[] = [];
  if (c.milestones.length) done.push(`${c.milestones.length} milestone(s) achieved`);
  if (c.deliverables.length) done.push(`${c.deliverables.length} deliverable(s) approved`);
  if (c.completedTasks.length) done.push(`${c.completedTasks.length} further project action(s) completed`);
  if (c.meetings.length) done.push(`${c.meetings.length} approved meeting record(s)`);
  if (done.length) parts.push(`Recorded in the period: ${done.join(", ")}.`);
  if (c.updates.length) parts.push(`${new Set(c.updates.map((u) => u.project_id)).size} project(s) posted updates.`);
  if (c.decisionsMade.length) parts.push(`${c.decisionsMade.length} decision(s) were recorded.`);
  if (c.risks.length) parts.push(`${c.risks.length} high-severity risk or blocker item(s) remain open.`);
  if (c.decisionsRequired.length) parts.push(`${c.decisionsRequired.length} decision(s) are awaiting a decision or approval.`);
  if (c.missingUpdates.length) parts.push(`No update was received for ${c.missingUpdates.length} active project(s) — see the quality notes.`);
  if (parts.length === 1) parts.push("No qualifying activity was recorded for this period.");
  return parts.join(" ");
}

function factsForAI(c: Collected, period: Period): string {
  const lines: string[] = [`Period: ${period.start_date} to ${period.end_date}`];
  for (const u of c.updates) lines.push(`Project update (${u.project}): ${u.summary}${u.achievements ? ` Achievements: ${u.achievements}` : ""}${u.blockers ? ` Blockers: ${u.blockers}` : ""}`);
  for (const m of c.milestones) lines.push(`Milestone achieved (${m.project}): ${m.title}`);
  for (const d of c.deliverables) lines.push(`Deliverable approved (${d.project}): ${d.name}`);
  for (const t of c.completedTasks) lines.push(`Action completed (${t.project}): ${t.title}`);
  for (const d of c.decisionsMade) lines.push(`Decision recorded${d.project ? ` (${d.project})` : ""}: ${d.title}`);
  for (const d of c.decisionsRequired) lines.push(`Decision still pending (${humanize(d.status)})${d.project ? ` (${d.project})` : ""}: ${d.title}`);
  for (const r of c.risks) lines.push(`Open ${r.type} (${r.severity}, ${r.project}): ${r.title}`);
  for (const p of c.missingUpdates) lines.push(`No update received this period: ${p.name}`);
  return lines.join("\n");
}

export async function buildSections(db: Db, ctxUserId: string, ai: (facts: string) => Promise<{ engine: string; text: string } | null>, period: Period, c: Collected) {
  const sections: Section[] = [];

  // Executive overview
  const aiDraft = await ai(factsForAI(c, period));
  sections.push({
    key: "executive_overview",
    title: "Executive overview",
    body: aiDraft ? aiDraft.text : templateSummary(c, period),
    sources: [],
  });

  // Major developments: decisions made + project status changes
  {
    const items: string[] = [];
    const sources: Src[] = [];
    for (const d of c.decisionsMade) {
      items.push(`Decision ${d.status === "approved" ? "approved" : "recorded"}: ${d.title}${d.project ? ` (${d.project})` : ""}`);
      sources.push(src("decision", d.id, d.title));
    }
    for (const s of c.statusChanges) {
      items.push(`${s.project} moved from ${humanize(s.from_value ?? "—")} to ${humanize(s.to_value)}`);
      sources.push(src("project", s.entity_id, s.project));
    }
    if (items.length) sections.push({ key: "developments", title: "Major organisational developments", items, sources });
  }

  if (c.updates.length) {
    sections.push({
      key: "project_updates",
      title: "Project and programme updates",
      items: c.updates.map((u) => `${u.project}: ${u.summary}${u.next_steps ? ` Next: ${u.next_steps}` : ""}${u.blockers ? ` Blockers: ${u.blockers}` : ""}`),
      sources: c.updates.map((u) => src("project", u.project_id, `${u.project} update (${u.created_at.slice(0, 10)})`)),
    });
  }

  {
    const items: string[] = [];
    const sources: Src[] = [];
    for (const t of c.completedTasks) {
      items.push(`${t.title} (${t.project})`);
      sources.push(src("task", t.id, t.title));
    }
    for (const m of c.meetings) {
      items.push(`Meeting held and record approved: ${m.title}${m.project ? ` (${m.project})` : ""}, ${m.meeting_date}`);
      sources.push(src("meeting", m.id, m.title));
    }
    if (items.length) sections.push({ key: "completed", title: "Completed activities", items, sources });
  }

  if (c.milestones.length || c.deliverables.length) {
    sections.push({
      key: "milestones",
      title: "Milestones and deliverables achieved",
      items: [...c.milestones.map((m) => `Milestone achieved: ${m.title} (${m.project}) on ${m.completed_date}`), ...c.deliverables.map((d) => `Deliverable ${d.status}: ${d.name} (${d.project})`)],
      sources: [...c.milestones.map((m) => src("milestone", m.id, m.title)), ...c.deliverables.map((d) => src("deliverable", d.id, d.name))],
    });
  }

  if (c.outstandingTotal) {
    sections.push({
      key: "outstanding",
      title: "Outstanding actions",
      body: `${c.outstandingTotal} project action(s) were due by ${period.end_date} and are not yet complete${c.outstandingTotal > c.outstanding.length ? ` (showing the ${c.outstanding.length} oldest)` : ""}.`,
      items: c.outstanding.map((t) => `${t.title} (${t.project}) — due ${t.due_date}${t.assignee_id ? "" : " — no assignee"}`),
      sources: c.outstanding.map((t) => src("task", t.id, t.title)),
    });
  }

  if (c.risks.length) {
    sections.push({
      key: "risks",
      title: "Risks and blockers",
      items: c.risks.map((r) => `${r.project} — ${r.type === "blocker" ? "Blocker" : r.type === "issue" ? "Issue" : "Risk"} (${r.severity}): ${r.title}${r.owner_id ? "" : " — no owner"}`),
      sources: c.risks.map((r) => src("risk", r.id, r.title)),
    });
  }

  if (c.upcoming.length) {
    sections.push({
      key: "upcoming",
      title: "Upcoming priorities",
      items: c.upcoming.map((x) => `${x.kind === "milestone" ? "Milestone" : "Deliverable due"}: ${x.title} (${x.project}) — ${x.date}`),
      sources: c.upcoming.map((x) => src(x.kind, x.id, x.title)),
    });
  }

  if (c.decisionsRequired.length) {
    sections.push({
      key: "decisions_required",
      title: "Decisions required",
      body: "These are proposals or pending approvals — not decisions that have been made.",
      items: c.decisionsRequired.map((d) => `${d.title}${d.project ? ` (${d.project})` : ""} — ${humanize(d.status)}${d.maker ? `, decision maker: ${d.maker}` : ""}`),
      sources: c.decisionsRequired.map((d) => src("decision", d.id, d.title)),
    });
  }

  if (c.opportunities.length) {
    sections.push({
      key: "opportunities",
      title: "Partnerships and opportunities",
      items: c.opportunities.map((o) => `${o.name}${o.organisation ? ` (${o.organisation})` : ""} — ${o.created_in_period ? "newly identified, " : ""}stage: ${humanize(o.stage)}`),
      sources: c.opportunities.map((o) => src("opportunity", o.id, o.name)),
    });
  }

  if (c.lessons.length || c.learning.length) {
    sections.push({
      key: "lessons",
      title: "Lessons and insights",
      items: [...c.lessons.map((k) => `${k.kind === "lesson" ? "Lesson" : "Insight"} published: ${k.title}`), ...c.learning.map((l) => `Learning shared: ${l.title}${l.topic ? ` (${l.topic})` : ""}`)],
      sources: [...c.lessons.map((k) => src("knowledge", k.id, k.title)), ...c.learning.map((l) => src("learning", l.id, l.title))],
    });
  }

  if (c.callReports.length) {
    sections.push({
      key: "references",
      title: "Supporting references",
      items: c.callReports.map((r) => `Call report: ${r.title}`),
      sources: c.callReports.map((r) => src("report", r.id, r.title)),
    });
  }

  // Apply template: order + enabled flags.
  const tpl = db.get<{ sections: string }>(
    "SELECT sections FROM report_templates WHERE id = COALESCE(?, (SELECT id FROM report_templates WHERE report_type = 'fakawe' AND is_default = 1 AND active = 1 LIMIT 1))",
    period.template_id,
  );
  let ordered = sections;
  if (tpl) {
    try {
      const defs = JSON.parse(tpl.sections) as { key: string; title: string; enabled: boolean }[];
      const byKey = new Map(sections.map((s) => [s.key, s]));
      ordered = [];
      for (const d of defs) {
        const s = byKey.get(d.key);
        if (s && d.enabled !== false) ordered.push({ ...s, title: d.title || s.title });
        byKey.delete(d.key);
      }
      // Sections the template does not mention are kept at the end (never silently dropped).
      for (const s of byKey.values()) ordered.push(s);
    } catch {
      /* malformed template → default order */
    }
  }
  return { sections: ordered, engine: aiDraft ? aiDraft.engine : "rules", userId: ctxUserId };
}

function allSources(sections: Section[]): Src[] {
  const seen = new Set<string>();
  const out: Src[] = [];
  for (const s of sections)
    for (const x of s.sources ?? []) {
      const k = `${x.type}:${x.id}`;
      if (!seen.has(k)) {
        seen.add(k);
        out.push(x);
      }
    }
  return out;
}

function periodReport(db: Db, periodId: string) {
  return db.get<{ id: string; status: string; title: string; version: number; content: string; generated_by: string; updated_at: string; quality_flags: string; minutes_saved_estimate: number | null; approved_at: string | null }>(
    "SELECT id, status, title, version, content, generated_by, updated_at, quality_flags, minutes_saved_estimate, approved_at FROM reports WHERE report_type = 'fakawe' AND period_id = ? ORDER BY created_at DESC LIMIT 1",
    periodId,
  );
}

// ------------------------------------------------------------------ routes
fakaweRouter.get(
  "/",
  h((req, res) => {
    const u = currentUser(req);
    requireSee(u);
    const db = req.ctx.db;
    const rows = db.all<Record<string, unknown>>(
      `SELECT rp.*, uo.name AS owner_name, ua.name AS approver_name,
         (SELECT r.id FROM reports r WHERE r.report_type = 'fakawe' AND r.period_id = rp.id ORDER BY r.created_at DESC LIMIT 1) AS report_id,
         (SELECT r.status FROM reports r WHERE r.report_type = 'fakawe' AND r.period_id = rp.id ORDER BY r.created_at DESC LIMIT 1) AS report_status
       FROM reporting_periods rp LEFT JOIN users uo ON uo.id = rp.owner_id LEFT JOIN users ua ON ua.id = rp.approver_id
       ORDER BY rp.start_date DESC`,
    );
    res.json({ items: rows.map((r) => ({ ...r, recipients: safeJson(String(r.recipients ?? "[]"), []) })), today: orgToday(db) });
  }),
);

const PeriodBody = z.object({
  name: z.string().trim().max(200).optional().default(""),
  frequency: z.enum(["weekly", "biweekly", "monthly", "custom"]),
  start_date: zDate,
  end_date: zOptDate,
  submission_deadline: zOptDate,
  owner_id: zOptId,
  approver_id: zOptId,
  recipients: z.array(z.string().min(3).max(64)).max(100).optional().default([]),
  template_id: zOptId,
});

function validateUsers(db: Db, ids: (string | null | undefined)[]) {
  for (const id of ids) if (id && !db.get("SELECT 1 FROM users WHERE id = ? AND active = 1", id)) throw badRequest("One of the selected people is not an active user.");
}

fakaweRouter.post(
  "/",
  h((req, res) => {
    const u = currentUser(req);
    requireManage(u);
    const db = req.ctx.db;
    const b = parse(PeriodBody, req.body);
    const end = computeEndDate(b.frequency, b.start_date, b.end_date);
    if (end < b.start_date) throw badRequest("The end date must be on or after the start date.", { fields: { end_date: "Must be on or after the start date." } });
    if (b.submission_deadline && b.submission_deadline < b.start_date) throw badRequest("The deadline must be within or after the period.", { fields: { submission_deadline: "Must be on or after the start date." } });
    validateUsers(db, [b.owner_id, b.approver_id, ...b.recipients]);
    if (b.template_id && !db.get("SELECT 1 FROM report_templates WHERE id = ? AND report_type = 'fakawe'", b.template_id)) throw badRequest("Unknown Fakawe template.");
    const overlap = db.get<{ name: string }>("SELECT name FROM reporting_periods WHERE status <> 'archived' AND start_date = ? AND end_date = ?", b.start_date, end);
    if (overlap) throw conflict(`A reporting period with the same dates already exists (${overlap.name}).`);
    const id = newId("per");
    db.insert("reporting_periods", {
      id,
      name: b.name || `Fakawe — ${b.frequency === "monthly" ? b.start_date.slice(0, 7) : `${b.start_date} to ${end}`}`,
      frequency: b.frequency,
      start_date: b.start_date,
      end_date: end,
      submission_deadline: b.submission_deadline ?? end,
      owner_id: b.owner_id ?? u.id,
      approver_id: b.approver_id,
      recipients: JSON.stringify(b.recipients),
      template_id: b.template_id,
      status: "open",
      created_at: nowIso(),
    });
    audit(db, req, "fakawe.period_create", { type: "reporting_period", id }, { start: b.start_date, end });
    res.status(201).json(getPeriod(db, id));
  }),
);

fakaweRouter.patch(
  "/:id",
  h((req, res) => {
    const u = currentUser(req);
    requireManage(u);
    const db = req.ctx.db;
    const p = getPeriod(db, req.params.id);
    if (p.status === "archived") throw conflict("Archived periods cannot be edited.");
    const b = parsePatch(PeriodBody.partial().extend({ name: zTitle.optional() }), req.body);
    const freq = b.frequency ?? p.frequency;
    const start = b.start_date ?? p.start_date;
    const end = b.frequency || b.start_date || b.end_date ? computeEndDate(freq, start, b.end_date ?? p.end_date) : p.end_date;
    if (end < start) throw badRequest("The end date must be on or after the start date.", { fields: { end_date: "Must be on or after the start date." } });
    validateUsers(db, [b.owner_id, b.approver_id, ...(b.recipients ?? [])]);
    db.update("reporting_periods", p.id, {
      name: b.name,
      frequency: b.frequency,
      start_date: b.start_date,
      end_date: end,
      submission_deadline: b.submission_deadline === undefined ? undefined : b.submission_deadline,
      owner_id: b.owner_id === undefined ? undefined : b.owner_id,
      approver_id: b.approver_id === undefined ? undefined : b.approver_id,
      recipients: b.recipients ? JSON.stringify(b.recipients) : undefined,
      template_id: b.template_id === undefined ? undefined : b.template_id,
    });
    audit(db, req, "fakawe.period_update", { type: "reporting_period", id: p.id }, { fields: Object.keys(req.body ?? {}) });
    res.json(getPeriod(db, p.id));
  }),
);

fakaweRouter.post(
  "/:id/archive",
  h((req, res) => {
    const u = currentUser(req);
    requireManage(u);
    const db = req.ctx.db;
    const p = getPeriod(db, req.params.id);
    db.update("reporting_periods", p.id, { status: "archived" });
    audit(db, req, "fakawe.period_archive", { type: "reporting_period", id: p.id });
    res.json(getPeriod(db, p.id));
  }),
);

fakaweRouter.get(
  "/:id/dashboard",
  h((req, res) => {
    const u = currentUser(req);
    requireSee(u);
    const db = req.ctx.db;
    const p = getPeriod(db, req.params.id);
    const c = collect(db, u, p.start_date, p.end_date);
    const report = periodReport(db, p.id);
    const rf = reportVisibleSql(u, "r");
    const previous = db.all(
      `SELECT r.id, r.title, r.status, r.approved_at, r.created_at, rp.start_date, rp.end_date FROM reports r LEFT JOIN reporting_periods rp ON rp.id = r.period_id
       WHERE r.report_type = 'fakawe' AND r.id <> ? AND r.status IN ('approved','final','published','archived') AND ${rf.sql}
       ORDER BY COALESCE(rp.end_date, r.created_at) DESC LIMIT 10`,
      report?.id ?? "",
      ...rf.params,
    );
    const owner = p.owner_id ? db.get<{ name: string }>("SELECT name FROM users WHERE id = ?", p.owner_id)?.name : null;
    const approver = p.approver_id ? db.get<{ name: string }>("SELECT name FROM users WHERE id = ?", p.approver_id)?.name : null;
    const today = orgToday(db);
    res.json({
      period: { ...p, recipients: safeJson(p.recipients, []), owner_name: owner, approver_name: approver },
      today,
      deadline_days: p.submission_deadline ? Math.round((Date.parse(p.submission_deadline) - Date.parse(today)) / 86400000) : null,
      report: report
        ? { id: report.id, status: report.status, title: report.title, version: report.version, generated_by: report.generated_by, updated_at: report.updated_at, quality_flags: safeJson(report.quality_flags, []), minutes_saved_estimate: report.minutes_saved_estimate, approved_at: report.approved_at }
        : null,
      source_counts: sourceCount(c),
      missing_updates: c.missingUpdates,
      review_items: [
        ...c.pendingMeetings.map((m) => ({ type: "meeting", id: m.id, title: m.title, reason: `Meeting on ${m.meeting_date} is ${humanize(m.status)} — approve it to include it.` })),
        ...c.unapprovedCallReports.map((r) => ({ type: "report", id: r.id, title: r.title, reason: `Call report is ${humanize(r.status)} — approve it to include it.` })),
        ...c.conflictingHealth.map((x) => ({ type: "project", id: x.id, title: x.name, reason: "Marked on track while a blocker is open." })),
      ],
      previous,
      estimated_minutes_saved: minutesSaved(c),
      minutes_saved_basis: MINUTES_SAVED_BASIS,
      can_manage: canManage(u),
      can_approve: can(u, "fakawe.approve"),
    });
  }),
);

fakaweRouter.post(
  "/:id/generate",
  h(async (req, res) => {
    const u = currentUser(req);
    requireManage(u);
    const db = req.ctx.db;
    const p = getPeriod(db, req.params.id);
    if (p.status === "archived") throw conflict("This period is archived.");
    const existing = periodReport(db, p.id);
    if (existing && existing.status !== "draft") {
      throw conflict(`The Fakawe report for this period is "${humanize(existing.status)}". Return it to draft before regenerating.`);
    }
    const c = collect(db, u, p.start_date, p.end_date);
    const built = await buildSections(
      db,
      u.id,
      (facts) =>
        draftFromFacts(
          req.ctx,
          u.id,
          "fakawe_overview",
          "Write a 4–6 sentence executive overview of this reporting period for CSI management. Separate completed work from planned work and pending decisions. Mention notable risks and any missing updates.",
          facts,
        ),
      p,
      c,
    );
    let sections = built.sections;
    // Preserve human-added observations across regenerations.
    if (existing) {
      const old = safeJson<{ sections?: Section[] }>(existing.content, {});
      const human = (old.sections ?? []).find((s) => s.key === "human_observations");
      if (human) sections = [...sections, human];
    }
    const content = JSON.stringify({ sections });
    const flags = qualityFlags(c);
    const sources = allSources(sections);
    const now = nowIso();
    const mins = minutesSaved(c);
    let reportId: string;
    let version: number;
    if (existing) {
      reportId = existing.id;
      version = existing.version + 1;
      db.update("reports", reportId, {
        content,
        generated_by: built.engine,
        source_records: JSON.stringify(sources),
        quality_flags: JSON.stringify(flags),
        minutes_saved_estimate: mins,
        version,
        updated_at: now,
      });
    } else {
      reportId = newId("rep");
      version = 1;
      db.insert("reports", {
        id: reportId,
        report_type: "fakawe",
        title: `Fakawe digest — ${p.start_date} to ${p.end_date}`,
        period_id: p.id,
        template_id: p.template_id,
        content,
        status: "draft",
        audience: getSetting(db, "fakawe.default_audience", "management"),
        version: 1,
        generated_by: built.engine,
        author_id: u.id,
        reviewer_id: p.approver_id,
        source_records: JSON.stringify(sources),
        quality_flags: JSON.stringify(flags),
        minutes_saved_estimate: mins,
        created_at: now,
        updated_at: now,
      });
    }
    db.insert("report_versions", { id: newId("rpv"), report_id: reportId, version, content, status: "draft", changed_by: u.id, change_note: existing ? "Regenerated from source records" : "Generated from source records", created_at: now });
    if (p.status === "open") db.update("reporting_periods", p.id, { status: "drafting" });
    activity(db, u, "report.generated", { type: "report", id: reportId, label: `Fakawe digest — ${p.start_date} to ${p.end_date}` }, { detail: `${sources.length} source records` });
    audit(db, req, "fakawe.generate", { type: "report", id: reportId }, { period: p.id, sources: sources.length, engine: built.engine });
    notify(db, {
      userId: p.approver_id,
      actorId: u.id,
      type: "fakawe_draft",
      title: `Fakawe draft ${existing ? "regenerated" : "generated"} for ${p.start_date} to ${p.end_date}`,
      body: flags.length ? `${flags.length} quality note(s) need attention.` : "",
      entity: { type: "report", id: reportId },
    });
    res.status(existing ? 200 : 201).json({ report_id: reportId, version, generated_by: built.engine, quality_flags: flags, source_count: sources.length, sections: sections.length });
  }),
);

function safeJson<T>(s: string | null | undefined, fallback: T): T {
  try {
    return s ? (JSON.parse(s) as T) : fallback;
  } catch {
    return fallback;
  }
}
