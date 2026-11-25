/**
 * Core cross-cutting routes: current user, lookups, comments, attachments (document links), entity links.
 */
import { Router } from "express";
import { z } from "zod";
import { h, parse, badRequest, notFound, forbidden, zTitle, zText } from "../lib/http.js";
import { can, currentUser } from "../lib/context.js";
import { newId, nowIso } from "../lib/ids.js";
import { audit, activity, getSetting } from "../lib/events.js";
import { canViewEntity, projectVisibleSql, canManageProject, canManageMeeting } from "../lib/access.js";
import { PERMISSIONS } from "../lib/permissions.js";
import { aiStatus } from "../ai/service.js";
import type { Db } from "../db/index.js";
import type { AuthUser } from "../lib/context.js";

export const coreRouter = Router();

// ---------------------------------------------------------------- me
coreRouter.get(
  "/me",
  h((req, res) => {
    const u = currentUser(req);
    const db = req.ctx.db;
    res.json({
      user: {
        id: u.id,
        name: u.name,
        email: u.email,
        role_key: u.role_key,
        role_name: u.role_name,
        team_id: u.team_id,
        job_title: u.job_title,
        preferences: u.preferences,
        must_change_password: u.must_change_password,
        is_demo: u.is_demo,
        has_password: !!db.get("SELECT 1 FROM users WHERE id = ? AND password_hash IS NOT NULL", u.id),
      },
      permissions: [...u.permissions],
      org: { name: getSetting(db, "org.name", "Change Science Institute"), timezone: getSetting(db, "org.timezone", "Africa/Johannesburg") },
      ai: aiStatus(req.ctx),
      demoMode: !!db.get("SELECT 1 FROM users WHERE is_demo = 1 LIMIT 1"),
      unreadNotifications: db.get<{ n: number }>("SELECT COUNT(*) n FROM notifications WHERE user_id = ? AND read_at IS NULL AND archived_at IS NULL", u.id)!.n,
    });
  }),
);

coreRouter.patch(
  "/me",
  h((req, res) => {
    const u = currentUser(req);
    const db = req.ctx.db;
    const body = parse(
      z.object({
        name: z.string().trim().min(2).max(120).optional(),
        job_title: z.string().trim().max(120).optional(),
        preferences: z
          .object({
            mutedNotifications: z.array(z.string().max(60)).max(50).optional(),
            defaultTaskView: z.string().max(40).optional(),
            timezone: z.string().max(60).optional(),
            compactLists: z.boolean().optional(),
          })
          .optional(),
      }),
      req.body,
    );
    const prefs = body.preferences ? { ...u.preferences, ...body.preferences } : undefined;
    db.update("users", u.id, { name: body.name, job_title: body.job_title, preferences: prefs ? JSON.stringify(prefs) : undefined, updated_at: nowIso() });
    audit(db, req, "user.profile_update", { type: "user", id: u.id }, { fields: Object.keys(body) });
    res.json({ ok: true });
  }),
);

// ---------------------------------------------------------------- lookups (for selects/filters)
coreRouter.get(
  "/lookups",
  h((req, res) => {
    const u = currentUser(req);
    const db = req.ctx.db;
    const pf = projectVisibleSql(u, "p");
    const taxonomies: Record<string, string[]> = {};
    for (const t of db.all<{ taxonomy: string; label: string }>("SELECT taxonomy, label FROM taxonomy_terms WHERE active = 1 ORDER BY taxonomy, sort_order, label")) {
      (taxonomies[t.taxonomy] ??= []).push(t.label);
    }
    res.json({
      // Directory info only (no preferences, login data etc.). Email shown for collaboration.
      users: db.all("SELECT u.id, u.name, u.email, u.job_title, u.team_id, u.role_key FROM users u WHERE u.active = 1 ORDER BY u.name"),
      teams: db.all("SELECT id, name FROM teams ORDER BY name"),
      programmes: db.all("SELECT id, name, status FROM programmes ORDER BY name"),
      projects: db.all(
        `SELECT p.id, p.name, p.code, p.status, p.programme_id, p.owner_id,
           (SELECT role FROM project_members pm WHERE pm.project_id = p.id AND pm.user_id = ?) AS my_role
         FROM projects p WHERE ${pf.sql} ORDER BY p.name`,
        u.id,
        ...pf.params,
      ),
      taxonomies,
      permissionsCatalogue: PERMISSIONS,
    });
  }),
);

// ---------------------------------------------------------------- comments (generic)
const COMMENTABLE = ["task", "deliverable", "report", "opportunity", "improvement", "knowledge", "meeting", "project", "risk", "decision"];

function assertEntityView(db: Db, u: AuthUser, type: string, id: string) {
  if (!COMMENTABLE.includes(type) && !["milestone", "learning"].includes(type)) throw badRequest("Unsupported record type.");
  if (!canViewEntity(db, u, type, id)) throw notFound("Record not found.");
}

coreRouter.get(
  "/comments",
  h((req, res) => {
    const u = currentUser(req);
    const db = req.ctx.db;
    const type = String(req.query.entity_type ?? "");
    const id = String(req.query.entity_id ?? "");
    assertEntityView(db, u, type, id);
    res.json(
      db.all(
        "SELECT c.*, us.name AS author_name FROM comments c LEFT JOIN users us ON us.id = c.author_id WHERE c.entity_type = ? AND c.entity_id = ? ORDER BY c.created_at",
        type,
        id,
      ),
    );
  }),
);

coreRouter.post(
  "/comments",
  h((req, res) => {
    const u = currentUser(req);
    const db = req.ctx.db;
    const body = parse(
      z.object({ entity_type: z.string(), entity_id: z.string(), body: z.string().trim().min(1, "Write something first.").max(5000), kind: z.enum(["comment", "note", "engagement"]).default("comment") }),
      req.body,
    );
    assertEntityView(db, u, body.entity_type, body.entity_id);
    const id = newId("cmt");
    db.insert("comments", { id, entity_type: body.entity_type, entity_id: body.entity_id, author_id: u.id, body: body.body, kind: body.kind, created_at: nowIso() });
    res.status(201).json(db.get("SELECT c.*, ? AS author_name FROM comments c WHERE c.id = ?", u.name, id));
  }),
);

coreRouter.delete(
  "/comments/:id",
  h((req, res) => {
    const u = currentUser(req);
    const db = req.ctx.db;
    const c = db.get<{ author_id: string }>("SELECT author_id FROM comments WHERE id = ?", req.params.id);
    if (!c) throw notFound();
    if (c.author_id !== u.id) throw forbidden("You can only delete your own comments.");
    db.run("DELETE FROM comments WHERE id = ?", req.params.id);
    res.json({ ok: true });
  }),
);

// ---------------------------------------------------------------- attachments / document links (generic)
function linkKind(url: string): string {
  if (/docs\.google\.com\/document/.test(url)) return "google_doc";
  if (/docs\.google\.com\/spreadsheets/.test(url)) return "google_sheet";
  if (/drive\.google\.com\/drive\/(u\/\d+\/)?folders/.test(url)) return "google_drive_folder";
  if (/\.pdf(\?|$)/i.test(url)) return "pdf";
  return "link";
}

function canEditAttachments(db: Db, u: AuthUser, type: string, id: string): boolean {
  if (!canViewEntity(db, u, type, id)) return false;
  if (type === "project") return canManageProject(db, u, id) || !!db.get("SELECT 1 FROM project_members WHERE project_id = ? AND user_id = ? AND role <> 'viewer'", id, u.id);
  if (type === "meeting") return canManageMeeting(db, u, id) || !!db.get("SELECT 1 FROM meeting_participants WHERE meeting_id = ? AND user_id = ?", id, u.id);
  return true; // other record types: anyone who can view may attach a reference link
}

coreRouter.get(
  "/attachments",
  h((req, res) => {
    const u = currentUser(req);
    const db = req.ctx.db;
    const type = String(req.query.entity_type ?? "");
    const id = String(req.query.entity_id ?? "");
    if (!canViewEntity(db, u, type, id)) throw notFound("Record not found.");
    res.json(db.all("SELECT a.*, us.name AS added_by_name FROM attachments a LEFT JOIN users us ON us.id = a.added_by WHERE a.entity_type = ? AND a.entity_id = ? ORDER BY a.created_at DESC", type, id));
  }),
);

coreRouter.post(
  "/attachments",
  h((req, res) => {
    const u = currentUser(req);
    const db = req.ctx.db;
    const body = parse(
      z.object({
        entity_type: z.string(),
        entity_id: z.string(),
        title: zTitle,
        url: z.string().trim().url("Use a full URL starting with https://").refine((s) => /^https?:\/\//i.test(s), "Only http(s) links are allowed."),
        description: zText(1000).optional().default(""),
      }),
      req.body,
    );
    if (!canEditAttachments(db, u, body.entity_type, body.entity_id)) throw forbidden();
    const id = newId("att");
    db.insert("attachments", { id, entity_type: body.entity_type, entity_id: body.entity_id, title: body.title, url: body.url, kind: linkKind(body.url), description: body.description, added_by: u.id, created_at: nowIso() });
    const projectId =
      body.entity_type === "project" ? body.entity_id : (db.get<{ project_id: string | null }>(`SELECT project_id FROM ${tableFor(body.entity_type)} WHERE id = ?`, body.entity_id)?.project_id ?? null);
    activity(db, u, "document.added", { type: body.entity_type, id: body.entity_id, label: body.title }, { projectId });
    res.status(201).json(db.get("SELECT * FROM attachments WHERE id = ?", id));
  }),
);

coreRouter.delete(
  "/attachments/:id",
  h((req, res) => {
    const u = currentUser(req);
    const db = req.ctx.db;
    const a = db.get<{ entity_type: string; entity_id: string; added_by: string }>("SELECT entity_type, entity_id, added_by FROM attachments WHERE id = ?", req.params.id);
    if (!a) throw notFound();
    if (a.added_by !== u.id && !canEditAttachments(db, u, a.entity_type, a.entity_id)) throw forbidden();
    db.run("DELETE FROM attachments WHERE id = ?", req.params.id);
    audit(db, req, "attachment.delete", { type: a.entity_type, id: a.entity_id });
    res.json({ ok: true });
  }),
);

function tableFor(type: string): string {
  const map: Record<string, string> = {
    task: "tasks", meeting: "meetings", deliverable: "deliverables", milestone: "milestones", risk: "risks", decision: "decisions",
    knowledge: "knowledge_items", report: "reports", opportunity: "opportunities", improvement: "improvements", learning: "learning_records",
  };
  const t = map[type];
  if (!t) throw badRequest("Unsupported record type.");
  return t;
}

// ---------------------------------------------------------------- entity links ("related records")
const LINKABLE = ["project", "task", "meeting", "knowledge", "report", "opportunity", "decision", "deliverable", "milestone", "risk", "learning", "improvement"];

export function linkedRecords(db: Db, u: AuthUser, type: string, id: string) {
  const rows = db.all<{ id: string; a_type: string; a_id: string; b_type: string; b_id: string; relation: string }>(
    "SELECT * FROM entity_links WHERE (a_type = ? AND a_id = ?) OR (b_type = ? AND b_id = ?) ORDER BY created_at DESC",
    type, id, type, id,
  );
  const out: { link_id: string; type: string; id: string; label: string; relation: string }[] = [];
  for (const r of rows) {
    const [ot, oid] = r.a_type === type && r.a_id === id ? [r.b_type, r.b_id] : [r.a_type, r.a_id];
    if (!canViewEntity(db, u, ot, oid)) continue; // never reveal restricted linked records
    out.push({ link_id: r.id, type: ot, id: oid, label: labelFor(db, ot, oid), relation: r.relation });
  }
  return out;
}

export function labelFor(db: Db, type: string, id: string): string {
  const col: Record<string, [string, string]> = {
    project: ["projects", "name"], task: ["tasks", "title"], meeting: ["meetings", "title"], knowledge: ["knowledge_items", "title"],
    report: ["reports", "title"], opportunity: ["opportunities", "name"], decision: ["decisions", "title"], deliverable: ["deliverables", "name"],
    milestone: ["milestones", "title"], risk: ["risks", "title"], learning: ["learning_records", "title"], improvement: ["improvements", "title"],
  };
  const c = col[type];
  if (!c) return id;
  return db.get<{ l: string }>(`SELECT ${c[1]} AS l FROM ${c[0]} WHERE id = ?`, id)?.l ?? "(deleted)";
}

coreRouter.get(
  "/links",
  h((req, res) => {
    const u = currentUser(req);
    const db = req.ctx.db;
    const type = String(req.query.entity_type ?? "");
    const id = String(req.query.entity_id ?? "");
    if (!canViewEntity(db, u, type, id)) throw notFound("Record not found.");
    res.json(linkedRecords(db, u, type, id));
  }),
);

coreRouter.post(
  "/links",
  h((req, res) => {
    const u = currentUser(req);
    const db = req.ctx.db;
    const b = parse(z.object({ a_type: z.enum(LINKABLE as [string, ...string[]]), a_id: z.string(), b_type: z.enum(LINKABLE as [string, ...string[]]), b_id: z.string(), relation: z.string().max(40).default("related") }), req.body);
    if (!canViewEntity(db, u, b.a_type, b.a_id) || !canViewEntity(db, u, b.b_type, b.b_id)) throw notFound("Record not found.");
    if (b.a_type === b.b_type && b.a_id === b.b_id) throw badRequest("A record cannot be linked to itself.");
    const id = newId("lnk");
    db.run("INSERT OR IGNORE INTO entity_links (id, a_type, a_id, b_type, b_id, relation, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)", id, b.a_type, b.a_id, b.b_type, b.b_id, b.relation, u.id, nowIso());
    res.status(201).json({ ok: true });
  }),
);

coreRouter.delete(
  "/links/:id",
  h((req, res) => {
    const u = currentUser(req);
    const db = req.ctx.db;
    const l = db.get<{ a_type: string; a_id: string; b_type: string; b_id: string }>("SELECT * FROM entity_links WHERE id = ?", req.params.id);
    if (!l) throw notFound();
    if (!canViewEntity(db, u, l.a_type, l.a_id) || !canViewEntity(db, u, l.b_type, l.b_id)) throw notFound();
    db.run("DELETE FROM entity_links WHERE id = ?", req.params.id);
    res.json({ ok: true });
  }),
);

// ---------------------------------------------------------------- AI feedback
coreRouter.post(
  "/ai/feedback",
  h((req, res) => {
    const u = currentUser(req);
    const b = parse(z.object({ feature: z.string().max(60), reference_id: z.string().max(80).optional(), rating: z.enum(["helpful", "not_helpful"]), comment: zText(1000).optional().default("") }), req.body);
    req.ctx.db.insert("ai_feedback", { id: newId("aif"), user_id: u.id, feature: b.feature, reference_id: b.reference_id ?? null, rating: b.rating, comment: b.comment, created_at: nowIso() });
    res.status(201).json({ ok: true });
  }),
);

coreRouter.get(
  "/ai/status",
  h((req, res) => {
    currentUser(req);
    res.json(aiStatus(req.ctx));
  }),
);

export { can };
