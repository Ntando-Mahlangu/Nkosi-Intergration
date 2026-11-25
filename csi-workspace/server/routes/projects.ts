/**
 * Programme & Project Delivery Management (spec §12) + global decision log (§15.5).
 *
 * Mounted at /api. Endpoints:
 *   programmes:   GET/POST /programmes, GET/PATCH /programmes/:id
 *   projects:     GET/POST /projects, GET/PATCH /projects/:id, members, activity, history, updates, report
 *   milestones:   GET/POST /projects/:id/milestones, PATCH/DELETE /milestones/:id
 *   deliverables: GET/POST /projects/:id/deliverables, GET/PATCH/DELETE /deliverables/:id, submit, review, versions
 *   risks:        GET/POST /projects/:id/risks, PATCH/DELETE /risks/:id
 *   decisions:    GET/POST /decisions, PATCH /decisions/:id, POST /decisions/:id/approve|reject
 *   dependencies: GET/POST /dependencies, DELETE /dependencies/:id, GET /projects/:id/dependencies
 *
 * All reads are filtered through lib/access.ts; budget data is only returned to project managers
 * and users with management.view.
 */
import { Router } from "express";
import { z } from "zod";
import type { SQLInputValue } from "node:sqlite";
import type { Db } from "../db/index.js";
import {
  h, parse, badRequest, forbidden, notFound, conflict, pageParams,
  zDate, zOptDate, zOptId, zPriority, zText, zTitle, zUrl,
} from "../lib/http.js";
import { can, currentUser, requirePerm, type AuthUser } from "../lib/context.js";
import { newId, nowIso } from "../lib/ids.js";
import { activity, audit, getSetting, notify, orgToday, statusChange } from "../lib/events.js";
import {
  assertProjectManage, assertProjectView, canContributeProject, canManageProject, canViewEntity, canViewProject,
  canViewTask, canWorkTask, decisionVisibleSql, knowledgeVisibleSql, learningVisibleSql, projectRole, projectVisibleSql, canViewMeeting,
} from "../lib/access.js";
import { projectProgress, suggestHealth } from "../lib/progress.js";
import { linkedRecords } from "./core.js";

export const projectsRouter = Router();

// ===================================================================== constants & schemas
const PROJECT_STATUSES = ["proposed", "planning", "active", "on_hold", "at_risk", "completed", "cancelled"] as const;
const HEALTHS = ["on_track", "needs_attention", "at_risk", "blocked", "completed"] as const;
const PROGRESS_METHODS = ["milestones", "deliverables", "tasks", "manual", "weighted"] as const;
const VISIBILITY = ["organisation", "team", "restricted"] as const;
const MEMBER_ROLES = ["manager", "member", "viewer"] as const;
const MILESTONE_STATUSES = ["not_started", "in_progress", "achieved", "missed", "cancelled"] as const;
const DELIVERABLE_STATUSES = ["not_started", "in_progress", "submitted", "under_review", "changes_requested", "approved", "completed", "cancelled"] as const;
const RISK_TYPES = ["risk", "issue", "blocker"] as const;
const SEVERITIES = ["low", "medium", "high", "critical"] as const;
const RISK_STATUSES = ["open", "mitigating", "monitoring", "resolved", "closed"] as const;
const DECISION_STATUSES = ["proposed", "pending_approval", "made", "approved", "rejected", "superseded", "revisited"] as const;
const DEP_TYPES = ["project", "milestone", "deliverable", "task"] as const;
const SEVERITY_RANK: Record<string, number> = { low: 1, medium: 2, high: 3, critical: 4 };

const zOptText = (max = 5000) => zText(max).optional();
const zOptNum = z.union([z.number(), z.null()]).optional();

const projectFields = {
  code: z.string().trim().max(12).optional(),
  name: zTitle,
  description: zOptText(),
  purpose: zOptText(),
  objectives: zOptText(),
  intended_outcomes: zOptText(),
  scope: zOptText(),
  stakeholders: zOptText(),
  reporting_requirements: zOptText(),
  category: z.string().trim().max(120).optional(),
  programme_id: zOptId,
  owner_id: zOptId,
  team_id: zOptId,
  status: z.enum(PROJECT_STATUSES).optional(),
  health: z.enum(HEALTHS).optional(),
  health_note: zOptText(1000),
  priority: zPriority.optional(),
  start_date: zOptDate,
  target_date: zOptDate,
  budget_amount: z.union([z.number().min(0).max(1e12), z.null()]).optional(),
  budget_currency: z.string().trim().length(3).optional(),
  budget_notes: zOptText(2000),
  progress_method: z.enum(PROGRESS_METHODS).optional(),
  manual_progress: z.union([z.number().int().min(0).max(100), z.null()]).optional(),
  visibility: z.enum(VISIBILITY).optional(),
  drive_folder_url: zUrl,
};
const ProjectCreate = z.object({
  ...projectFields,
  members: z.array(z.object({ user_id: z.string(), role: z.enum(MEMBER_ROLES).default("member") })).max(100).optional().default([]),
  milestones: z.array(z.object({ title: zTitle, target_date: zOptDate })).max(50).optional().default([]),
  deliverables: z.array(z.object({ name: zTitle, due_date: zOptDate })).max(50).optional().default([]),
});
const ProjectPatch = z.object({ ...projectFields, name: zTitle.optional(), drive_folder_url: zUrl.optional(), status_note: zOptText(1000) });

// ===================================================================== helpers
const today = (db: Db) => orgToday(db);

function assertActiveUser(db: Db, id: string | null | undefined, field: string) {
  if (!id) return;
  if (!db.get("SELECT 1 FROM users WHERE id = ? AND active = 1", id)) throw badRequest("Choose an active person.", { fields: { [field]: "Choose an active person." } });
}
function assertExists(db: Db, table: string, id: string | null | undefined, field: string) {
  if (!id) return;
  if (!db.get(`SELECT 1 FROM ${table} WHERE id = ?`, id)) throw badRequest("That record does not exist.", { fields: { [field]: "Not found." } });
}
function datesInOrder(start: string | null | undefined, end: string | null | undefined, field = "target_date") {
  if (start && end && end < start) throw badRequest("The target date must be on or after the start date.", { fields: { [field]: "Must be on or after the start date." } });
}
const name = (db: Db, id: string | null | undefined) => (id ? (db.get<{ name: string }>("SELECT name FROM users WHERE id = ?", id)?.name ?? null) : null);

function canSeeBudget(db: Db, u: AuthUser, projectId: string) {
  return canManageProject(db, u, projectId) || can(u, "management.view");
}

function projectSummary(db: Db, u: AuthUser, p: Record<string, unknown>) {
  const id = String(p.id);
  const t = today(db);
  const next = db.get<{ id: string; title: string; target_date: string | null; status: string }>(
    "SELECT id, title, target_date, status FROM milestones WHERE project_id = ? AND status IN ('not_started','in_progress') ORDER BY target_date IS NULL, target_date LIMIT 1",
    id,
  );
  const c = db.get<Record<string, number>>(
    `SELECT
      (SELECT COUNT(*) FROM deliverables WHERE project_id = ?1 AND status NOT IN ('approved','completed','cancelled')) AS outstanding_deliverables,
      (SELECT COUNT(*) FROM deliverables WHERE project_id = ?1 AND status NOT IN ('approved','completed','cancelled') AND due_date < ?2) AS overdue_deliverables,
      (SELECT COUNT(*) FROM tasks WHERE project_id = ?1 AND is_personal = 0 AND status IN ('todo','in_progress','blocked','awaiting_review')) AS open_actions,
      (SELECT COUNT(*) FROM tasks WHERE project_id = ?1 AND is_personal = 0 AND status IN ('todo','in_progress','blocked') AND due_date < ?2) AS overdue_actions,
      (SELECT COUNT(*) FROM milestones WHERE project_id = ?1 AND status IN ('not_started','in_progress') AND target_date < ?2) AS overdue_milestones,
      (SELECT COUNT(*) FROM risks WHERE project_id = ?1 AND status IN ('open','mitigating','monitoring')) AS open_risks`,
    id,
    t,
  )!;
  const sev = db.all<{ severity: string }>("SELECT severity FROM risks WHERE project_id = ? AND status IN ('open','mitigating','monitoring')", id);
  const risk_level = sev.reduce<string | null>((acc, r) => (!acc || SEVERITY_RANK[r.severity] > SEVERITY_RANK[acc] ? r.severity : acc), null);
  const showBudget = canSeeBudget(db, u, id);
  const out: Record<string, unknown> = {
    ...p,
    progress: projectProgress(db, id),
    next_milestone: next ?? null,
    ...c,
    risk_level,
    my_role: projectRole(db, u, id),
    can_manage: canManageProject(db, u, id),
  };
  if (!showBudget) {
    delete out.budget_amount;
    delete out.budget_notes;
    delete out.budget_currency;
  }
  out.budget_visible = showBudget;
  return out;
}

function loadProject(db: Db, id: string) {
  return db.get<Record<string, unknown>>(
    `SELECT p.*, o.name AS owner_name, tm.name AS team_name, pr.name AS programme_name
     FROM projects p LEFT JOIN users o ON o.id = p.owner_id LEFT JOIN teams tm ON tm.id = p.team_id LEFT JOIN programmes pr ON pr.id = p.programme_id
     WHERE p.id = ?`,
    id,
  );
}

function projectIdOf(db: Db, table: string, id: string): string {
  const r = db.get<{ project_id: string }>(`SELECT project_id FROM ${table} WHERE id = ?`, id);
  if (!r) throw notFound();
  return r.project_id;
}

function notifyProjectOwner(db: Db, projectId: string, actorId: string, n: { type: string; title: string; body?: string; entity?: { type: string; id: string } }) {
  const owner = db.get<{ owner_id: string | null }>("SELECT owner_id FROM projects WHERE id = ?", projectId)?.owner_id;
  notify(db, { userId: owner, actorId, ...n, entity: n.entity ?? { type: "project", id: projectId }, link: `/projects/${projectId}` });
}

// ===================================================================== programmes
projectsRouter.get(
  "/programmes",
  h((req, res) => {
    const u = currentUser(req);
    const db = req.ctx.db;
    const pf = projectVisibleSql(u, "p");
    const rows = db.all<Record<string, unknown>>("SELECT g.*, o.name AS owner_name FROM programmes g LEFT JOIN users o ON o.id = g.owner_id ORDER BY g.name");
    const out = rows.map((g) => {
      const projects = db.all<{ status: string; health: string }>(`SELECT p.status, p.health FROM projects p WHERE p.programme_id = ? AND ${pf.sql}`, String(g.id), ...pf.params);
      const by = (k: "status" | "health") => projects.reduce<Record<string, number>>((a, p) => ((a[p[k]] = (a[p[k]] ?? 0) + 1), a), {});
      return { ...g, project_count: projects.length, by_status: by("status"), by_health: by("health") };
    });
    res.json({ items: out, can_manage: can(u, "programme.manage") });
  }),
);

const ProgrammeBody = z.object({ name: zTitle, description: zOptText(), owner_id: zOptId, status: z.enum(["active", "paused", "closed"]).optional() });

projectsRouter.post(
  "/programmes",
  h((req, res) => {
    const u = currentUser(req);
    requirePerm(u, "programme.manage");
    const db = req.ctx.db;
    const b = parse(ProgrammeBody, req.body);
    assertActiveUser(db, b.owner_id, "owner_id");
    const id = newId("prg");
    const now = nowIso();
    db.insert("programmes", { id, name: b.name, description: b.description ?? "", owner_id: b.owner_id ?? u.id, status: b.status ?? "active", created_at: now, updated_at: now });
    audit(db, req, "programme.create", { type: "programme", id }, { name: b.name });
    res.status(201).json(db.get("SELECT * FROM programmes WHERE id = ?", id));
  }),
);

projectsRouter.get(
  "/programmes/:id",
  h((req, res) => {
    const u = currentUser(req);
    const db = req.ctx.db;
    const g = db.get<Record<string, unknown>>("SELECT g.*, o.name AS owner_name FROM programmes g LEFT JOIN users o ON o.id = g.owner_id WHERE g.id = ?", req.params.id);
    if (!g) throw notFound("Programme not found.");
    const pf = projectVisibleSql(u, "p");
    const projects = db
      .all<Record<string, unknown>>(
        `SELECT p.id, p.name, p.code, p.status, p.health, p.priority, p.target_date, p.owner_id, o.name AS owner_name, p.progress_method
         FROM projects p LEFT JOIN users o ON o.id = p.owner_id WHERE p.programme_id = ? AND ${pf.sql} ORDER BY p.name`,
        req.params.id,
        ...pf.params,
      )
      .map((p) => ({ ...p, progress: projectProgress(db, String(p.id)) }) as Record<string, unknown>);
    const by = (k: string) => projects.reduce<Record<string, number>>((a, p) => ((a[String(p[k])] = (a[String(p[k])] ?? 0) + 1), a), {});
    res.json({ ...g, projects, by_status: by("status"), by_health: by("health"), can_manage: can(u, "programme.manage") || g.owner_id === u.id });
  }),
);

projectsRouter.patch(
  "/programmes/:id",
  h((req, res) => {
    const u = currentUser(req);
    const db = req.ctx.db;
    const g = db.get<{ owner_id: string | null }>("SELECT owner_id FROM programmes WHERE id = ?", req.params.id);
    if (!g) throw notFound("Programme not found.");
    if (!can(u, "programme.manage") && g.owner_id !== u.id) throw forbidden();
    const b = parse(ProgrammeBody.partial(), req.body);
    assertActiveUser(db, b.owner_id, "owner_id");
    db.update("programmes", req.params.id, { ...b, updated_at: nowIso() });
    audit(db, req, "programme.update", { type: "programme", id: req.params.id }, b);
    res.json(db.get("SELECT * FROM programmes WHERE id = ?", req.params.id));
  }),
);

// ===================================================================== projects: portfolio
const SORTS: Record<string, string> = {
  name: "p.name COLLATE NOCASE",
  target_date: "p.target_date IS NULL, p.target_date",
  start_date: "p.start_date IS NULL, p.start_date",
  status: "p.status",
  health: "CASE p.health WHEN 'blocked' THEN 0 WHEN 'at_risk' THEN 1 WHEN 'needs_attention' THEN 2 WHEN 'on_track' THEN 3 ELSE 4 END",
  priority: "CASE p.priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END",
  updated: "p.updated_at DESC",
};

projectsRouter.get(
  "/projects",
  h((req, res) => {
    const u = currentUser(req);
    const db = req.ctx.db;
    const q = req.query as Record<string, string | undefined>;
    const pf = projectVisibleSql(u, "p");
    const where = [pf.sql];
    const params: SQLInputValue[] = [...pf.params];
    for (const k of ["owner_id", "team_id", "programme_id"] as const) {
      if (q[k]) {
        where.push(`p.${k} = ?`);
        params.push(q[k]!);
      }
    }
    for (const k of ["status", "priority", "health"] as const) {
      if (q[k]) {
        const vals = q[k]!.split(",").filter(Boolean).slice(0, 10);
        where.push(`p.${k} IN (${vals.map(() => "?").join(",")})`);
        params.push(...vals);
      }
    }
    if (q.mine === "1") {
      where.push("(p.owner_id = ? OR EXISTS (SELECT 1 FROM project_members m WHERE m.project_id = p.id AND m.user_id = ?))");
      params.push(u.id, u.id);
    }
    if (q.active === "1") where.push("p.status NOT IN ('completed','cancelled')");
    if (q.q) {
      where.push("(p.name LIKE ? OR p.code LIKE ? OR p.description LIKE ?)");
      const like = `%${q.q.slice(0, 100)}%`;
      params.push(like, like, like);
    }
    if (q.from) {
      where.push("(p.target_date IS NULL OR p.target_date >= ?)");
      params.push(q.from);
    }
    if (q.to) {
      where.push("(p.start_date IS NULL OR p.start_date <= ?)");
      params.push(q.to);
    }
    const order = SORTS[q.sort ?? "name"] ?? SORTS.name;
    const { limit, offset } = pageParams(q, 100, 500);
    const total = db.get<{ n: number }>(`SELECT COUNT(*) n FROM projects p WHERE ${where.join(" AND ")}`, ...params)!.n;
    const rows = db.all<Record<string, unknown>>(
      `SELECT p.*, o.name AS owner_name, tm.name AS team_name, pr.name AS programme_name
       FROM projects p LEFT JOIN users o ON o.id = p.owner_id LEFT JOIN teams tm ON tm.id = p.team_id LEFT JOIN programmes pr ON pr.id = p.programme_id
       WHERE ${where.join(" AND ")} ORDER BY ${order}, p.name LIMIT ? OFFSET ?`,
      ...params,
      limit,
      offset,
    );
    let items = rows.map((p) => projectSummary(db, u, p));
    if (q.sort === "progress") items = items.sort((a, b) => ((b.progress as { value: number | null }).value ?? -1) - ((a.progress as { value: number | null }).value ?? -1));
    res.json({ items, total, can_create: can(u, "project.create") });
  }),
);

// ===================================================================== projects: create
projectsRouter.post(
  "/projects",
  h((req, res) => {
    const u = currentUser(req);
    requirePerm(u, "project.create");
    const db = req.ctx.db;
    const b = parse(ProjectCreate, req.body);
    const ownerId = b.owner_id ?? u.id;
    assertActiveUser(db, ownerId, "owner_id");
    assertExists(db, "programmes", b.programme_id, "programme_id");
    assertExists(db, "teams", b.team_id, "team_id");
    datesInOrder(b.start_date, b.target_date);
    for (const m of b.members) assertActiveUser(db, m.user_id, "members");
    if (b.code && db.get("SELECT 1 FROM projects WHERE code = ? COLLATE NOCASE", b.code)) throw conflict("Another project already uses that code.");
    const id = newId("prj");
    const now = nowIso();
    db.tx(() => {
      db.insert("projects", {
        id,
        code: b.code || null,
        name: b.name,
        description: b.description ?? "",
        purpose: b.purpose ?? "",
        objectives: b.objectives ?? "",
        intended_outcomes: b.intended_outcomes ?? "",
        scope: b.scope ?? "",
        stakeholders: b.stakeholders ?? "",
        reporting_requirements: b.reporting_requirements ?? "",
        category: b.category ?? "",
        programme_id: b.programme_id,
        owner_id: ownerId,
        team_id: b.team_id ?? u.team_id,
        status: b.status ?? "planning",
        health: b.health ?? "on_track",
        health_note: b.health_note ?? "",
        priority: b.priority ?? "normal",
        start_date: b.start_date,
        target_date: b.target_date,
        budget_amount: b.budget_amount ?? null,
        budget_currency: b.budget_currency ?? getSetting(db, "org.currency", "ZAR"),
        budget_notes: b.budget_notes ?? "",
        progress_method: b.progress_method ?? getSetting(db, "projects.default_progress_method", "milestones"),
        manual_progress: b.manual_progress ?? null,
        visibility: b.visibility ?? "organisation",
        drive_folder_url: b.drive_folder_url ?? "",
        created_by: u.id,
        created_at: now,
        updated_at: now,
      });
      db.insert("project_members", { project_id: id, user_id: ownerId, role: "owner", added_at: now });
      if (ownerId !== u.id) db.insert("project_members", { project_id: id, user_id: u.id, role: "manager", added_at: now });
      for (const m of b.members) {
        if (m.user_id === ownerId || m.user_id === u.id) continue;
        db.run("INSERT OR IGNORE INTO project_members (project_id, user_id, role, added_at) VALUES (?, ?, ?, ?)", id, m.user_id, m.role, now);
      }
      b.milestones.forEach((m, i) =>
        db.insert("milestones", { id: newId("mil"), project_id: id, title: m.title, target_date: m.target_date, owner_id: ownerId, sort_order: i + 1, created_at: now, updated_at: now }),
      );
      for (const d of b.deliverables) db.insert("deliverables", { id: newId("dlv"), project_id: id, name: d.name, due_date: d.due_date, owner_id: ownerId, created_at: now, updated_at: now });
      statusChange(db, u.id, "project", id, "status", null, b.status ?? "planning", "Project created");
    });
    audit(db, req, "project.create", { type: "project", id }, { name: b.name, owner_id: ownerId, visibility: b.visibility ?? "organisation" });
    activity(db, u, "project.created", { type: "project", id, label: b.name }, { projectId: id });
    notify(db, { userId: ownerId, actorId: u.id, type: "system", title: `${u.name} made you owner of project ${b.name}`, entity: { type: "project", id } });
    for (const m of b.members) notify(db, { userId: m.user_id, actorId: u.id, type: "system", title: `${u.name} added you to project ${b.name}`, entity: { type: "project", id } });
    res.status(201).json({ id });
  }),
);

// ===================================================================== projects: detail
projectsRouter.get(
  "/projects/:id",
  h((req, res) => {
    const u = currentUser(req);
    const db = req.ctx.db;
    const id = req.params.id;
    assertProjectView(db, u, id);
    const p = loadProject(db, id)!;
    const summary = projectSummary(db, u, p);
    const members = db.all("SELECT m.user_id, m.role, m.added_at, us.name, us.email, us.job_title FROM project_members m JOIN users us ON us.id = m.user_id WHERE m.project_id = ? ORDER BY CASE m.role WHEN 'owner' THEN 0 WHEN 'manager' THEN 1 WHEN 'member' THEN 2 ELSE 3 END, us.name", id);
    const milestones = db.all("SELECT m.*, us.name AS owner_name FROM milestones m LEFT JOIN users us ON us.id = m.owner_id WHERE m.project_id = ? ORDER BY m.target_date IS NULL, m.target_date, m.sort_order", id);
    const counts = db.get<Record<string, number>>(
      `SELECT (SELECT COUNT(*) FROM milestones WHERE project_id = ?1) AS milestones,
              (SELECT COUNT(*) FROM deliverables WHERE project_id = ?1) AS deliverables,
              (SELECT COUNT(*) FROM risks WHERE project_id = ?1 AND status NOT IN ('resolved','closed')) AS risks,
              (SELECT COUNT(*) FROM decisions WHERE project_id = ?1) AS decisions,
              (SELECT COUNT(*) FROM tasks WHERE project_id = ?1 AND is_personal = 0 AND status NOT IN ('cancelled')) AS tasks,
              (SELECT COUNT(*) FROM project_updates WHERE project_id = ?1) AS updates`,
      id,
    )!;
    // Related: opportunities via links; knowledge & lessons via project_id + links; learning records.
    const links = linkedRecords(db, u, "project", id);
    const kf = knowledgeVisibleSql(u, "k");
    const knowledge = db.all<Record<string, unknown>>(
      `SELECT k.id, k.title, k.item_type, k.category, k.summary, k.status FROM knowledge_items k WHERE k.project_id = ? AND ${kf.sql} ORDER BY k.updated_at DESC LIMIT 30`,
      id,
      ...kf.params,
    );
    for (const l of links.filter((x) => x.type === "knowledge")) {
      if (!knowledge.some((k) => k.id === l.id)) {
        const k = db.get<Record<string, unknown>>("SELECT id, title, item_type, category, summary, status FROM knowledge_items WHERE id = ?", l.id);
        if (k) knowledge.push(k);
      }
    }
    const lf = learningVisibleSql(u, "l");
    const learning = db.all(
      `SELECT l.id, l.title, l.record_type, l.what_learned, l.created_at, us.name AS contributor_name FROM learning_records l LEFT JOIN users us ON us.id = l.contributor_id WHERE l.project_id = ? AND ${lf.sql} ORDER BY l.created_at DESC LIMIT 20`,
      id,
      ...lf.params,
    );
    const opportunities = links
      .filter((l) => l.type === "opportunity")
      .map((l) => db.get<Record<string, unknown>>("SELECT id, name, stage, organisation, follow_up_date FROM opportunities WHERE id = ?", l.id))
      .filter(Boolean);
    const last_update = db.get("SELECT pu.*, us.name AS author_name FROM project_updates pu LEFT JOIN users us ON us.id = pu.author_id WHERE pu.project_id = ? ORDER BY pu.created_at DESC LIMIT 1", id) ?? null;
    res.json({
      ...summary,
      members,
      milestones,
      counts,
      health_suggestion: suggestHealth(db, id),
      last_update,
      related: { opportunities, knowledge, learning, other: links.filter((l) => !["knowledge", "opportunity"].includes(l.type)) },
      permissions: {
        can_manage: canManageProject(db, u, id),
        can_contribute: canContributeProject(db, u, id),
        can_view_budget: canSeeBudget(db, u, id),
        my_role: projectRole(db, u, id),
      },
    });
  }),
);

projectsRouter.patch(
  "/projects/:id",
  h((req, res) => {
    const u = currentUser(req);
    const db = req.ctx.db;
    const id = req.params.id;
    assertProjectManage(db, u, id);
    const b = parse(ProjectPatch, req.body);
    const cur = db.get<Record<string, unknown>>("SELECT * FROM projects WHERE id = ?", id)!;
    assertActiveUser(db, b.owner_id, "owner_id");
    assertExists(db, "programmes", b.programme_id, "programme_id");
    assertExists(db, "teams", b.team_id, "team_id");
    datesInOrder(b.start_date === undefined ? (cur.start_date as string | null) : b.start_date, b.target_date === undefined ? (cur.target_date as string | null) : b.target_date);
    if (b.code && db.get("SELECT 1 FROM projects WHERE code = ? COLLATE NOCASE AND id <> ?", b.code, id)) throw conflict("Another project already uses that code.");
    const { status_note, ...fields } = b;
    const patch: Record<string, unknown> = { ...fields, updated_at: nowIso() };
    // Fields set to undefined are skipped; keep nullable dates when explicitly provided.
    for (const k of ["start_date", "target_date", "programme_id", "team_id"] as const) if (!(k in (req.body ?? {}))) delete patch[k];
    if (!("code" in (req.body ?? {}))) delete patch.code;
    else patch.code = b.code || null;
    if (!("owner_id" in (req.body ?? {})) || !b.owner_id) delete patch.owner_id;
    if (!canSeeBudget(db, u, id)) {
      delete patch.budget_amount;
      delete patch.budget_notes;
    }
    const changes: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(patch)) if (k !== "updated_at" && v !== undefined && cur[k] !== v) changes[k] = { from: cur[k], to: v };
    if (b.status && b.status === "completed" && cur.status !== "completed") patch.completed_date = today(db);
    db.tx(() => {
      db.update("projects", id, patch);
      if (b.status && b.status !== cur.status) {
        statusChange(db, u.id, "project", id, "status", String(cur.status), b.status, status_note ?? "");
        activity(db, u, "project.status", { type: "project", id, label: String(cur.name) }, { projectId: id, detail: `Status: ${cur.status} → ${b.status}${status_note ? ` — ${status_note}` : ""}` });
      }
      if (b.health && b.health !== cur.health) {
        statusChange(db, u.id, "project", id, "health", String(cur.health), b.health, b.health_note ?? status_note ?? "");
        activity(db, u, "project.health", { type: "project", id, label: String(cur.name) }, { projectId: id, detail: `Health: ${cur.health} → ${b.health}` });
      }
      if (b.owner_id && b.owner_id !== cur.owner_id) {
        if (cur.owner_id) db.run("UPDATE project_members SET role = 'manager' WHERE project_id = ? AND user_id = ?", id, String(cur.owner_id));
        db.run("INSERT INTO project_members (project_id, user_id, role, added_at) VALUES (?, ?, 'owner', ?) ON CONFLICT(project_id, user_id) DO UPDATE SET role = 'owner'", id, b.owner_id, nowIso());
        notify(db, { userId: b.owner_id, actorId: u.id, type: "system", title: `${u.name} made you owner of project ${cur.name}`, entity: { type: "project", id } });
      }
    });
    audit(db, req, "project.update", { type: "project", id }, changes);
    res.json(projectSummary(db, u, loadProject(db, id)!));
  }),
);

projectsRouter.delete(
  "/projects/:id",
  h((req, res) => {
    const u = currentUser(req);
    const db = req.ctx.db;
    const id = req.params.id;
    assertProjectView(db, u, id);
    const p = db.get<{ owner_id: string; name: string }>("SELECT owner_id, name FROM projects WHERE id = ?", id)!;
    // Deleting is destructive; restrict to the owner. Most projects should be "cancelled" instead.
    if (p.owner_id !== u.id) throw forbidden("Only the project owner can delete a project. Consider setting its status to Cancelled instead.");
    db.run("DELETE FROM projects WHERE id = ?", id);
    audit(db, req, "project.delete", { type: "project", id }, { name: p.name });
    res.json({ ok: true });
  }),
);

// ---------------------------------------------------------------- members
projectsRouter.post(
  "/projects/:id/members",
  h((req, res) => {
    const u = currentUser(req);
    const db = req.ctx.db;
    const id = req.params.id;
    assertProjectManage(db, u, id);
    const b = parse(z.object({ user_id: z.string(), role: z.enum(MEMBER_ROLES).default("member") }), req.body);
    assertActiveUser(db, b.user_id, "user_id");
    if (db.get("SELECT 1 FROM project_members WHERE project_id = ? AND user_id = ?", id, b.user_id)) throw conflict("That person is already a member.");
    db.insert("project_members", { project_id: id, user_id: b.user_id, role: b.role, added_at: nowIso() });
    const pname = db.get<{ name: string }>("SELECT name FROM projects WHERE id = ?", id)!.name;
    audit(db, req, "project.member_add", { type: "project", id }, b);
    notify(db, { userId: b.user_id, actorId: u.id, type: "system", title: `${u.name} added you to project ${pname}`, entity: { type: "project", id } });
    res.status(201).json({ ok: true });
  }),
);

projectsRouter.patch(
  "/projects/:id/members/:userId",
  h((req, res) => {
    const u = currentUser(req);
    const db = req.ctx.db;
    const id = req.params.id;
    assertProjectManage(db, u, id);
    const b = parse(z.object({ role: z.enum(MEMBER_ROLES) }), req.body);
    const m = db.get<{ role: string }>("SELECT role FROM project_members WHERE project_id = ? AND user_id = ?", id, req.params.userId);
    if (!m) throw notFound("Member not found.");
    if (m.role === "owner") throw badRequest("The project owner's role cannot be changed here. Transfer ownership by changing the project owner.");
    db.run("UPDATE project_members SET role = ? WHERE project_id = ? AND user_id = ?", b.role, id, req.params.userId);
    audit(db, req, "project.member_role", { type: "project", id }, { user_id: req.params.userId, from: m.role, to: b.role });
    res.json({ ok: true });
  }),
);

projectsRouter.delete(
  "/projects/:id/members/:userId",
  h((req, res) => {
    const u = currentUser(req);
    const db = req.ctx.db;
    const id = req.params.id;
    const self = req.params.userId === u.id;
    assertProjectView(db, u, id);
    if (!self && !canManageProject(db, u, id)) throw forbidden("Only the project owner or a project manager can do that.");
    const m = db.get<{ role: string }>("SELECT role FROM project_members WHERE project_id = ? AND user_id = ?", id, req.params.userId);
    if (!m) throw notFound("Member not found.");
    const owners = db.get<{ n: number }>("SELECT COUNT(*) n FROM project_members WHERE project_id = ? AND role = 'owner'", id)!.n;
    const isOwner = m.role === "owner" || db.get("SELECT 1 FROM projects WHERE id = ? AND owner_id = ?", id, req.params.userId);
    if (isOwner && owners <= 1) throw badRequest("A project must keep its owner. Transfer ownership before removing this person.");
    db.run("DELETE FROM project_members WHERE project_id = ? AND user_id = ?", id, req.params.userId);
    audit(db, req, "project.member_remove", { type: "project", id }, { user_id: req.params.userId });
    res.json({ ok: true });
  }),
);

// ---------------------------------------------------------------- activity & history
projectsRouter.get(
  "/projects/:id/activity",
  h((req, res) => {
    const u = currentUser(req);
    const db = req.ctx.db;
    assertProjectView(db, u, req.params.id);
    const { limit, offset } = pageParams(req.query as Record<string, unknown>, 50, 200);
    const rows = db.all<Record<string, unknown>>(
      "SELECT a.*, us.name AS actor_name FROM activity a LEFT JOIN users us ON us.id = a.actor_id WHERE a.project_id = ? ORDER BY a.created_at DESC LIMIT ? OFFSET ?",
      req.params.id,
      limit * 2,
      offset,
    );
    // Never reveal labels of records (e.g. personal tasks, confidential meetings) the viewer cannot see.
    const visible = rows.filter((a) => a.entity_type === "project" || canViewEntity(db, u, String(a.entity_type), String(a.entity_id))).slice(0, limit);
    res.json(visible);
  }),
);

projectsRouter.get(
  "/projects/:id/history",
  h((req, res) => {
    const u = currentUser(req);
    const db = req.ctx.db;
    assertProjectView(db, u, req.params.id);
    res.json(db.all("SELECT s.*, us.name AS changed_by_name FROM status_history s LEFT JOIN users us ON us.id = s.changed_by WHERE s.entity_type = 'project' AND s.entity_id = ? ORDER BY s.changed_at DESC", req.params.id));
  }),
);

// ===================================================================== project updates
projectsRouter.get(
  "/projects/:id/updates",
  h((req, res) => {
    const u = currentUser(req);
    const db = req.ctx.db;
    assertProjectView(db, u, req.params.id);
    res.json(db.all("SELECT pu.*, us.name AS author_name FROM project_updates pu LEFT JOIN users us ON us.id = pu.author_id WHERE pu.project_id = ? ORDER BY pu.created_at DESC LIMIT 100", req.params.id));
  }),
);

projectsRouter.post(
  "/projects/:id/updates",
  h((req, res) => {
    const u = currentUser(req);
    const db = req.ctx.db;
    const id = req.params.id;
    assertProjectView(db, u, id);
    if (!canContributeProject(db, u, id)) throw forbidden("Only project members can post updates.");
    const b = parse(
      z.object({
        summary: z.string().trim().min(1, "Write a short summary.").max(3000),
        achievements: zOptText(3000),
        next_steps: zOptText(3000),
        blockers: zOptText(3000),
        health: z.enum(HEALTHS).optional().nullable(),
        progress: z.union([z.number().int().min(0).max(100), z.null()]).optional(),
        period_start: zOptDate,
        period_end: zOptDate,
      }),
      req.body,
    );
    datesInOrder(b.period_start, b.period_end, "period_end");
    const p = db.get<{ name: string; health: string; progress_method: string }>("SELECT name, health, progress_method FROM projects WHERE id = ?", id)!;
    const manager = canManageProject(db, u, id);
    const uid = newId("pup");
    db.tx(() => {
      db.insert("project_updates", {
        id: uid, project_id: id, author_id: u.id, summary: b.summary, achievements: b.achievements ?? "", next_steps: b.next_steps ?? "", blockers: b.blockers ?? "",
        health: b.health ?? null, progress: b.progress ?? null, period_start: b.period_start, period_end: b.period_end, created_at: nowIso(),
      });
      // Only managers' updates change the project's official health / manual progress.
      if (manager && b.health && b.health !== p.health) {
        db.update("projects", id, { health: b.health, updated_at: nowIso() });
        statusChange(db, u.id, "project", id, "health", p.health, b.health, "Set via project update");
      }
      if (manager && p.progress_method === "manual" && b.progress !== undefined && b.progress !== null) db.update("projects", id, { manual_progress: b.progress, updated_at: nowIso() });
      else db.update("projects", id, { updated_at: nowIso() });
    });
    activity(db, u, "project.update", { type: "project", id, label: p.name }, { projectId: id, detail: b.summary.slice(0, 300) });
    notifyProjectOwner(db, id, u.id, { type: "system", title: `${u.name} posted an update on ${p.name}`, body: b.summary.slice(0, 200) });
    res.status(201).json(db.get("SELECT * FROM project_updates WHERE id = ?", uid));
  }),
);

// ===================================================================== milestones
const MilestoneBody = z.object({
  title: zTitle,
  description: zOptText(),
  owner_id: zOptId,
  target_date: zOptDate,
  status: z.enum(MILESTONE_STATUSES).optional(),
  weight: z.number().int().min(1).max(100).optional(),
  notes: zOptText(),
  evidence_url: zUrl,
  sort_order: z.number().int().optional(),
});

projectsRouter.get(
  "/projects/:id/milestones",
  h((req, res) => {
    const u = currentUser(req);
    const db = req.ctx.db;
    assertProjectView(db, u, req.params.id);
    const rows = db.all<Record<string, unknown>>(
      `SELECT m.*, us.name AS owner_name,
        (SELECT COUNT(*) FROM deliverables d WHERE d.milestone_id = m.id) AS deliverable_count,
        (SELECT COUNT(*) FROM deliverables d WHERE d.milestone_id = m.id AND d.status IN ('approved','completed')) AS deliverables_done
       FROM milestones m LEFT JOIN users us ON us.id = m.owner_id WHERE m.project_id = ? ORDER BY m.target_date IS NULL, m.target_date, m.sort_order`,
      req.params.id,
    );
    const t = today(db);
    res.json(rows.map((m) => ({ ...m, overdue: ["not_started", "in_progress"].includes(String(m.status)) && !!m.target_date && String(m.target_date) < t })));
  }),
);

projectsRouter.post(
  "/projects/:id/milestones",
  h((req, res) => {
    const u = currentUser(req);
    const db = req.ctx.db;
    const pid = req.params.id;
    assertProjectManage(db, u, pid);
    const b = parse(MilestoneBody, req.body);
    assertActiveUser(db, b.owner_id, "owner_id");
    const id = newId("mil");
    const now = nowIso();
    const status = b.status ?? "not_started";
    db.insert("milestones", {
      id, project_id: pid, title: b.title, description: b.description ?? "", owner_id: b.owner_id ?? u.id, target_date: b.target_date, status,
      completed_date: status === "achieved" ? today(db) : null, weight: b.weight ?? 1, notes: b.notes ?? "", evidence_url: b.evidence_url ?? "",
      sort_order: b.sort_order ?? db.get<{ n: number }>("SELECT COUNT(*) n FROM milestones WHERE project_id = ?", pid)!.n + 1, created_at: now, updated_at: now,
    });
    activity(db, u, "milestone.updated", { type: "milestone", id, label: b.title }, { projectId: pid, detail: "Milestone added" });
    if (b.owner_id) notify(db, { userId: b.owner_id, actorId: u.id, type: "milestone_due", title: `You own milestone "${b.title}"`, entity: { type: "project", id: pid }, link: `/projects/${pid}?tab=milestones` });
    res.status(201).json(db.get("SELECT * FROM milestones WHERE id = ?", id));
  }),
);

projectsRouter.patch(
  "/milestones/:id",
  h((req, res) => {
    const u = currentUser(req);
    const db = req.ctx.db;
    const m = db.get<Record<string, unknown>>("SELECT * FROM milestones WHERE id = ?", req.params.id);
    if (!m) throw notFound("Milestone not found.");
    const pid = String(m.project_id);
    assertProjectView(db, u, pid);
    const manager = canManageProject(db, u, pid);
    const isOwner = m.owner_id === u.id;
    if (!manager && !isOwner) throw forbidden("Only the milestone owner or a project manager can update this milestone.");
    let b = parse(MilestoneBody.partial(), req.body);
    if (!manager) b = { status: b.status, notes: b.notes, evidence_url: b.evidence_url }; // owners update progress only
    assertActiveUser(db, b.owner_id, "owner_id");
    const patch: Record<string, unknown> = { ...b, updated_at: nowIso() };
    if (!("target_date" in (req.body ?? {})) || !manager) delete patch.target_date;
    if (!("owner_id" in (req.body ?? {})) || !b.owner_id) delete patch.owner_id;
    if (b.status && b.status !== m.status) {
      patch.completed_date = b.status === "achieved" ? today(db) : null;
      statusChange(db, u.id, "milestone", String(m.id), "status", String(m.status), b.status);
    }
    db.update("milestones", String(m.id), patch);
    if (b.status === "achieved" && m.status !== "achieved") {
      activity(db, u, "milestone.achieved", { type: "milestone", id: String(m.id), label: String(m.title) }, { projectId: pid });
      notifyProjectOwner(db, pid, u.id, { type: "milestone_due", title: `Milestone achieved: ${m.title}` });
    } else if (b.status && b.status !== m.status) {
      activity(db, u, "milestone.updated", { type: "milestone", id: String(m.id), label: String(m.title) }, { projectId: pid, detail: `Status: ${m.status} → ${b.status}` });
    }
    res.json(db.get("SELECT * FROM milestones WHERE id = ?", m.id as string));
  }),
);

projectsRouter.delete(
  "/milestones/:id",
  h((req, res) => {
    const u = currentUser(req);
    const db = req.ctx.db;
    const pid = projectIdOf(db, "milestones", req.params.id);
    assertProjectManage(db, u, pid);
    db.tx(() => {
      db.run("DELETE FROM dependencies WHERE (from_type = 'milestone' AND from_id = ?) OR (to_type = 'milestone' AND to_id = ?)", req.params.id, req.params.id);
      db.run("DELETE FROM milestones WHERE id = ?", req.params.id);
    });
    audit(db, req, "milestone.delete", { type: "milestone", id: req.params.id });
    res.json({ ok: true });
  }),
);

// ===================================================================== deliverables
const DeliverableBody = z.object({
  name: zTitle,
  description: zOptText(),
  milestone_id: zOptId,
  owner_id: zOptId,
  reviewer_id: zOptId,
  due_date: zOptDate,
  status: z.enum(DELIVERABLE_STATUSES).optional(),
  acceptance_criteria: zOptText(),
  weight: z.number().int().min(1).max(100).optional(),
});

function deliverableRows(db: Db, where: string, ...params: SQLInputValue[]) {
  const t = today(db);
  return db
    .all<Record<string, unknown>>(
      `SELECT d.*, o.name AS owner_name, r.name AS reviewer_name, m.title AS milestone_title,
        (SELECT COUNT(*) FROM tasks tk WHERE tk.deliverable_id = d.id AND tk.status NOT IN ('cancelled')) AS task_count,
        (SELECT COUNT(*) FROM tasks tk WHERE tk.deliverable_id = d.id AND tk.status = 'completed') AS tasks_done
       FROM deliverables d LEFT JOIN users o ON o.id = d.owner_id LEFT JOIN users r ON r.id = d.reviewer_id LEFT JOIN milestones m ON m.id = d.milestone_id
       WHERE ${where} ORDER BY d.due_date IS NULL, d.due_date, d.name`,
      ...params,
    )
    .map((d): Record<string, unknown> => ({ ...d, overdue: !["approved", "completed", "cancelled"].includes(String(d.status)) && !!d.due_date && String(d.due_date) < t }));
}

function assertMilestoneInProject(db: Db, milestoneId: string | null | undefined, pid: string) {
  if (milestoneId && !db.get("SELECT 1 FROM milestones WHERE id = ? AND project_id = ?", milestoneId, pid)) throw badRequest("That milestone belongs to another project.", { fields: { milestone_id: "Choose a milestone from this project." } });
}

projectsRouter.get(
  "/projects/:id/deliverables",
  h((req, res) => {
    const u = currentUser(req);
    const db = req.ctx.db;
    assertProjectView(db, u, req.params.id);
    res.json(deliverableRows(db, "d.project_id = ?", req.params.id));
  }),
);

projectsRouter.post(
  "/projects/:id/deliverables",
  h((req, res) => {
    const u = currentUser(req);
    const db = req.ctx.db;
    const pid = req.params.id;
    assertProjectManage(db, u, pid);
    const b = parse(DeliverableBody, req.body);
    assertActiveUser(db, b.owner_id, "owner_id");
    assertActiveUser(db, b.reviewer_id, "reviewer_id");
    assertMilestoneInProject(db, b.milestone_id, pid);
    const id = newId("dlv");
    const now = nowIso();
    db.insert("deliverables", {
      id, project_id: pid, milestone_id: b.milestone_id, name: b.name, description: b.description ?? "", owner_id: b.owner_id ?? u.id, reviewer_id: b.reviewer_id,
      due_date: b.due_date, status: b.status ?? "not_started", acceptance_criteria: b.acceptance_criteria ?? "", weight: b.weight ?? 1, created_at: now, updated_at: now,
    });
    activity(db, u, "deliverable.created", { type: "deliverable", id, label: b.name }, { projectId: pid });
    if (b.owner_id) notify(db, { userId: b.owner_id, actorId: u.id, type: "deliverable_due", title: `You are responsible for deliverable "${b.name}"`, entity: { type: "project", id: pid }, link: `/projects/${pid}?tab=deliverables` });
    res.status(201).json(deliverableRows(db, "d.id = ?", id)[0]);
  }),
);

projectsRouter.get(
  "/deliverables/:id",
  h((req, res) => {
    const u = currentUser(req);
    const db = req.ctx.db;
    const pid = projectIdOf(db, "deliverables", req.params.id);
    assertProjectView(db, u, pid);
    const d = deliverableRows(db, "d.id = ?", req.params.id)[0];
    const tasks = db
      .all<Record<string, unknown>>("SELECT t.id, t.ref, t.title, t.status, t.due_date, us.name AS assignee_name FROM tasks t LEFT JOIN users us ON us.id = t.assignee_id WHERE t.deliverable_id = ? ORDER BY t.due_date", req.params.id)
      .filter((t) => canViewTask(db, u, String(t.id)));
    const versions = db.all("SELECT v.*, us.name AS submitted_by_name FROM deliverable_versions v LEFT JOIN users us ON us.id = v.submitted_by WHERE v.deliverable_id = ? ORDER BY v.version DESC", req.params.id);
    res.json({ ...d, tasks, versions, can_manage: canManageProject(db, u, pid), can_review: d.reviewer_id === u.id || canManageProject(db, u, pid), can_submit: d.owner_id === u.id || canManageProject(db, u, pid) });
  }),
);

projectsRouter.patch(
  "/deliverables/:id",
  h((req, res) => {
    const u = currentUser(req);
    const db = req.ctx.db;
    const d = db.get<Record<string, unknown>>("SELECT * FROM deliverables WHERE id = ?", req.params.id);
    if (!d) throw notFound("Deliverable not found.");
    const pid = String(d.project_id);
    assertProjectView(db, u, pid);
    const manager = canManageProject(db, u, pid);
    if (!manager && d.owner_id !== u.id) throw forbidden("Only the deliverable owner or a project manager can edit this deliverable.");
    let b = parse(DeliverableBody.partial(), req.body);
    if (!manager) {
      // Owners can progress their own work but not approve it.
      if (b.status && !["not_started", "in_progress"].includes(b.status)) throw forbidden("Use Submit for review; approval is done by the reviewer.");
      b = { status: b.status, description: b.description };
    }
    assertActiveUser(db, b.owner_id, "owner_id");
    assertActiveUser(db, b.reviewer_id, "reviewer_id");
    assertMilestoneInProject(db, b.milestone_id, pid);
    const patch: Record<string, unknown> = { ...b, updated_at: nowIso() };
    for (const k of ["due_date", "milestone_id", "reviewer_id", "owner_id"]) if (!(k in (req.body ?? {})) || !manager) delete patch[k];
    if (b.status && b.status !== d.status) statusChange(db, u.id, "deliverable", String(d.id), "status", String(d.status), b.status);
    db.update("deliverables", String(d.id), patch);
    res.json(deliverableRows(db, "d.id = ?", String(d.id))[0]);
  }),
);

projectsRouter.delete(
  "/deliverables/:id",
  h((req, res) => {
    const u = currentUser(req);
    const db = req.ctx.db;
    const pid = projectIdOf(db, "deliverables", req.params.id);
    assertProjectManage(db, u, pid);
    db.tx(() => {
      db.run("DELETE FROM dependencies WHERE (from_type = 'deliverable' AND from_id = ?) OR (to_type = 'deliverable' AND to_id = ?)", req.params.id, req.params.id);
      db.run("DELETE FROM deliverables WHERE id = ?", req.params.id);
    });
    audit(db, req, "deliverable.delete", { type: "deliverable", id: req.params.id });
    res.json({ ok: true });
  }),
);

projectsRouter.post(
  "/deliverables/:id/submit",
  h((req, res) => {
    const u = currentUser(req);
    const db = req.ctx.db;
    const d = db.get<Record<string, unknown>>("SELECT * FROM deliverables WHERE id = ?", req.params.id);
    if (!d) throw notFound("Deliverable not found.");
    const pid = String(d.project_id);
    assertProjectView(db, u, pid);
    if (d.owner_id !== u.id && !canManageProject(db, u, pid)) throw forbidden("Only the deliverable owner or a project manager can submit it.");
    if (["approved", "completed", "cancelled"].includes(String(d.status))) throw badRequest("This deliverable is already closed.");
    if (["submitted", "under_review"].includes(String(d.status))) throw badRequest("This deliverable is already awaiting review.");
    const b = parse(z.object({ submission_url: zUrl, note: zOptText(3000) }), req.body);
    if (!b.submission_url && !d.submission_url && !b.note) throw badRequest("Add a link to the work or a submission note.", { fields: { submission_url: "Add a link or a note." } });
    const prev = db.get<{ n: number }>("SELECT COUNT(*) n FROM deliverable_versions WHERE deliverable_id = ?", String(d.id))!.n;
    const version = prev === 0 ? Number(d.version) || 1 : Number(d.version) + 1;
    const now = nowIso();
    db.tx(() => {
      db.insert("deliverable_versions", { id: newId("dvv"), deliverable_id: String(d.id), version, submission_url: b.submission_url || String(d.submission_url ?? ""), note: b.note ?? "", submitted_by: u.id, submitted_at: now });
      db.update("deliverables", String(d.id), { status: "submitted", version, submission_url: b.submission_url || d.submission_url, submission_note: b.note ?? "", review_note: "", updated_at: now });
      statusChange(db, u.id, "deliverable", String(d.id), "status", String(d.status), "submitted", `Version ${version}`);
    });
    activity(db, u, "deliverable.submitted", { type: "deliverable", id: String(d.id), label: String(d.name) }, { projectId: pid, detail: `Version ${version}` });
    const reviewer = (d.reviewer_id as string | null) ?? db.get<{ owner_id: string }>("SELECT owner_id FROM projects WHERE id = ?", pid)!.owner_id;
    notify(db, { userId: reviewer, actorId: u.id, type: "deliverable_submitted", title: `${u.name} submitted "${d.name}" (v${version}) for review`, entity: { type: "project", id: pid }, link: `/projects/${pid}?tab=deliverables` });
    res.json(deliverableRows(db, "d.id = ?", String(d.id))[0]);
  }),
);

projectsRouter.post(
  "/deliverables/:id/review",
  h((req, res) => {
    const u = currentUser(req);
    const db = req.ctx.db;
    const d = db.get<Record<string, unknown>>("SELECT * FROM deliverables WHERE id = ?", req.params.id);
    if (!d) throw notFound("Deliverable not found.");
    const pid = String(d.project_id);
    assertProjectView(db, u, pid);
    if (d.reviewer_id !== u.id && !canManageProject(db, u, pid)) throw forbidden("Only the reviewer or a project manager can review this deliverable.");
    if (!["submitted", "under_review"].includes(String(d.status))) throw badRequest("This deliverable is not awaiting review.");
    const b = parse(z.object({ decision: z.enum(["approve", "changes", "start_review"]), note: zOptText(3000) }), req.body);
    if (b.decision === "changes" && !b.note?.trim()) throw badRequest("Explain what needs to change.", { fields: { note: "Explain what needs to change." } });
    const to = b.decision === "approve" ? "approved" : b.decision === "changes" ? "changes_requested" : "under_review";
    db.tx(() => {
      db.update("deliverables", String(d.id), { status: to, review_note: b.note ?? "", updated_at: nowIso() });
      statusChange(db, u.id, "deliverable", String(d.id), "status", String(d.status), to, b.note ?? "");
      if (b.note) db.insert("comments", { id: newId("cmt"), entity_type: "deliverable", entity_id: String(d.id), author_id: u.id, body: b.note, kind: "review_feedback", created_at: nowIso() });
    });
    if (b.decision === "approve") {
      activity(db, u, "deliverable.approved", { type: "deliverable", id: String(d.id), label: String(d.name) }, { projectId: pid, detail: `Version ${d.version}` });
      notify(db, { userId: d.owner_id as string, actorId: u.id, type: "task_completed", title: `"${d.name}" was approved`, entity: { type: "project", id: pid }, link: `/projects/${pid}?tab=deliverables` });
    } else if (b.decision === "changes") {
      activity(db, u, "deliverable.changes_requested", { type: "deliverable", id: String(d.id), label: String(d.name) }, { projectId: pid, detail: b.note });
      notify(db, { userId: d.owner_id as string, actorId: u.id, type: "changes_requested", title: `Changes requested on "${d.name}"`, body: b.note, entity: { type: "project", id: pid }, link: `/projects/${pid}?tab=deliverables` });
    }
    audit(db, req, "deliverable.review", { type: "deliverable", id: String(d.id) }, { decision: b.decision });
    res.json(deliverableRows(db, "d.id = ?", String(d.id))[0]);
  }),
);

projectsRouter.get(
  "/deliverables/:id/versions",
  h((req, res) => {
    const u = currentUser(req);
    const db = req.ctx.db;
    const pid = projectIdOf(db, "deliverables", req.params.id);
    assertProjectView(db, u, pid);
    res.json(db.all("SELECT v.*, us.name AS submitted_by_name FROM deliverable_versions v LEFT JOIN users us ON us.id = v.submitted_by WHERE v.deliverable_id = ? ORDER BY v.version DESC", req.params.id));
  }),
);

// ===================================================================== risks & issues
const RiskBody = z.object({
  type: z.enum(RISK_TYPES).default("risk"),
  title: zTitle,
  description: zOptText(),
  severity: z.enum(SEVERITIES).default("medium"),
  likelihood: z.union([z.enum(["low", "medium", "high"]), z.literal(""), z.null()]).optional().transform((v) => v || null),
  impact: zOptText(2000),
  owner_id: zOptId,
  identified_date: zOptDate,
  mitigation: zOptText(),
  action_plan: zOptText(),
  status: z.enum(RISK_STATUSES).optional(),
  review_date: zOptDate,
});

projectsRouter.get(
  "/projects/:id/risks",
  h((req, res) => {
    const u = currentUser(req);
    const db = req.ctx.db;
    assertProjectView(db, u, req.params.id);
    res.json(
      db.all(
        `SELECT r.*, o.name AS owner_name, c.name AS created_by_name FROM risks r LEFT JOIN users o ON o.id = r.owner_id LEFT JOIN users c ON c.id = r.created_by
         WHERE r.project_id = ? ORDER BY CASE r.status WHEN 'open' THEN 0 WHEN 'mitigating' THEN 1 WHEN 'monitoring' THEN 2 ELSE 3 END,
           CASE r.severity WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END, r.created_at DESC`,
        req.params.id,
      ),
    );
  }),
);

projectsRouter.post(
  "/projects/:id/risks",
  h((req, res) => {
    const u = currentUser(req);
    const db = req.ctx.db;
    const pid = req.params.id;
    assertProjectView(db, u, pid);
    if (!canContributeProject(db, u, pid)) throw forbidden("Only project members can add to the risk register.");
    const b = parse(RiskBody, req.body);
    assertActiveUser(db, b.owner_id, "owner_id");
    const id = newId("rsk");
    const now = nowIso();
    db.insert("risks", {
      id, project_id: pid, type: b.type, title: b.title, description: b.description ?? "", severity: b.severity, likelihood: b.type === "risk" ? b.likelihood : null,
      impact: b.impact ?? "", owner_id: b.owner_id ?? u.id, identified_date: b.identified_date ?? today(db), mitigation: b.mitigation ?? "", action_plan: b.action_plan ?? "",
      status: b.status ?? "open", review_date: b.review_date, created_by: u.id, created_at: now, updated_at: now,
    });
    activity(db, u, "risk.identified", { type: "risk", id, label: b.title }, { projectId: pid, detail: `${b.type} · ${b.severity}` });
    if (["high", "critical"].includes(b.severity) || b.type === "blocker") {
      notifyProjectOwner(db, pid, u.id, { type: "risk_identified", title: `${b.severity === "critical" ? "Critical" : b.type === "blocker" ? "Blocker" : "High"} ${b.type} identified: ${b.title}` });
    }
    if (b.owner_id && b.owner_id !== u.id) notify(db, { userId: b.owner_id, actorId: u.id, type: "risk_identified", title: `You were made owner of ${b.type} "${b.title}"`, entity: { type: "project", id: pid }, link: `/projects/${pid}?tab=risks` });
    res.status(201).json(db.get("SELECT * FROM risks WHERE id = ?", id));
  }),
);

projectsRouter.patch(
  "/risks/:id",
  h((req, res) => {
    const u = currentUser(req);
    const db = req.ctx.db;
    const r = db.get<Record<string, unknown>>("SELECT * FROM risks WHERE id = ?", req.params.id);
    if (!r) throw notFound("Risk not found.");
    const pid = String(r.project_id);
    assertProjectView(db, u, pid);
    if (!canManageProject(db, u, pid) && r.owner_id !== u.id && r.created_by !== u.id) throw forbidden("Only the risk owner, its author or a project manager can update it.");
    const b = parse(RiskBody.partial(), req.body);
    assertActiveUser(db, b.owner_id, "owner_id");
    const patch: Record<string, unknown> = { ...b, updated_at: nowIso() };
    for (const k of ["likelihood", "review_date", "identified_date", "owner_id"]) if (!(k in (req.body ?? {}))) delete patch[k];
    if (patch.owner_id === null) delete patch.owner_id;
    if (patch.identified_date === null) delete patch.identified_date;
    if (b.status && b.status !== r.status) statusChange(db, u.id, "risk", String(r.id), "status", String(r.status), b.status);
    db.update("risks", String(r.id), patch);
    if (b.severity && ["high", "critical"].includes(b.severity) && !["high", "critical"].includes(String(r.severity))) {
      notifyProjectOwner(db, pid, u.id, { type: "risk_identified", title: `Risk escalated to ${b.severity}: ${r.title}` });
    }
    res.json(db.get("SELECT * FROM risks WHERE id = ?", String(r.id)));
  }),
);

projectsRouter.delete(
  "/risks/:id",
  h((req, res) => {
    const u = currentUser(req);
    const db = req.ctx.db;
    const pid = projectIdOf(db, "risks", req.params.id);
    assertProjectManage(db, u, pid);
    db.run("DELETE FROM risks WHERE id = ?", req.params.id);
    audit(db, req, "risk.delete", { type: "risk", id: req.params.id });
    res.json({ ok: true });
  }),
);

// ===================================================================== decisions (global log)
const DecisionBody = z.object({
  title: zTitle,
  description: zOptText(),
  context: zOptText(),
  consequences: zOptText(),
  project_id: zOptId,
  meeting_id: zOptId,
  decision_maker_id: zOptId,
  decision_date: zOptDate,
  status: z.enum(DECISION_STATUSES).optional(),
  requires_management: z.boolean().optional(),
});

function decisionRows(db: Db, u: AuthUser, extraWhere: string[], extraParams: SQLInputValue[], limit = 200, offset = 0) {
  const f = decisionVisibleSql(u, "d");
  return db.all<Record<string, unknown>>(
    `SELECT d.*, dm.name AS decision_maker_name, cb.name AS created_by_name, p.name AS project_name, m.title AS meeting_title
     FROM decisions d LEFT JOIN users dm ON dm.id = d.decision_maker_id LEFT JOIN users cb ON cb.id = d.created_by
       LEFT JOIN projects p ON p.id = d.project_id LEFT JOIN meetings m ON m.id = d.meeting_id
     WHERE ${[f.sql, ...extraWhere].join(" AND ")}
     ORDER BY CASE d.status WHEN 'pending_approval' THEN 0 WHEN 'proposed' THEN 1 ELSE 2 END, COALESCE(d.decision_date, substr(d.created_at, 1, 10)) DESC LIMIT ? OFFSET ?`,
    ...f.params,
    ...extraParams,
    limit,
    offset,
  ).map((d) => ({
    ...d,
    // Meeting title only if the viewer can see that meeting.
    meeting_title: d.meeting_id && canViewMeeting(db, u, String(d.meeting_id)) ? d.meeting_title : null,
  }));
}

function canEditDecision(db: Db, u: AuthUser, d: Record<string, unknown>) {
  return d.created_by === u.id || d.decision_maker_id === u.id || (!!d.project_id && canManageProject(db, u, String(d.project_id)));
}

projectsRouter.get(
  "/decisions",
  h((req, res) => {
    const u = currentUser(req);
    const db = req.ctx.db;
    const q = req.query as Record<string, string | undefined>;
    const where: string[] = [];
    const params: SQLInputValue[] = [];
    if (q.project_id) { where.push("d.project_id = ?"); params.push(q.project_id); }
    if (q.meeting_id) { where.push("d.meeting_id = ?"); params.push(q.meeting_id); }
    if (q.status) {
      const vals = q.status.split(",").filter(Boolean).slice(0, 10);
      where.push(`d.status IN (${vals.map(() => "?").join(",")})`);
      params.push(...vals);
    }
    if (q.requires_management === "1") where.push("d.requires_management = 1");
    if (q.q) {
      where.push("(d.title LIKE ? OR d.description LIKE ? OR d.context LIKE ?)");
      const like = `%${q.q.slice(0, 100)}%`;
      params.push(like, like, like);
    }
    const { limit, offset } = pageParams(q, 100, 500);
    const items = decisionRows(db, u, where, params, limit, offset).map((d) => ({ ...d, can_edit: canEditDecision(db, u, d) }));
    res.json({ items, can_approve: can(u, "decision.approve") });
  }),
);

projectsRouter.post(
  "/decisions",
  h((req, res) => {
    const u = currentUser(req);
    const db = req.ctx.db;
    const b = parse(DecisionBody, req.body);
    if (b.project_id) {
      assertProjectView(db, u, b.project_id);
      if (!canContributeProject(db, u, b.project_id)) throw forbidden("Only project members can record decisions for this project.");
    }
    if (b.meeting_id && !canViewMeeting(db, u, b.meeting_id)) throw notFound("Meeting not found.");
    assertActiveUser(db, b.decision_maker_id, "decision_maker_id");
    const status = b.status ?? (b.requires_management ? "pending_approval" : "made");
    if (["approved", "rejected"].includes(status) && !can(u, "decision.approve")) throw forbidden("Only users who can approve decisions may record an approved/rejected decision.");
    const id = newId("dec");
    const now = nowIso();
    db.insert("decisions", {
      id, title: b.title, description: b.description ?? "", context: b.context ?? "", consequences: b.consequences ?? "", project_id: b.project_id, meeting_id: b.meeting_id,
      decision_maker_id: b.decision_maker_id ?? (status === "made" ? u.id : null), decision_date: b.decision_date ?? (status === "made" ? today(db) : null), status,
      requires_management: b.requires_management ? 1 : 0, created_by: u.id, created_at: now, updated_at: now,
    });
    activity(db, u, "decision.recorded", { type: "decision", id, label: b.title }, { projectId: b.project_id });
    if (status === "pending_approval") {
      // Notify management approvers (users whose role grants decision.approve).
      const approvers = db.all<{ id: string }>("SELECT u.id FROM users u JOIN roles r ON r.key = u.role_key WHERE u.active = 1 AND r.permissions LIKE '%\"decision.approve\"%'");
      for (const a of approvers) notify(db, { userId: a.id, actorId: u.id, type: "decision_required", title: `Decision awaiting approval: ${b.title}`, link: "/management/decisions", dedupeKey: `decision:${id}` });
    }
    audit(db, req, "decision.create", { type: "decision", id }, { status, requires_management: !!b.requires_management });
    res.status(201).json(decisionRows(db, u, ["d.id = ?"], [id])[0]);
  }),
);

projectsRouter.patch(
  "/decisions/:id",
  h((req, res) => {
    const u = currentUser(req);
    const db = req.ctx.db;
    const d = db.get<Record<string, unknown>>("SELECT * FROM decisions WHERE id = ?", req.params.id);
    if (!d || !canViewEntity(db, u, "decision", req.params.id)) throw notFound("Decision not found.");
    if (!canEditDecision(db, u, d)) throw forbidden("Only the decision's author, decision maker or a project manager can edit it.");
    const b = parse(DecisionBody.partial(), req.body);
    if (b.status && ["approved", "rejected"].includes(b.status) && b.status !== d.status) throw forbidden("Use Approve or Reject to change approval status.");
    if (b.project_id && b.project_id !== d.project_id && !canContributeProject(db, u, b.project_id)) throw forbidden();
    assertActiveUser(db, b.decision_maker_id, "decision_maker_id");
    const patch: Record<string, unknown> = { ...b, requires_management: b.requires_management === undefined ? undefined : b.requires_management ? 1 : 0, updated_at: nowIso() };
    for (const k of ["project_id", "meeting_id", "decision_maker_id", "decision_date"]) if (!(k in (req.body ?? {}))) delete patch[k];
    if (b.status && b.status !== d.status) statusChange(db, u.id, "decision", String(d.id), "status", String(d.status), b.status);
    db.update("decisions", String(d.id), patch);
    audit(db, req, "decision.update", { type: "decision", id: String(d.id) }, b);
    res.json(decisionRows(db, u, ["d.id = ?"], [String(d.id)])[0]);
  }),
);

for (const action of ["approve", "reject"] as const) {
  projectsRouter.post(
    `/decisions/:id/${action}`,
    h((req, res) => {
      const u = currentUser(req);
      requirePerm(u, "decision.approve");
      const db = req.ctx.db;
      const d = db.get<Record<string, unknown>>("SELECT * FROM decisions WHERE id = ?", req.params.id);
      if (!d || !canViewEntity(db, u, "decision", req.params.id)) throw notFound("Decision not found.");
      if (["approved", "rejected"].includes(String(d.status))) throw badRequest(`This decision has already been ${d.status}.`);
      const b = parse(z.object({ note: zOptText(2000) }), req.body ?? {});
      const to = action === "approve" ? "approved" : "rejected";
      db.update("decisions", String(d.id), { status: to, decision_maker_id: u.id, decision_date: today(db), consequences: b.note ? [d.consequences, `${action === "approve" ? "Approval" : "Rejection"} note: ${b.note}`].filter(Boolean).join("\n") : undefined, updated_at: nowIso() });
      statusChange(db, u.id, "decision", String(d.id), "status", String(d.status), to, b.note ?? "");
      activity(db, u, `decision.${to}`, { type: "decision", id: String(d.id), label: String(d.title) }, { projectId: (d.project_id as string) ?? null, detail: b.note });
      notify(db, { userId: d.created_by as string, actorId: u.id, type: "decision_required", title: `Decision ${to}: ${d.title}`, body: b.note, link: d.project_id ? `/projects/${d.project_id}?tab=decisions` : "/management/decisions" });
      audit(db, req, `decision.${action}`, { type: "decision", id: String(d.id) }, { note: b.note ?? "" });
      res.json(decisionRows(db, u, ["d.id = ?"], [String(d.id)])[0]);
    }),
  );
}

// ===================================================================== dependencies
interface DepItem { type: string; id: string; label: string; status: string; due: string | null; done: boolean; project_id: string | null }

function depItem(db: Db, type: string, id: string): DepItem | null {
  switch (type) {
    case "milestone": {
      const r = db.get<{ title: string; status: string; target_date: string | null; project_id: string }>("SELECT title, status, target_date, project_id FROM milestones WHERE id = ?", id);
      return r ? { type, id, label: r.title, status: r.status, due: r.target_date, done: ["achieved", "cancelled"].includes(r.status), project_id: r.project_id } : null;
    }
    case "deliverable": {
      const r = db.get<{ name: string; status: string; due_date: string | null; project_id: string }>("SELECT name, status, due_date, project_id FROM deliverables WHERE id = ?", id);
      return r ? { type, id, label: r.name, status: r.status, due: r.due_date, done: ["approved", "completed", "cancelled"].includes(r.status), project_id: r.project_id } : null;
    }
    case "task": {
      const r = db.get<{ title: string; status: string; due_date: string | null; project_id: string | null }>("SELECT title, status, due_date, project_id FROM tasks WHERE id = ?", id);
      return r ? { type, id, label: r.title, status: r.status, due: r.due_date, done: ["completed", "cancelled"].includes(r.status), project_id: r.project_id } : null;
    }
    case "project": {
      const r = db.get<{ name: string; status: string; target_date: string | null }>("SELECT name, status, target_date FROM projects WHERE id = ?", id);
      return r ? { type, id, label: r.name, status: r.status, due: r.target_date, done: ["completed", "cancelled"].includes(r.status), project_id: id } : null;
    }
  }
  return null;
}

interface DepEdge { id: string; from_type: string; from_id: string; to_type: string; to_id: string; note: string; created_by: string | null; created_at: string }

function resolveEdges(db: Db, u: AuthUser, edges: DepEdge[]) {
  const t = today(db);
  const out = [];
  for (const e of edges) {
    if (!canViewEntity(db, u, e.from_type, e.from_id) || !canViewEntity(db, u, e.to_type, e.to_id)) continue;
    const from = depItem(db, e.from_type, e.from_id);
    const to = depItem(db, e.to_type, e.to_id);
    if (!from || !to) continue;
    const delayed = !to.done && !!to.due && to.due < t;
    out.push({ ...e, from, to, blocking: !to.done, delayed });
  }
  return out;
}

function canEditDependencyFrom(db: Db, u: AuthUser, type: string, id: string): boolean {
  const item = depItem(db, type, id);
  if (!item) return false;
  if (type === "task") {
    const t = db.get<{ id: string; assignee_id: string | null; creator_id: string | null; reviewer_id: string | null; project_id: string | null }>("SELECT id, assignee_id, creator_id, reviewer_id, project_id FROM tasks WHERE id = ?", id)!;
    return canViewTask(db, u, id) && canWorkTask(db, u, t);
  }
  return !!item.project_id && canContributeProject(db, u, item.project_id);
}

projectsRouter.get(
  "/dependencies",
  h((req, res) => {
    const u = currentUser(req);
    const db = req.ctx.db;
    const type = String(req.query.entity_type ?? "");
    const id = String(req.query.entity_id ?? "");
    if (!DEP_TYPES.includes(type as (typeof DEP_TYPES)[number]) || !canViewEntity(db, u, type, id)) throw notFound("Record not found.");
    const edges = db.all<DepEdge>("SELECT * FROM dependencies WHERE (from_type = ? AND from_id = ?) OR (to_type = ? AND to_id = ?) ORDER BY created_at", type, id, type, id);
    const resolved = resolveEdges(db, u, edges);
    res.json({
      depends_on: resolved.filter((e) => e.from_type === type && e.from_id === id),
      required_by: resolved.filter((e) => e.to_type === type && e.to_id === id),
    });
  }),
);

projectsRouter.post(
  "/dependencies",
  h((req, res) => {
    const u = currentUser(req);
    const db = req.ctx.db;
    const b = parse(z.object({ from_type: z.enum(DEP_TYPES), from_id: z.string(), to_type: z.enum(DEP_TYPES), to_id: z.string(), note: zOptText(500) }), req.body);
    if (b.from_type === b.to_type && b.from_id === b.to_id) throw badRequest("An item cannot depend on itself.");
    if (!canViewEntity(db, u, b.from_type, b.from_id) || !canViewEntity(db, u, b.to_type, b.to_id)) throw notFound("Record not found.");
    if (!depItem(db, b.from_type, b.from_id) || !depItem(db, b.to_type, b.to_id)) throw notFound("Record not found.");
    if (!canEditDependencyFrom(db, u, b.from_type, b.from_id)) throw forbidden("You can only add dependencies to items you work on.");
    // Reject direct cycles and longer cycles (walk from `to` following its own dependencies).
    const seen = new Set<string>();
    const stack = [`${b.to_type}:${b.to_id}`];
    while (stack.length) {
      const k = stack.pop()!;
      if (k === `${b.from_type}:${b.from_id}`) throw badRequest("That would create a circular dependency.");
      if (seen.has(k) || seen.size > 500) continue;
      seen.add(k);
      const [t, i] = k.split(":");
      for (const e of db.all<{ to_type: string; to_id: string }>("SELECT to_type, to_id FROM dependencies WHERE from_type = ? AND from_id = ?", t, i)) stack.push(`${e.to_type}:${e.to_id}`);
    }
    if (db.get("SELECT 1 FROM dependencies WHERE from_type = ? AND from_id = ? AND to_type = ? AND to_id = ?", b.from_type, b.from_id, b.to_type, b.to_id)) throw conflict("That dependency already exists.");
    const id = newId("dep");
    db.insert("dependencies", { id, ...b, note: b.note ?? "", created_by: u.id, created_at: nowIso() });
    const from = depItem(db, b.from_type, b.from_id)!;
    const to = depItem(db, b.to_type, b.to_id)!;
    activity(db, u, "dependency.added", { type: b.from_type, id: b.from_id, label: from.label }, { projectId: from.project_id, detail: `Depends on: ${to.label}` });
    res.status(201).json(resolveEdges(db, u, [db.get<DepEdge>("SELECT * FROM dependencies WHERE id = ?", id)!])[0]);
  }),
);

projectsRouter.delete(
  "/dependencies/:id",
  h((req, res) => {
    const u = currentUser(req);
    const db = req.ctx.db;
    const e = db.get<DepEdge>("SELECT * FROM dependencies WHERE id = ?", req.params.id);
    if (!e || !canViewEntity(db, u, e.from_type, e.from_id)) throw notFound();
    const item = depItem(db, e.from_type, e.from_id);
    const manager = !!item?.project_id && canManageProject(db, u, item.project_id);
    if (e.created_by !== u.id && !manager && !canEditDependencyFrom(db, u, e.from_type, e.from_id)) throw forbidden();
    db.run("DELETE FROM dependencies WHERE id = ?", e.id);
    res.json({ ok: true });
  }),
);

projectsRouter.get(
  "/projects/:id/dependencies",
  h((req, res) => {
    const u = currentUser(req);
    const db = req.ctx.db;
    const pid = req.params.id;
    assertProjectView(db, u, pid);
    const inProject = (side: "from" | "to") =>
      `(${side}_type = 'project' AND ${side}_id = ?1) OR (${side}_type = 'milestone' AND ${side}_id IN (SELECT id FROM milestones WHERE project_id = ?1))
       OR (${side}_type = 'deliverable' AND ${side}_id IN (SELECT id FROM deliverables WHERE project_id = ?1)) OR (${side}_type = 'task' AND ${side}_id IN (SELECT id FROM tasks WHERE project_id = ?1))`;
    const edges = db.all<DepEdge>(`SELECT * FROM dependencies WHERE ${inProject("from")} OR ${inProject("to")} ORDER BY created_at`, pid);
    const resolved = resolveEdges(db, u, edges);
    // Affected work: items (not yet done) waiting on something that is late or still open past its date.
    const affected = resolved
      .filter((e) => e.delayed && !e.from.done)
      .map((e) => ({
        item: e.from,
        blocked_by: e.to,
        reason: `${e.to.label} (${e.to.type}) was due ${e.to.due} and is still ${e.to.status.replace(/_/g, " ")}.`,
      }));
    res.json({ edges: resolved, affected });
  }),
);

// ===================================================================== project report
projectsRouter.post(
  "/projects/:id/report",
  h((req, res) => {
    const u = currentUser(req);
    const db = req.ctx.db;
    const pid = req.params.id;
    assertProjectView(db, u, pid);
    if (!canContributeProject(db, u, pid)) throw forbidden("Only project members can generate a project report.");
    const p = loadProject(db, pid)!;
    const t = today(db);
    const progress = projectProgress(db, pid);
    const health = suggestHealth(db, pid, t);
    const tpl = db.get<{ id: string; sections: string }>("SELECT id, sections FROM report_templates WHERE report_type = 'project_report' AND active = 1 ORDER BY is_default DESC LIMIT 1");
    const enabled = new Map<string, string>();
    try {
      for (const s of JSON.parse(tpl?.sections ?? "[]") as { key: string; title: string; enabled: boolean }[]) if (s.enabled) enabled.set(s.key, s.title);
    } catch {
      /* fall back to defaults */
    }
    if (!enabled.size) for (const [k, v] of [["overview", "Overview"], ["progress", "Progress"], ["milestones", "Milestones"], ["deliverables", "Deliverables"], ["risks", "Risks and issues"], ["decisions", "Decisions"], ["next_steps", "Next steps"]]) enabled.set(k, v);

    const milestones = db.all<{ id: string; title: string; status: string; target_date: string | null; completed_date: string | null }>("SELECT id, title, status, target_date, completed_date FROM milestones WHERE project_id = ? ORDER BY target_date IS NULL, target_date", pid);
    const deliverables = db.all<{ id: string; name: string; status: string; due_date: string | null }>("SELECT id, name, status, due_date FROM deliverables WHERE project_id = ? ORDER BY due_date IS NULL, due_date", pid);
    const risks = db.all<{ id: string; title: string; type: string; severity: string; status: string; mitigation: string }>("SELECT id, title, type, severity, status, mitigation FROM risks WHERE project_id = ? AND status IN ('open','mitigating','monitoring') ORDER BY CASE severity WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END", pid);
    const decisions = decisionRows(db, u, ["d.project_id = ?"], [pid], 20) as unknown as { id: string; title: string; status: string; decision_date: string | null }[];
    const lastUpdate = db.get<{ next_steps: string; summary: string; created_at: string }>("SELECT next_steps, summary, created_at FROM project_updates WHERE project_id = ? ORDER BY created_at DESC LIMIT 1", pid);
    const upcoming = milestones.filter((m) => ["not_started", "in_progress"].includes(m.status)).slice(0, 3);
    const label = (s: string) => s.replace(/_/g, " ");

    const sections: { key: string; title: string; body?: string; items?: string[]; sources?: { type: string; id: string; label: string }[] }[] = [];
    const add = (key: string, s: { body?: string; items?: string[]; sources?: { type: string; id: string; label: string }[] }) => {
      if (enabled.has(key)) sections.push({ key, title: enabled.get(key)!, ...s });
    };
    add("overview", {
      body: [
        p.description ? String(p.description) : "",
        `Owner: ${p.owner_name ?? "—"}. Status: ${label(String(p.status))}. Health (set by owner): ${label(String(p.health))}${p.health_note ? ` — ${p.health_note}` : ""}.`,
        p.start_date || p.target_date ? `Timeline: ${p.start_date ?? "?"} to ${p.target_date ?? "?"}.` : "",
      ].filter(Boolean).join("\n\n"),
      sources: [{ type: "project", id: pid, label: String(p.name) }],
    });
    add("progress", {
      body: `${progress.value === null ? "Progress not yet measurable" : `${progress.value}% complete`} (method: ${progress.method}). ${progress.explanation}`,
      items: health.factors.map((f) => `${f.level === "info" ? "" : "Attention: "}${f.text}`),
    });
    add("milestones", {
      items: milestones.length ? milestones.map((m) => `${m.title} — ${label(m.status)}${m.status === "achieved" ? ` (${m.completed_date ?? ""})` : m.target_date ? `, target ${m.target_date}${m.target_date < t && !["achieved", "cancelled"].includes(m.status) ? " (overdue)" : ""}` : ""}`) : ["No milestones recorded."],
      sources: milestones.map((m) => ({ type: "milestone", id: m.id, label: m.title })),
    });
    add("deliverables", {
      items: deliverables.length ? deliverables.map((d) => `${d.name} — ${label(d.status)}${d.due_date ? `, due ${d.due_date}` : ""}`) : ["No deliverables recorded."],
      sources: deliverables.map((d) => ({ type: "deliverable", id: d.id, label: d.name })),
    });
    add("risks", {
      items: risks.length ? risks.map((r) => `[${r.severity}] ${r.title} (${r.type}, ${label(r.status)})${r.mitigation ? ` — Mitigation: ${r.mitigation}` : ""}`) : ["No open risks or issues."],
      sources: risks.map((r) => ({ type: "risk", id: r.id, label: r.title })),
    });
    add("decisions", {
      items: decisions.length ? decisions.map((d) => `${d.title} — ${label(d.status)}${d.decision_date ? ` (${d.decision_date})` : ""}`) : ["No decisions recorded."],
      sources: decisions.map((d) => ({ type: "decision", id: d.id, label: d.title })),
    });
    add("next_steps", {
      body: lastUpdate?.next_steps ? `From the latest project update (${lastUpdate.created_at.slice(0, 10)}): ${lastUpdate.next_steps}` : undefined,
      items: upcoming.map((m) => `Upcoming milestone: ${m.title}${m.target_date ? ` (target ${m.target_date})` : ""}`),
    });

    const sourceRecords = [{ type: "project", id: pid, label: String(p.name) }, ...sections.flatMap((s) => s.sources ?? [])];
    const qualityFlags: string[] = [];
    if (!lastUpdate) qualityFlags.push("No project update has been posted; next steps are drawn from milestones only.");
    if (!milestones.length) qualityFlags.push("No milestones are recorded for this project.");
    const id = newId("rep");
    const now = nowIso();
    const content = JSON.stringify({ sections });
    db.tx(() => {
      db.insert("reports", {
        id, report_type: "project_report", title: `Project report — ${p.name} (${t})`, project_id: pid, template_id: tpl?.id ?? null, content, status: "draft",
        audience: "project", generated_by: "system", author_id: u.id, source_records: JSON.stringify(sourceRecords), quality_flags: JSON.stringify(qualityFlags), created_at: now, updated_at: now,
      });
      db.insert("report_versions", { id: newId("rpv"), report_id: id, version: 1, content, status: "draft", changed_by: u.id, change_note: "Generated from project records", created_at: now });
    });
    activity(db, u, "report.generated", { type: "report", id, label: `Project report — ${p.name}` }, { projectId: pid });
    audit(db, req, "report.generate", { type: "report", id }, { report_type: "project_report", project_id: pid });
    res.status(201).json({ id });
  }),
);
