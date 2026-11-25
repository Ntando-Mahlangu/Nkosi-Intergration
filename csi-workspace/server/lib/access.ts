/**
 * Record-level access control. Two forms of every rule:
 *   - `xxxVisibleSql(user, alias)` → a SQL boolean fragment + params, used in list/search/report/export
 *     queries so restricted rows are never loaded for unauthorised users;
 *   - `canViewXxx(db, user, id)` / `canManageXxx` → single-record checks for detail/update routes.
 * Keep both forms in sync — tests/access.test.ts exercises them together.
 *
 * Privacy principles (see SECURITY.md):
 *   - Personal tasks are visible only to their assignee/creator — never to management or admins.
 *   - Confidential meetings are visible only to participants/organiser/creator.
 *   - Restricted projects are visible only to their members/owner — no role bypass.
 *   - Private learning records are visible only to their contributor.
 */
import type { SQLInputValue } from "node:sqlite";
import type { Db } from "../db/index.js";
import { can, type AuthUser } from "./context.js";
import { forbidden, notFound } from "./http.js";

export interface SqlFrag {
  sql: string;
  params: SQLInputValue[];
}

// ------------------------------------------------------------------ projects
export function projectVisibleSql(u: AuthUser, p = "p"): SqlFrag {
  return {
    sql: `(${p}.visibility = 'organisation' OR ${p}.owner_id = ? OR EXISTS (SELECT 1 FROM project_members pmv WHERE pmv.project_id = ${p}.id AND pmv.user_id = ?) OR (${p}.visibility = 'team' AND (? = 1 OR (${p}.team_id IS NOT NULL AND ${p}.team_id = ?))))`,
    params: [u.id, u.id, can(u, "project.view_all") ? 1 : 0, u.team_id ?? ""],
  };
}

/** SQL: `<col> IN (visible project ids)` */
export function projectIdVisibleSql(u: AuthUser, col: string): SqlFrag {
  const f = projectVisibleSql(u, "pv");
  return { sql: `${col} IN (SELECT pv.id FROM projects pv WHERE ${f.sql})`, params: f.params };
}

export function canViewProject(db: Db, u: AuthUser, projectId: string): boolean {
  const f = projectVisibleSql(u, "p");
  return !!db.get(`SELECT 1 FROM projects p WHERE p.id = ? AND ${f.sql}`, projectId, ...f.params);
}

export function projectRole(db: Db, u: AuthUser, projectId: string): string | null {
  const p = db.get<{ owner_id: string | null }>("SELECT owner_id FROM projects WHERE id = ?", projectId);
  if (!p) return null;
  if (p.owner_id === u.id) return "owner";
  return db.get<{ role: string }>("SELECT role FROM project_members WHERE project_id = ? AND user_id = ?", projectId, u.id)?.role ?? null;
}

export function canManageProject(db: Db, u: AuthUser, projectId: string): boolean {
  const role = projectRole(db, u, projectId);
  if (role === "owner" || role === "manager") return true;
  return can(u, "project.manage_any") && canViewProject(db, u, projectId);
}

export function canContributeProject(db: Db, u: AuthUser, projectId: string): boolean {
  const role = projectRole(db, u, projectId);
  return !!role && role !== "viewer" ? true : canManageProject(db, u, projectId);
}

export function assertProjectView(db: Db, u: AuthUser, projectId: string) {
  if (!db.get("SELECT 1 FROM projects WHERE id = ?", projectId)) throw notFound("Project not found.");
  if (!canViewProject(db, u, projectId)) throw notFound("Project not found.");
}
export function assertProjectManage(db: Db, u: AuthUser, projectId: string) {
  assertProjectView(db, u, projectId);
  if (!canManageProject(db, u, projectId)) throw forbidden("Only the project owner or a project manager can do that.");
}

// ------------------------------------------------------------------ tasks
export function taskVisibleSql(u: AuthUser, t = "t"): SqlFrag {
  const pf = projectIdVisibleSql(u, `${t}.project_id`);
  const mf = meetingIdVisibleSql(u, `${t}.meeting_id`);
  return {
    sql: `(${t}.assignee_id = ? OR ${t}.creator_id = ? OR ${t}.reviewer_id = ? OR EXISTS (SELECT 1 FROM task_collaborators tc WHERE tc.task_id = ${t}.id AND tc.user_id = ?)
      OR (${t}.is_personal = 0 AND ${t}.project_id IS NOT NULL AND ${pf.sql})
      OR (${t}.is_personal = 0 AND ${t}.project_id IS NULL AND ${t}.meeting_id IS NOT NULL AND ${mf.sql}))`,
    params: [u.id, u.id, u.id, u.id, ...pf.params, ...mf.params],
  };
}

export function canViewTask(db: Db, u: AuthUser, taskId: string): boolean {
  const f = taskVisibleSql(u, "t");
  return !!db.get(`SELECT 1 FROM tasks t WHERE t.id = ? AND ${f.sql}`, taskId, ...f.params);
}

interface TaskRow {
  assignee_id: string | null;
  creator_id: string | null;
  reviewer_id: string | null;
  project_id: string | null;
}
/** Full edit (title, assignee, due date...): creator, or project manager of the task's project. */
export function canManageTask(db: Db, u: AuthUser, t: TaskRow): boolean {
  if (t.creator_id === u.id) return true;
  if (t.project_id && canManageProject(db, u, t.project_id)) return true;
  return false;
}
/** Status/progress updates: assignee, collaborators, plus managers. */
export function canWorkTask(db: Db, u: AuthUser, t: TaskRow & { id: string }): boolean {
  if (t.assignee_id === u.id || canManageTask(db, u, t)) return true;
  return !!db.get("SELECT 1 FROM task_collaborators WHERE task_id = ? AND user_id = ?", t.id, u.id);
}

/** Who may be assigned a task by `u` in project `projectId`. */
export function canAssignTo(db: Db, u: AuthUser, assigneeId: string, projectId: string | null): boolean {
  if (assigneeId === u.id) return true;
  if (can(u, "task.assign_any")) return true;
  if (projectId && canManageProject(db, u, projectId)) return true;
  return false;
}

// ------------------------------------------------------------------ meetings
export function meetingVisibleSql(u: AuthUser, m = "m"): SqlFrag {
  const pf = projectIdVisibleSql(u, `${m}.project_id`);
  return {
    sql: `(${m}.organiser_id = ? OR ${m}.created_by = ? OR EXISTS (SELECT 1 FROM meeting_participants mp WHERE mp.meeting_id = ${m}.id AND mp.user_id = ?)
      OR (${m}.confidential = 0 AND ${m}.project_id IS NOT NULL AND ${pf.sql}))`,
    params: [u.id, u.id, u.id, ...pf.params],
  };
}
export function meetingIdVisibleSql(u: AuthUser, col: string): SqlFrag {
  const f = meetingVisibleSql(u, "mv");
  return { sql: `${col} IN (SELECT mv.id FROM meetings mv WHERE ${f.sql})`, params: f.params };
}
export function canViewMeeting(db: Db, u: AuthUser, meetingId: string): boolean {
  const f = meetingVisibleSql(u, "m");
  return !!db.get(`SELECT 1 FROM meetings m WHERE m.id = ? AND ${f.sql}`, meetingId, ...f.params);
}
/** Meeting owner = organiser or creator; project managers of the linked project may also manage. */
export function canManageMeeting(db: Db, u: AuthUser, meetingId: string): boolean {
  const m = db.get<{ organiser_id: string | null; created_by: string | null; project_id: string | null }>(
    "SELECT organiser_id, created_by, project_id FROM meetings WHERE id = ?",
    meetingId,
  );
  if (!m) return false;
  if (m.organiser_id === u.id || m.created_by === u.id) return true;
  return !!m.project_id && canManageProject(db, u, m.project_id);
}
export function assertMeetingView(db: Db, u: AuthUser, id: string) {
  if (!canViewMeeting(db, u, id)) throw notFound("Meeting not found.");
}
export function assertMeetingManage(db: Db, u: AuthUser, id: string) {
  assertMeetingView(db, u, id);
  if (!canManageMeeting(db, u, id)) throw forbidden("Only the meeting organiser or project manager can do that.");
}

// ------------------------------------------------------------------ knowledge
export function knowledgeVisibleSql(u: AuthUser, k = "k"): SqlFrag {
  // access_level 'project' means project MEMBERS (and owner) only — not everyone who can see the project.
  const pf: SqlFrag = {
    sql: `(EXISTS (SELECT 1 FROM project_members kpm WHERE kpm.project_id = ${k}.project_id AND kpm.user_id = ?) OR EXISTS (SELECT 1 FROM projects kp WHERE kp.id = ${k}.project_id AND kp.owner_id = ?))`,
    params: [u.id, u.id],
  };
  const manager = can(u, "knowledge.manage") ? 1 : 0;
  return {
    sql: `(${k}.author_id = ? OR ${k}.owner_id = ? OR (
      (${k}.status = 'published' OR (? = 1 AND ${k}.status <> 'draft'))
      AND (
        ${k}.access_level = 'all_staff'
        OR (${k}.access_level = 'project' AND ${k}.project_id IS NOT NULL AND ${pf.sql})
        OR (${k}.access_level = 'management' AND ? = 1)
        OR (${k}.access_level = 'restricted' AND EXISTS (SELECT 1 FROM knowledge_access ka WHERE ka.knowledge_id = ${k}.id AND ka.user_id = ?))
      )))`,
    params: [u.id, u.id, manager, ...pf.params, can(u, "management.view") ? 1 : 0, u.id],
  };
}
export function canViewKnowledge(db: Db, u: AuthUser, id: string): boolean {
  const f = knowledgeVisibleSql(u, "k");
  return !!db.get(`SELECT 1 FROM knowledge_items k WHERE k.id = ? AND ${f.sql}`, id, ...f.params);
}

// ------------------------------------------------------------------ reports
export function reportVisibleSql(u: AuthUser, r = "r"): SqlFrag {
  const mf = meetingIdVisibleSql(u, `${r}.meeting_id`);
  const pf = projectIdVisibleSql(u, `${r}.project_id`);
  const mgmt = can(u, "management.view") ? 1 : 0;
  const fakaweMgr = can(u, "fakawe.manage") || can(u, "fakawe.approve") ? 1 : 0;
  return {
    sql: `(${r}.author_id = ? OR ${r}.reviewer_id = ? OR
      (${r}.report_type = 'call_report' AND ${r}.meeting_id IS NOT NULL AND ${mf.sql}) OR
      (${r}.report_type = 'project_report' AND ${r}.project_id IS NOT NULL AND ${pf.sql}) OR
      (${r}.report_type = 'fakawe' AND (? = 1 OR ? = 1 OR (${r}.status IN ('final','published','archived') AND ${r}.audience = 'all_staff'))))`,
    params: [u.id, u.id, ...mf.params, ...pf.params, mgmt, fakaweMgr],
  };
}
export function canViewReport(db: Db, u: AuthUser, id: string): boolean {
  const f = reportVisibleSql(u, "r");
  return !!db.get(`SELECT 1 FROM reports r WHERE r.id = ? AND ${f.sql}`, id, ...f.params);
}

// ------------------------------------------------------------------ opportunities
export function opportunityVisibleSql(u: AuthUser, o = "o"): SqlFrag {
  const all = can(u, "opportunity.view_all") || can(u, "management.view") ? 1 : 0;
  return {
    sql: `(${o}.owner_id = ? OR ${o}.created_by = ? OR (? = 1 AND (${o}.confidential = 0 OR ? = 1)))`,
    params: [u.id, u.id, all, can(u, "management.view") ? 1 : 0],
  };
}
export function canViewOpportunity(db: Db, u: AuthUser, id: string): boolean {
  const f = opportunityVisibleSql(u, "o");
  return !!db.get(`SELECT 1 FROM opportunities o WHERE o.id = ? AND ${f.sql}`, id, ...f.params);
}

// ------------------------------------------------------------------ learning
export function learningVisibleSql(u: AuthUser, l = "l"): SqlFrag {
  return { sql: `(${l}.contributor_id = ? OR ${l}.visibility = 'shared')`, params: [u.id] };
}

// ------------------------------------------------------------------ decisions & risks (inherit from project/meeting)
export function decisionVisibleSql(u: AuthUser, d = "d"): SqlFrag {
  const pf = projectIdVisibleSql(u, `${d}.project_id`);
  const mf = meetingIdVisibleSql(u, `${d}.meeting_id`);
  return {
    sql: `(${d}.created_by = ? OR ${d}.decision_maker_id = ? OR (${d}.project_id IS NOT NULL AND ${pf.sql}) OR (${d}.project_id IS NULL AND ${d}.meeting_id IS NOT NULL AND ${mf.sql}) OR (${d}.project_id IS NULL AND ${d}.meeting_id IS NULL AND ? = 1))`,
    params: [u.id, u.id, ...pf.params, ...mf.params, can(u, "management.view") ? 1 : 0],
  };
}

/** Generic view check used by search, links and notifications. */
export function canViewEntity(db: Db, u: AuthUser, type: string, id: string): boolean {
  switch (type) {
    case "project":
      return canViewProject(db, u, id);
    case "task":
      return canViewTask(db, u, id);
    case "meeting":
      return canViewMeeting(db, u, id);
    case "knowledge":
      return canViewKnowledge(db, u, id);
    case "report":
      return canViewReport(db, u, id);
    case "opportunity":
      return canViewOpportunity(db, u, id);
    case "milestone":
    case "deliverable":
    case "risk":
    case "project_update": {
      const table = { milestone: "milestones", deliverable: "deliverables", risk: "risks", project_update: "project_updates" }[type];
      const r = db.get<{ project_id: string }>(`SELECT project_id FROM ${table} WHERE id = ?`, id);
      return !!r && canViewProject(db, u, r.project_id);
    }
    case "decision": {
      const f = decisionVisibleSql(u, "d");
      return !!db.get(`SELECT 1 FROM decisions d WHERE d.id = ? AND ${f.sql}`, id, ...f.params);
    }
    case "learning": {
      const f = learningVisibleSql(u, "l");
      return !!db.get(`SELECT 1 FROM learning_records l WHERE l.id = ? AND ${f.sql}`, id, ...f.params);
    }
    case "improvement":
    case "programme":
      return true;
    case "user":
      return true;
    default:
      return false;
  }
}
