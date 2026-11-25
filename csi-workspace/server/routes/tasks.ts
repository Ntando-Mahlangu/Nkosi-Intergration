/**
 * Task management API (spec §9). Tasks are the central execution entity; every
 * read is filtered through taskVisibleSql and every write through the
 * canWorkTask / canManageTask / canAssignTo rules in lib/access.ts.
 */
import { Router, type Request } from "express";
import { z } from "zod";
import type { SQLInputValue } from "node:sqlite";
import type { Db } from "../db/index.js";
import { h, parse, badRequest, forbidden, notFound, zTitle, zText, zOptDate, zOptId, zPriority, pageParams } from "../lib/http.js";
import { currentUser, type AuthUser } from "../lib/context.js";
import {
  taskVisibleSql,
  canViewTask,
  canWorkTask,
  canManageTask,
  canAssignTo,
  canViewProject,
  canContributeProject,
  canManageProject,
  canViewMeeting,
} from "../lib/access.js";
import { audit, activity, notify, statusChange, nextTaskRef, resolveToday } from "../lib/events.js";
import { addDays, newId, nowIso } from "../lib/ids.js";
import { toCsv } from "../lib/csv.js";

export const tasksRouter = Router();

export const OPEN_STATUSES = ["todo", "in_progress", "blocked", "awaiting_review"] as const;
const OPEN_SQL = "('todo','in_progress','blocked','awaiting_review')";
const SOURCES = ["personal", "meeting", "project", "deliverable", "management", "email", "knowledge", "opportunity", "automation", "import"] as const;

interface TaskDbRow {
  id: string;
  ref: number;
  title: string;
  description: string;
  status: string;
  priority: string;
  due_date: string | null;
  assignee_id: string | null;
  creator_id: string | null;
  reviewer_id: string | null;
  project_id: string | null;
  meeting_id: string | null;
  deliverable_id: string | null;
  milestone_id: string | null;
  source: string;
  review_required: number;
  review_status: string;
  is_personal: number;
  completed_at: string | null;
  start_date: string | null;
  tags: string;
  assignee_name: string | null;
  creator_name: string | null;
  reviewer_name: string | null;
  project_name: string | null;
  meeting_title: string | null;
  [k: string]: unknown;
}

const SELECT_ROW = `SELECT t.*, ua.name AS assignee_name, uc.name AS creator_name, ur.name AS reviewer_name,
  p.name AS project_name, m.title AS meeting_title,
  (SELECT COUNT(*) FROM dependencies d JOIN tasks td ON td.id = d.to_id
     WHERE d.from_type = 'task' AND d.from_id = t.id AND d.to_type = 'task' AND td.status NOT IN ('completed','cancelled')) AS blocked_by_open
  FROM tasks t
  LEFT JOIN users ua ON ua.id = t.assignee_id
  LEFT JOIN users uc ON uc.id = t.creator_id
  LEFT JOIN users ur ON ur.id = t.reviewer_id
  LEFT JOIN projects p ON p.id = t.project_id
  LEFT JOIN meetings m ON m.id = t.meeting_id`;

function decorate(db: Db, u: AuthUser, r: TaskDbRow) {
  // Hide the names of restricted projects/meetings the viewer cannot see (task visible via assignment).
  const projectVisible = r.project_id ? canViewProject(db, u, r.project_id) : false;
  const meetingVisible = r.meeting_id ? canViewMeeting(db, u, r.meeting_id) : false;
  return {
    ...r,
    project_name: r.project_id ? (projectVisible ? r.project_name : "Restricted project") : null,
    meeting_title: r.meeting_id ? (meetingVisible ? r.meeting_title : "Restricted meeting") : null,
    review_required: !!r.review_required,
    is_personal: !!r.is_personal,
    can_work: canWorkTask(db, u, r),
    can_manage: canManageTask(db, u, r),
  };
}

function loadTask(db: Db, u: AuthUser, id: string): TaskDbRow {
  const f = taskVisibleSql(u, "t");
  const r = db.get<TaskDbRow>(`${SELECT_ROW} WHERE t.id = ? AND ${f.sql}`, id, ...f.params);
  if (!r) throw notFound("Task not found.");
  return r;
}

function activeUser(db: Db, id: string | null | undefined, what = "person"): { id: string; name: string } | null {
  if (!id) return null;
  const r = db.get<{ id: string; name: string }>("SELECT id, name FROM users WHERE id = ? AND active = 1", id);
  if (!r) throw badRequest(`The selected ${what} is not an active user.`, { fields: { [what === "reviewer" ? "reviewer_id" : "assignee_id"]: "Choose an active user." } });
  return r;
}

const can_review = (db: Db, u: AuthUser, t: TaskDbRow) =>
  t.status === "awaiting_review" && t.assignee_id !== u.id && (t.reviewer_id === u.id || (!!t.project_id && canManageProject(db, u, t.project_id)));

// ---------------------------------------------------------------- list
function buildListQuery(req: Request, u: AuthUser) {
  const db = req.ctx.db;
  const q = req.query as Record<string, string | undefined>;
  const today = resolveToday(db, q.today);
  const where: string[] = [];
  const params: SQLInputValue[] = [];
  const vis = taskVisibleSql(u, "t");
  where.push(vis.sql);
  params.push(...vis.params);

  const view = q.view || "all";
  const contextual = !!(q.project_id || q.meeting_id || q.deliverable_id);
  const scope = q.scope === "mine" ? "mine" : q.scope === "visible" || contextual ? "visible" : "mine";
  if (view === "to_review") {
    where.push("t.reviewer_id = ? AND t.status = 'awaiting_review'");
    params.push(u.id);
  } else if (scope === "mine") {
    where.push("t.assignee_id = ?");
    params.push(u.id);
  }
  if (q.project_id) { where.push("t.project_id = ?"); params.push(q.project_id); }
  if (q.meeting_id) { where.push("t.meeting_id = ?"); params.push(q.meeting_id); }
  if (q.deliverable_id) { where.push("t.deliverable_id = ?"); params.push(q.deliverable_id); }
  if (q.assignee_id) { where.push("t.assignee_id = ?"); params.push(q.assignee_id); }
  if (q.status) {
    const sts = q.status.split(",").filter(Boolean);
    where.push(`t.status IN (${sts.map(() => "?").join(",")})`);
    params.push(...sts);
  }
  if (q.priority) { where.push("t.priority = ?"); params.push(q.priority); }
  if (q.q) {
    where.push("(t.title LIKE ? OR t.description LIKE ? OR t.tags LIKE ? OR CAST(t.ref AS TEXT) = ?)");
    const like = `%${q.q.replace(/^T-/i, "")}%`;
    params.push(like, like, like, q.q.replace(/^T-/i, ""));
  }
  const open = `t.status IN ${OPEN_SQL}`;
  switch (view) {
    case "today": where.push(`${open} AND t.due_date = ?`); params.push(today); break;
    case "week": where.push(`${open} AND t.due_date >= ? AND t.due_date <= ?`); params.push(today, addDays(today, 6)); break;
    case "overdue": where.push(`${open} AND t.due_date < ?`); params.push(today); break;
    case "upcoming": where.push(`${open} AND t.due_date > ?`); params.push(today); break;
    case "awaiting_review": where.push("t.status = 'awaiting_review'"); break;
    case "completed": where.push("t.status = 'completed'"); break;
    case "meeting": where.push(`${open} AND t.meeting_id IS NOT NULL`); break;
    case "project": where.push(`${open} AND t.project_id IS NOT NULL`); break;
    case "personal": where.push(`${open} AND t.project_id IS NULL`); break;
    case "suggested": where.push("t.status = 'suggested'"); break;
    case "to_review": break;
    case "everything": break;
    default:
      // "all": outstanding work (when listing a project/meeting, show everything except cancelled unless status filter given)
      if (!q.status) where.push(contextual && scope === "visible" ? "t.status <> 'cancelled'" : open);
  }
  const sorts: Record<string, string> = {
    due: "t.due_date IS NULL, t.due_date ASC, CASE t.priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END, t.ref",
    priority: "CASE t.priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END, t.due_date IS NULL, t.due_date",
    created: "t.created_at DESC",
    updated: "t.updated_at DESC",
  };
  const order = view === "completed" && !q.sort ? "t.completed_at DESC" : (sorts[q.sort ?? "due"] ?? sorts.due);
  return { where: where.join(" AND "), params, order, today };
}

tasksRouter.get(
  "/",
  h((req, res) => {
    const u = currentUser(req);
    const db = req.ctx.db;
    const { where, params, order } = buildListQuery(req, u);
    const { limit, offset } = pageParams(req.query, 100, 500);
    const total = db.get<{ n: number }>(`SELECT COUNT(*) n FROM tasks t WHERE ${where}`, ...params)!.n;
    const rows = db.all<TaskDbRow>(`${SELECT_ROW} WHERE ${where} ORDER BY ${order} LIMIT ? OFFSET ?`, ...params, limit, offset);
    res.json({ items: rows.map((r) => decorate(db, u, r)), total });
  }),
);

tasksRouter.get(
  "/export.csv",
  h((req, res) => {
    const u = currentUser(req);
    const db = req.ctx.db;
    const { where, params, order } = buildListQuery(req, u);
    const rows = db.all<TaskDbRow>(`${SELECT_ROW} WHERE ${where} ORDER BY ${order} LIMIT 5000`, ...params).map((r) => decorate(db, u, r));
    audit(db, req, "export.tasks", null, { count: rows.length, view: req.query.view ?? "all", scope: req.query.scope ?? "mine" });
    const csv = toCsv(
      rows.map((r) => ({
        ref: `T-${r.ref}`, title: r.title, status: r.status, priority: r.priority, due_date: r.due_date ?? "", assignee: r.assignee_name ?? "",
        project: r.project_name ?? "", meeting: r.meeting_title ?? "", source: r.source, review_required: r.review_required ? "yes" : "no",
        reviewer: r.reviewer_name ?? "", review_status: r.review_status, tags: r.tags, completed_at: r.completed_at ?? "", description: r.description,
      })),
    );
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="csi-tasks-${new Date().toISOString().slice(0, 10)}.csv"`);
    res.send(csv);
  }),
);

// ---------------------------------------------------------------- create
const createSchema = z.object({
  title: zTitle,
  description: zText(10000).optional().default(""),
  assignee_id: zOptId,
  project_id: zOptId,
  meeting_id: zOptId,
  deliverable_id: zOptId,
  milestone_id: zOptId,
  source: z.enum(SOURCES).optional(),
  source_ref: zText(500).optional().default(""),
  task_type: zText(60).optional().default(""),
  priority: zPriority.default("normal"),
  due_date: zOptDate,
  start_date: zOptDate,
  review_required: z.boolean().optional().default(false),
  reviewer_id: zOptId,
  is_personal: z.boolean().optional().default(false),
  tags: zText(300).optional().default(""),
});

/**
 * Allocate the next human task number. Guards against the sequence lagging behind
 * existing refs (e.g. rows inserted by imports/seed without using the sequence).
 */
export function allocateTaskRef(db: Db): number {
  const r = nextTaskRef(db);
  const max = db.get<{ m: number | null }>("SELECT MAX(ref) m FROM tasks")!.m ?? 0;
  if (r > max) return r;
  db.run("UPDATE task_ref_seq SET next = ? WHERE id = 1", max + 2);
  return max + 1;
}

function normTags(s: string) {
  return [...new Set(s.split(",").map((t) => t.trim().toLowerCase()).filter(Boolean))].slice(0, 15).join(",");
}

function validateLinks(db: Db, u: AuthUser, b: { project_id: string | null; meeting_id: string | null; deliverable_id: string | null; milestone_id: string | null }) {
  if (b.project_id) {
    if (!canViewProject(db, u, b.project_id)) throw badRequest("Project not found.", { fields: { project_id: "Choose a project you can access." } });
    if (!canContributeProject(db, u, b.project_id)) throw forbidden("Only project members can add tasks to this project.");
  }
  if (b.meeting_id && !canViewMeeting(db, u, b.meeting_id)) throw badRequest("Meeting not found.", { fields: { meeting_id: "Meeting not found." } });
  for (const [col, table] of [["deliverable_id", "deliverables"], ["milestone_id", "milestones"]] as const) {
    const id = b[col];
    if (!id) continue;
    const r = db.get<{ project_id: string }>(`SELECT project_id FROM ${table} WHERE id = ?`, id);
    if (!r || !canViewProject(db, u, r.project_id)) throw badRequest("Linked item not found.", { fields: { [col]: "Not found." } });
    if (b.project_id && r.project_id !== b.project_id) throw badRequest("The linked item belongs to a different project.", { fields: { [col]: "Belongs to a different project." } });
    if (!b.project_id) b.project_id = r.project_id;
  }
}

tasksRouter.post(
  "/",
  h((req, res) => {
    const u = currentUser(req);
    const db = req.ctx.db;
    const b = parse(createSchema, req.body);
    validateLinks(db, u, b);
    const assigneeId = b.assignee_id ?? u.id;
    const assignee = activeUser(db, assigneeId, "assignee")!;
    if (!canAssignTo(db, u, assigneeId, b.project_id)) throw forbidden("You can only assign tasks to others in projects you manage.");
    let reviewerId = b.reviewer_id;
    if (b.review_required && !reviewerId) {
      const owner = b.project_id ? db.get<{ owner_id: string | null }>("SELECT owner_id FROM projects WHERE id = ?", b.project_id)?.owner_id : null;
      reviewerId = owner && owner !== assigneeId ? owner : u.id !== assigneeId ? u.id : null;
      if (!reviewerId) throw badRequest("Choose a reviewer for this task.", { fields: { reviewer_id: "A reviewer is required when review is required." } });
    }
    if (reviewerId) activeUser(db, reviewerId, "reviewer");
    if (reviewerId && reviewerId === assigneeId) throw badRequest("The reviewer must be someone other than the assignee.", { fields: { reviewer_id: "Choose someone other than the assignee." } });
    if (b.due_date && b.start_date && b.start_date > b.due_date) throw badRequest("Start date is after the due date.", { fields: { start_date: "Must be on or before the due date." } });
    const source = b.source ?? (b.meeting_id ? "meeting" : b.deliverable_id ? "deliverable" : b.project_id ? "project" : "personal");
    const id = newId("tsk");
    const now = nowIso();
    const programme = b.project_id ? db.get<{ programme_id: string | null }>("SELECT programme_id FROM projects WHERE id = ?", b.project_id)?.programme_id : null;
    db.tx(() => {
      db.insert("tasks", {
        id, ref: allocateTaskRef(db), title: b.title, description: b.description, assignee_id: assigneeId, creator_id: u.id,
        project_id: b.project_id, programme_id: programme ?? null, meeting_id: b.meeting_id, deliverable_id: b.deliverable_id, milestone_id: b.milestone_id,
        source, source_ref: b.source_ref, task_type: b.task_type, priority: b.priority, status: "todo", due_date: b.due_date, start_date: b.start_date,
        review_required: reviewerId ? 1 : 0, reviewer_id: reviewerId, review_status: "none", is_personal: !b.project_id && b.is_personal ? 1 : 0,
        tags: normTags(b.tags), created_at: now, updated_at: now,
      });
      statusChange(db, u.id, "task", id, "status", null, "todo");
      activity(db, u, assigneeId === u.id ? "task.created" : "task.assigned", { type: "task", id, label: b.title }, { projectId: b.project_id, detail: assigneeId === u.id ? "" : `to ${assignee.name}` });
      if (assigneeId !== u.id) {
        audit(db, req, "task.assign", { type: "task", id }, { assignee_id: assigneeId });
        notify(db, { userId: assigneeId, type: "task_assigned", title: `${u.name} assigned you: ${b.title}`, body: b.due_date ? `Due ${b.due_date}` : "", entity: { type: "task", id }, actorId: u.id });
      }
    });
    res.status(201).json(decorate(db, u, loadTask(db, u, id)));
  }),
);

// ---------------------------------------------------------------- detail
tasksRouter.get(
  "/:id",
  h((req, res) => {
    const u = currentUser(req);
    const db = req.ctx.db;
    const t = loadTask(db, u, req.params.id);
    const collaborators = db.all("SELECT us.id, us.name FROM task_collaborators tc JOIN users us ON us.id = tc.user_id WHERE tc.task_id = ? ORDER BY us.name", t.id);
    const depRow = (type: string, id: string) => {
      if (type === "task") {
        if (!canViewTask(db, u, id)) return { type, id, label: "Restricted task", status: null, ref: null, visible: false };
        const r = db.get<{ title: string; status: string; ref: number }>("SELECT title, status, ref FROM tasks WHERE id = ?", id);
        return r ? { type, id, label: r.title, status: r.status, ref: r.ref, visible: true } : { type, id, label: "(deleted)", status: null, ref: null, visible: false };
      }
      const table = ({ milestone: "milestones", deliverable: "deliverables" } as Record<string, string>)[type];
      if (!table) return { type, id, label: type, status: null, ref: null, visible: false };
      const r = db.get<{ label: string; status: string; project_id: string }>(`SELECT ${type === "milestone" ? "title" : "name"} AS label, status, project_id FROM ${table} WHERE id = ?`, id);
      if (!r || !canViewProject(db, u, r.project_id)) return { type, id, label: `Restricted ${type}`, status: null, ref: null, visible: false };
      return { type, id, label: r.label, status: r.status, ref: null, visible: true };
    };
    const depends_on = db
      .all<{ id: string; to_type: string; to_id: string; note: string }>("SELECT id, to_type, to_id, note FROM dependencies WHERE from_type = 'task' AND from_id = ?", t.id)
      .map((d) => ({ dependency_id: d.id, note: d.note, ...depRow(d.to_type, d.to_id) }));
    const blocking = db
      .all<{ id: string; from_type: string; from_id: string; note: string }>("SELECT id, from_type, from_id, note FROM dependencies WHERE to_type = 'task' AND to_id = ?", t.id)
      .map((d) => ({ dependency_id: d.id, note: d.note, ...depRow(d.from_type, d.from_id) }));
    const history = db.all(
      "SELECT sh.field, sh.from_value, sh.to_value, sh.note, sh.changed_at, us.name AS changed_by_name FROM status_history sh LEFT JOIN users us ON us.id = sh.changed_by WHERE sh.entity_type = 'task' AND sh.entity_id = ? ORDER BY sh.changed_at DESC, sh.rowid DESC",
      t.id,
    );
    const reviews = db.all(
      "SELECT c.id, c.body, c.created_at, us.name AS author_name FROM comments c LEFT JOIN users us ON us.id = c.author_id WHERE c.entity_type = 'task' AND c.entity_id = ? AND c.kind = 'review_feedback' ORDER BY c.created_at DESC",
      t.id,
    );
    const milestone = t.milestone_id ? db.get<{ title: string }>("SELECT title FROM milestones WHERE id = ?", t.milestone_id)?.title ?? null : null;
    const deliverable = t.deliverable_id ? db.get<{ name: string }>("SELECT name FROM deliverables WHERE id = ?", t.deliverable_id)?.name ?? null : null;
    const d = decorate(db, u, t);
    res.json({
      ...d,
      milestone_title: milestone,
      deliverable_name: deliverable,
      collaborators,
      depends_on,
      blocking,
      history,
      reviews,
      permissions: {
        can_work: d.can_work,
        can_manage: d.can_manage,
        can_review: can_review(db, u, t),
        can_accept: t.status === "suggested" && t.assignee_id === u.id,
        can_delete: d.can_manage,
      },
    });
  }),
);

// ---------------------------------------------------------------- update
const patchSchema = z.object({
  title: zTitle.optional(),
  description: zText(10000).optional(),
  assignee_id: zOptId,
  due_date: z.union([z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use a valid date."), z.literal(""), z.null()]).optional(),
  start_date: z.union([z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use a valid date."), z.literal(""), z.null()]).optional(),
  priority: zPriority.optional(),
  review_required: z.boolean().optional(),
  reviewer_id: zOptId,
  tags: zText(300).optional(),
  task_type: zText(60).optional(),
  is_personal: z.boolean().optional(),
  status: z.enum(["todo", "in_progress", "blocked", "cancelled"]).optional(),
  blocked_reason: zText(1000).optional(),
});
const MANAGER_FIELDS = ["title", "assignee_id", "due_date", "start_date", "priority", "review_required", "reviewer_id", "task_type", "is_personal"] as const;

tasksRouter.patch(
  "/:id",
  h((req, res) => {
    const u = currentUser(req);
    const db = req.ctx.db;
    const t = loadTask(db, u, req.params.id);
    const raw = (req.body ?? {}) as Record<string, unknown>;
    const b = parse(patchSchema, raw);
    const manage = canManageTask(db, u, t);
    const work = canWorkTask(db, u, t);
    if (!work) throw forbidden("You can view this task but not change it.");
    const touchesManager = MANAGER_FIELDS.some((k) => k in raw);
    if (touchesManager && !manage) throw forbidden("Only the task creator or project manager can change those details.");
    if ("description" in raw && !manage && t.assignee_id !== u.id) throw forbidden("Only the assignee, creator or project manager can edit the description.");
    if (t.status === "suggested" && b.status) throw badRequest("Accept or decline this suggested task first.");
    if (["completed", "cancelled"].includes(t.status) && b.status && b.status !== "cancelled") throw badRequest("Reopen the task before changing its status.");
    if (b.status === "cancelled" && !manage) throw forbidden("Only the task creator or project manager can cancel a task.");
    if (t.status === "awaiting_review" && b.status && b.status !== "cancelled" && !manage) throw badRequest("This task is awaiting review.");

    const patch: Record<string, unknown> = { updated_at: nowIso() };
    if (b.title !== undefined) patch.title = b.title;
    if (b.description !== undefined) patch.description = b.description;
    if ("due_date" in raw) patch.due_date = b.due_date || null;
    if ("start_date" in raw) patch.start_date = b.start_date || null;
    if (b.priority) patch.priority = b.priority;
    if (b.tags !== undefined) patch.tags = normTags(b.tags);
    if (b.task_type !== undefined) patch.task_type = b.task_type;
    if (b.is_personal !== undefined) patch.is_personal = b.is_personal && !t.project_id ? 1 : 0;

    let newAssignee: string | null = null;
    if ("assignee_id" in raw && b.assignee_id !== t.assignee_id) {
      if (!b.assignee_id) throw badRequest("A task needs an assignee.", { fields: { assignee_id: "Choose someone." } });
      activeUser(db, b.assignee_id, "assignee");
      if (!canAssignTo(db, u, b.assignee_id, t.project_id)) throw forbidden("You can only assign tasks to others in projects you manage.");
      patch.assignee_id = b.assignee_id;
      newAssignee = b.assignee_id;
    }
    const finalAssignee = (patch.assignee_id as string | undefined) ?? t.assignee_id;
    let reviewer = "reviewer_id" in raw ? b.reviewer_id : t.reviewer_id;
    const reviewRequired = b.review_required ?? !!t.review_required;
    if (reviewRequired && !reviewer) throw badRequest("Choose a reviewer.", { fields: { reviewer_id: "A reviewer is required when review is required." } });
    if (!reviewRequired) reviewer = "reviewer_id" in raw ? b.reviewer_id : null;
    if (reviewer) activeUser(db, reviewer, "reviewer");
    if (reviewer && reviewer === finalAssignee) throw badRequest("The reviewer must be someone other than the assignee.", { fields: { reviewer_id: "Choose someone other than the assignee." } });
    if ("review_required" in raw || "reviewer_id" in raw) {
      patch.review_required = reviewRequired ? 1 : 0;
      patch.reviewer_id = reviewer;
    }
    const due = (patch.due_date as string | null | undefined) ?? t.due_date;
    const start = (patch.start_date as string | null | undefined) ?? t.start_date;
    if (due && start && start > due) throw badRequest("Start date is after the due date.", { fields: { start_date: "Must be on or before the due date." } });

    if (b.status && b.status !== t.status) {
      if (b.status === "blocked" && !(b.blocked_reason ?? "").trim()) throw badRequest("Say what is blocking this task.", { fields: { blocked_reason: "A reason is required." } });
      patch.status = b.status;
      if (b.status !== "blocked") patch.blocked_reason = "";
      if (t.status === "awaiting_review") patch.review_status = "none";
    }
    if (b.blocked_reason !== undefined && (patch.status ?? t.status) === "blocked") patch.blocked_reason = b.blocked_reason;

    db.tx(() => {
      db.update("tasks", t.id, patch);
      if (patch.status) {
        statusChange(db, u.id, "task", t.id, "status", t.status, patch.status as string, (patch.blocked_reason as string) ?? "");
        activity(db, u, "task.status", { type: "task", id: t.id, label: (patch.title as string) ?? t.title }, { projectId: t.project_id, detail: `→ ${String(patch.status).replace(/_/g, " ")}` });
        if (patch.status === "blocked" && t.creator_id && t.creator_id !== u.id)
          notify(db, { userId: t.creator_id, type: "task_assigned", title: `Blocked: ${t.title}`, body: String(patch.blocked_reason ?? ""), entity: { type: "task", id: t.id }, actorId: u.id });
      }
      if (newAssignee) {
        audit(db, req, "task.assign", { type: "task", id: t.id }, { from: t.assignee_id, to: newAssignee });
        activity(db, u, "task.assigned", { type: "task", id: t.id, label: t.title }, { projectId: t.project_id });
        notify(db, { userId: newAssignee, type: "task_assigned", title: `${u.name} assigned you: ${(patch.title as string) ?? t.title}`, entity: { type: "task", id: t.id }, actorId: u.id });
      } else if (t.assignee_id && t.assignee_id !== u.id && ("due_date" in raw || b.priority)) {
        notify(db, { userId: t.assignee_id, type: "task_assigned", title: `${u.name} updated: ${t.title}`, body: "Due date or priority changed.", entity: { type: "task", id: t.id }, actorId: u.id });
      }
    });
    res.json(decorate(db, u, loadTask(db, u, t.id)));
  }),
);

// ---------------------------------------------------------------- workflow actions
function setStatus(db: Db, u: AuthUser, t: TaskDbRow, to: string, extra: Record<string, unknown> = {}, note = "") {
  db.update("tasks", t.id, { status: to, updated_at: nowIso(), ...extra });
  statusChange(db, u.id, "task", t.id, "status", t.status, to, note);
}

tasksRouter.post(
  "/:id/complete",
  h((req, res) => {
    const u = currentUser(req);
    const db = req.ctx.db;
    const t = loadTask(db, u, req.params.id);
    if (!canWorkTask(db, u, t)) throw forbidden("You can view this task but not change it.");
    if (t.status === "completed") throw badRequest("This task is already completed.");
    if (t.status === "suggested") throw badRequest("Accept this suggested task before completing it.");
    if (t.status === "cancelled") throw badRequest("Reopen the task first.");
    if (t.review_required && t.review_status !== "approved") throw badRequest("This task requires review. Submit it for review instead.");
    db.tx(() => {
      setStatus(db, u, t, "completed", { completed_at: nowIso(), blocked_reason: "" });
      activity(db, u, "task.completed", { type: "task", id: t.id, label: t.title }, { projectId: t.project_id });
      for (const uid of new Set([t.creator_id, t.assignee_id])) {
        notify(db, { userId: uid, type: "task_completed", title: `${u.name} completed: ${t.title}`, entity: { type: "task", id: t.id }, actorId: u.id });
      }
    });
    res.json(decorate(db, u, loadTask(db, u, t.id)));
  }),
);

tasksRouter.post(
  "/:id/reopen",
  h((req, res) => {
    const u = currentUser(req);
    const db = req.ctx.db;
    const t = loadTask(db, u, req.params.id);
    if (!["completed", "cancelled"].includes(t.status)) throw badRequest("Only completed or cancelled tasks can be reopened.");
    const allowed = canManageTask(db, u, t) || (t.assignee_id === u.id && t.status === "completed");
    if (!allowed) throw forbidden("You cannot reopen this task.");
    db.tx(() => {
      setStatus(db, u, t, "todo", { completed_at: null, review_status: "none" });
      activity(db, u, "task.reopened", { type: "task", id: t.id, label: t.title }, { projectId: t.project_id });
    });
    res.json(decorate(db, u, loadTask(db, u, t.id)));
  }),
);

tasksRouter.post(
  "/:id/submit-review",
  h((req, res) => {
    const u = currentUser(req);
    const db = req.ctx.db;
    const t = loadTask(db, u, req.params.id);
    const b = parse(z.object({ reviewer_id: zOptId, note: zText(3000).optional().default("") }), req.body);
    if (!canWorkTask(db, u, t)) throw forbidden("You can view this task but not change it.");
    if (!["todo", "in_progress", "blocked"].includes(t.status)) throw badRequest("Only open tasks can be submitted for review.");
    const reviewer = b.reviewer_id ?? t.reviewer_id;
    if (!reviewer) throw badRequest("Choose a reviewer.", { fields: { reviewer_id: "Choose who should review this." } });
    activeUser(db, reviewer, "reviewer");
    if (reviewer === t.assignee_id) throw badRequest("You cannot review your own work.", { fields: { reviewer_id: "Choose someone other than the assignee." } });
    db.tx(() => {
      setStatus(db, u, t, "awaiting_review", { review_required: 1, reviewer_id: reviewer, review_status: "pending", blocked_reason: "" }, b.note);
      statusChange(db, u.id, "task", t.id, "review_status", t.review_status, "pending");
      if (b.note.trim()) db.insert("comments", { id: newId("cmt"), entity_type: "task", entity_id: t.id, author_id: u.id, body: b.note, kind: "note", created_at: nowIso() });
      activity(db, u, "task.submitted_for_review", { type: "task", id: t.id, label: t.title }, { projectId: t.project_id });
      notify(db, { userId: reviewer, type: "review_requested", title: `${u.name} submitted '${t.title}' for review`, entity: { type: "task", id: t.id }, actorId: u.id });
    });
    res.json(decorate(db, u, loadTask(db, u, t.id)));
  }),
);

tasksRouter.post(
  "/:id/review",
  h((req, res) => {
    const u = currentUser(req);
    const db = req.ctx.db;
    const t = loadTask(db, u, req.params.id);
    const b = parse(z.object({ decision: z.enum(["approve", "changes"]), feedback: zText(5000).optional().default("") }), req.body);
    if (t.status !== "awaiting_review") throw badRequest("This task is not awaiting review.");
    if (!can_review(db, u, t)) throw forbidden("Only the assigned reviewer or project manager can review this task.");
    if (b.decision === "changes" && !b.feedback.trim()) throw badRequest("Explain what needs to change.", { fields: { feedback: "Feedback is required when requesting changes." } });
    db.tx(() => {
      if (b.decision === "approve") {
        setStatus(db, u, t, "completed", { review_status: "approved", completed_at: nowIso() }, b.feedback);
        statusChange(db, u.id, "task", t.id, "review_status", "pending", "approved", b.feedback);
        activity(db, u, "task.review_approved", { type: "task", id: t.id, label: t.title }, { projectId: t.project_id });
        notify(db, { userId: t.assignee_id, type: "task_completed", title: `${u.name} approved: ${t.title}`, body: b.feedback, entity: { type: "task", id: t.id }, actorId: u.id });
      } else {
        setStatus(db, u, t, "in_progress", { review_status: "changes_requested" }, b.feedback);
        statusChange(db, u.id, "task", t.id, "review_status", "pending", "changes_requested", b.feedback);
        activity(db, u, "task.changes_requested", { type: "task", id: t.id, label: t.title }, { projectId: t.project_id });
        notify(db, { userId: t.assignee_id, type: "changes_requested", title: `Changes requested on '${t.title}'`, body: b.feedback.slice(0, 300), entity: { type: "task", id: t.id }, actorId: u.id });
      }
      if (b.feedback.trim()) db.insert("comments", { id: newId("cmt"), entity_type: "task", entity_id: t.id, author_id: u.id, body: `${b.decision === "approve" ? "Approved" : "Changes requested"}: ${b.feedback}`, kind: "review_feedback", created_at: nowIso() });
      audit(db, req, "task.review", { type: "task", id: t.id }, { decision: b.decision });
    });
    res.json(decorate(db, u, loadTask(db, u, t.id)));
  }),
);

tasksRouter.post(
  "/:id/accept",
  h((req, res) => {
    const u = currentUser(req);
    const db = req.ctx.db;
    const t = loadTask(db, u, req.params.id);
    if (t.status !== "suggested") throw badRequest("This task is not awaiting confirmation.");
    if (t.assignee_id !== u.id) throw forbidden("Only the suggested assignee can accept this responsibility.");
    const b = parse(z.object({ due_date: zOptDate }), req.body ?? {});
    db.tx(() => {
      setStatus(db, u, t, "todo", b.due_date ? { due_date: b.due_date } : {});
      activity(db, u, "task.accepted", { type: "task", id: t.id, label: t.title }, { projectId: t.project_id });
      notify(db, { userId: t.creator_id, type: "task_assigned", title: `${u.name} accepted: ${t.title}`, entity: { type: "task", id: t.id }, actorId: u.id });
    });
    res.json(decorate(db, u, loadTask(db, u, t.id)));
  }),
);

tasksRouter.post(
  "/:id/decline",
  h((req, res) => {
    const u = currentUser(req);
    const db = req.ctx.db;
    const t = loadTask(db, u, req.params.id);
    const b = parse(z.object({ reason: z.string().trim().min(1, "Give a short reason so the organiser can reassign it.").max(2000) }), req.body);
    if (t.status !== "suggested") throw badRequest("This task is not awaiting confirmation.");
    if (t.assignee_id !== u.id) throw forbidden("Only the suggested assignee can decline this responsibility.");
    db.tx(() => {
      setStatus(db, u, t, "cancelled", {}, `Declined: ${b.reason}`);
      db.insert("comments", { id: newId("cmt"), entity_type: "task", entity_id: t.id, author_id: u.id, body: `Declined: ${b.reason}`, kind: "note", created_at: nowIso() });
      activity(db, u, "task.declined", { type: "task", id: t.id, label: t.title }, { projectId: t.project_id, detail: b.reason });
      notify(db, { userId: t.creator_id, type: "task_assigned", title: `${u.name} declined: ${t.title}`, body: b.reason, entity: { type: "task", id: t.id }, actorId: u.id });
    });
    res.json(decorate(db, u, loadTask(db, u, t.id)));
  }),
);

// ---------------------------------------------------------------- collaborators
tasksRouter.post(
  "/:id/collaborators",
  h((req, res) => {
    const u = currentUser(req);
    const db = req.ctx.db;
    const t = loadTask(db, u, req.params.id);
    const b = parse(z.object({ user_id: z.string().min(3) }), req.body);
    if (!canManageTask(db, u, t) && t.assignee_id !== u.id) throw forbidden("Only the assignee, creator or project manager can add collaborators.");
    const target = activeUser(db, b.user_id)!;
    if (b.user_id === t.assignee_id) throw badRequest("The assignee is already responsible for this task.");
    if (t.is_personal) throw badRequest("Personal tasks are private and cannot have collaborators.");
    db.run("INSERT OR IGNORE INTO task_collaborators (task_id, user_id) VALUES (?, ?)", t.id, b.user_id);
    notify(db, { userId: b.user_id, type: "task_assigned", title: `${u.name} added you as a collaborator on '${t.title}'`, entity: { type: "task", id: t.id }, actorId: u.id });
    activity(db, u, "task.collaborator_added", { type: "task", id: t.id, label: t.title }, { projectId: t.project_id, detail: target.name });
    res.status(201).json({ ok: true });
  }),
);

tasksRouter.delete(
  "/:id/collaborators/:userId",
  h((req, res) => {
    const u = currentUser(req);
    const db = req.ctx.db;
    const t = loadTask(db, u, req.params.id);
    if (!canManageTask(db, u, t) && t.assignee_id !== u.id && req.params.userId !== u.id) throw forbidden();
    db.run("DELETE FROM task_collaborators WHERE task_id = ? AND user_id = ?", t.id, req.params.userId);
    res.json({ ok: true });
  }),
);

// ---------------------------------------------------------------- dependencies
function wouldCycle(db: Db, fromId: string, toId: string): boolean {
  // Adding from → to creates a cycle if `to` already (transitively) depends on `from`.
  const seen = new Set<string>();
  const stack = [toId];
  while (stack.length) {
    const cur = stack.pop()!;
    if (cur === fromId) return true;
    if (seen.has(cur)) continue;
    seen.add(cur);
    for (const r of db.all<{ to_id: string }>("SELECT to_id FROM dependencies WHERE from_type = 'task' AND from_id = ? AND to_type = 'task'", cur)) stack.push(r.to_id);
  }
  return false;
}

tasksRouter.post(
  "/:id/dependencies",
  h((req, res) => {
    const u = currentUser(req);
    const db = req.ctx.db;
    const t = loadTask(db, u, req.params.id);
    const b = parse(z.object({ depends_on_task_id: z.string().min(3), note: zText(500).optional().default("") }), req.body);
    if (!canWorkTask(db, u, t)) throw forbidden();
    if (b.depends_on_task_id === t.id) throw badRequest("A task cannot depend on itself.");
    if (!canViewTask(db, u, b.depends_on_task_id)) throw badRequest("Task not found.", { fields: { depends_on_task_id: "Choose a task you can see." } });
    if (wouldCycle(db, t.id, b.depends_on_task_id)) throw badRequest("That would create a circular dependency.");
    const id = newId("dep");
    db.run("INSERT OR IGNORE INTO dependencies (id, from_type, from_id, to_type, to_id, note, created_by, created_at) VALUES (?, 'task', ?, 'task', ?, ?, ?, ?)", id, t.id, b.depends_on_task_id, b.note, u.id, nowIso());
    res.status(201).json({ ok: true });
  }),
);

tasksRouter.delete(
  "/:id/dependencies/:depId",
  h((req, res) => {
    const u = currentUser(req);
    const db = req.ctx.db;
    const t = loadTask(db, u, req.params.id);
    if (!canWorkTask(db, u, t)) throw forbidden();
    const r = db.run("DELETE FROM dependencies WHERE id = ? AND ((from_type = 'task' AND from_id = ?) OR (to_type = 'task' AND to_id = ?))", req.params.depId, t.id, t.id);
    if (!Number(r.changes)) throw notFound("Dependency not found.");
    res.json({ ok: true });
  }),
);

// ---------------------------------------------------------------- delete
tasksRouter.delete(
  "/:id",
  h((req, res) => {
    const u = currentUser(req);
    const db = req.ctx.db;
    const t = loadTask(db, u, req.params.id);
    if (!canManageTask(db, u, t)) throw forbidden("Only the task creator or project manager can delete this task.");
    if (t.meeting_id || t.source === "meeting") {
      // Meeting actions are part of the meeting record — cancel instead of erasing the trail.
      if (t.status !== "cancelled") setStatus(db, u, t, "cancelled", {}, "Cancelled (meeting action kept for the record)");
      audit(db, req, "task.cancel", { type: "task", id: t.id }, { title: t.title });
      return res.json({ ok: true, cancelled: true });
    }
    db.tx(() => {
      db.run("DELETE FROM dependencies WHERE (from_type = 'task' AND from_id = ?) OR (to_type = 'task' AND to_id = ?)", t.id, t.id);
      db.run("DELETE FROM comments WHERE entity_type = 'task' AND entity_id = ?", t.id);
      db.run("DELETE FROM attachments WHERE entity_type = 'task' AND entity_id = ?", t.id);
      db.run("DELETE FROM entity_links WHERE (a_type = 'task' AND a_id = ?) OR (b_type = 'task' AND b_id = ?)", t.id, t.id);
      db.run("DELETE FROM tasks WHERE id = ?", t.id);
      audit(db, req, "task.delete", { type: "task", id: t.id }, { title: t.title, ref: t.ref });
    });
    res.json({ ok: true, deleted: true });
  }),
);

