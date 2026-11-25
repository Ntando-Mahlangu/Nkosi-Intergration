/**
 * Knowledge Hub & institutional memory.
 *
 * Every read goes through knowledgeVisibleSql / canViewKnowledge so that restricted,
 * management-only and project-level items never reach unauthorised users. Workflow:
 *   draft → in_review → published → archived   (publish/return require knowledge.manage)
 * Substantive edits (title/summary/body) snapshot the previous content into knowledge_versions.
 */
import { Router } from "express";
import { z } from "zod";
import type { SQLInputValue } from "node:sqlite";
import { h, parse, badRequest, forbidden, notFound, zOptDate, zOptId, zText, zTitle, zUrl, pageParams } from "../lib/http.js";
import { can, currentUser, requirePerm, type AuthUser } from "../lib/context.js";
import { canViewKnowledge, canViewProject, knowledgeVisibleSql } from "../lib/access.js";
import { activity, audit, notify } from "../lib/events.js";
import { addDays, newId, nowIso } from "../lib/ids.js";
import { orgToday } from "../lib/events.js";
import { linkedRecords } from "./core.js";
import type { Db } from "../db/index.js";

export const knowledgeRouter = Router();

const ITEM_TYPES = ["resource", "procedure", "lesson", "insight", "decision_record", "report"] as const;
const ACCESS = ["all_staff", "project", "management", "restricted"] as const;
const STATUSES = ["draft", "in_review", "published", "archived"] as const;

export interface KnowledgeRow {
  id: string;
  title: string;
  summary: string;
  body: string;
  category: string;
  item_type: string;
  keywords: string;
  tags: string;
  author_id: string | null;
  owner_id: string | null;
  project_id: string | null;
  programme_id: string | null;
  access_level: string;
  status: string;
  version: number;
  review_date: string | null;
  [k: string]: unknown;
}

/** Escape LIKE wildcards; use with ESCAPE '\'. */
export const likeTerm = (s: string) => `%${s.replace(/[\\%_]/g, (c) => "\\" + c)}%`;

function load(db: Db, id: string): KnowledgeRow | undefined {
  return db.get<KnowledgeRow>(
    `SELECT k.*, ua.name AS author_name, uo.name AS owner_name, p.name AS project_name, pg.name AS programme_name
     FROM knowledge_items k
     LEFT JOIN users ua ON ua.id = k.author_id
     LEFT JOIN users uo ON uo.id = k.owner_id
     LEFT JOIN projects p ON p.id = k.project_id
     LEFT JOIN programmes pg ON pg.id = k.programme_id
     WHERE k.id = ?`,
    id,
  );
}

const canEdit = (u: AuthUser, k: KnowledgeRow) => k.author_id === u.id || k.owner_id === u.id || can(u, "knowledge.manage");

function viewable(db: Db, u: AuthUser, id: string): KnowledgeRow {
  const k = load(db, id);
  if (!k || !canViewKnowledge(db, u, id)) throw notFound("Knowledge item not found.");
  return k;
}

function knowledgeManagers(db: Db): string[] {
  return db
    .all<{ id: string; permissions: string }>("SELECT u.id, r.permissions FROM users u JOIN roles r ON r.key = u.role_key WHERE u.active = 1")
    .filter((r) => {
      try {
        return (JSON.parse(r.permissions) as string[]).includes("knowledge.manage");
      } catch {
        return false;
      }
    })
    .map((r) => r.id);
}

const LIST_COLS = `k.id, k.title, k.summary, k.category, k.item_type, k.tags, k.keywords, k.status, k.access_level, k.version,
  k.published_date, k.updated_at, k.created_at, k.view_count, k.review_date, k.last_reviewed_date, k.project_id, k.author_id, k.owner_id,
  ua.name AS author_name, p.name AS project_name`;
const LIST_FROM = `FROM knowledge_items k LEFT JOIN users ua ON ua.id = k.author_id LEFT JOIN projects p ON p.id = k.project_id`;

// ------------------------------------------------------------------ list / search
knowledgeRouter.get(
  "/",
  h((req, res) => {
    const u = currentUser(req);
    const db = req.ctx.db;
    const q = req.query as Record<string, string | undefined>;
    const f = knowledgeVisibleSql(u, "k");
    const where: string[] = [f.sql];
    const params: SQLInputValue[] = [...f.params];
    const text = (q.q ?? "").trim().slice(0, 200);
    const terms = text.split(/\s+/).filter((t) => t.length >= 2).slice(0, 6);
    for (const t of terms) {
      where.push(`(k.title LIKE ? ESCAPE '\\' OR k.summary LIKE ? ESCAPE '\\' OR k.body LIKE ? ESCAPE '\\' OR k.keywords LIKE ? ESCAPE '\\' OR k.tags LIKE ? ESCAPE '\\' OR ua.name LIKE ? ESCAPE '\\')`);
      params.push(...Array(6).fill(likeTerm(t)));
    }
    const eq = (col: string, v: string | undefined) => {
      if (v) {
        where.push(`${col} = ?`);
        params.push(v);
      }
    };
    eq("k.category", q.category);
    eq("k.item_type", q.item_type);
    eq("k.author_id", q.author_id);
    eq("k.project_id", q.project_id);
    eq("k.access_level", q.access_level);
    if (q.status && (STATUSES as readonly string[]).includes(q.status)) eq("k.status", q.status);
    else if (!q.status) {
      // Default: hide archived items unless asked.
      where.push("k.status <> 'archived'");
    }
    if (q.tag) {
      where.push("(',' || REPLACE(k.tags, ' ', '') || ',') LIKE ? ESCAPE '\\'");
      params.push(likeTerm("," + q.tag.replace(/\s/g, "") + ","));
    }
    if (q.from && /^\d{4}-\d{2}-\d{2}$/.test(q.from)) {
      where.push("substr(COALESCE(k.published_date, k.created_at), 1, 10) >= ?");
      params.push(q.from);
    }
    if (q.to && /^\d{4}-\d{2}-\d{2}$/.test(q.to)) {
      where.push("substr(COALESCE(k.published_date, k.created_at), 1, 10) <= ?");
      params.push(q.to);
    }
    const { limit, offset } = pageParams(q, 30, 100);
    const sort = q.sort ?? (terms.length ? "relevance" : "recent");
    let order = "COALESCE(k.published_date, substr(k.updated_at,1,10)) DESC, k.updated_at DESC";
    const orderParams: SQLInputValue[] = [];
    if (sort === "popular") order = "k.view_count DESC, k.updated_at DESC";
    else if (sort === "title") order = "k.title COLLATE NOCASE ASC";
    else if (sort === "relevance" && terms.length) {
      const parts = terms.map(() => `(CASE WHEN k.title LIKE ? ESCAPE '\\' THEN 10 ELSE 0 END + CASE WHEN k.keywords LIKE ? ESCAPE '\\' OR k.tags LIKE ? ESCAPE '\\' THEN 5 ELSE 0 END + CASE WHEN k.summary LIKE ? ESCAPE '\\' THEN 3 ELSE 0 END)`);
      order = `(${parts.join(" + ")}) DESC, k.view_count DESC`;
      for (const t of terms) orderParams.push(...Array(4).fill(likeTerm(t)));
    }
    const whereSql = where.join(" AND ");
    const total = db.get<{ n: number }>(`SELECT COUNT(*) n ${LIST_FROM} WHERE ${whereSql}`, ...params)!.n;
    const items = db.all(`SELECT ${LIST_COLS} ${LIST_FROM} WHERE ${whereSql} ORDER BY ${order} LIMIT ? OFFSET ?`, ...params, ...orderParams, limit, offset);
    res.json({ items, total, limit, offset });
  }),
);

// ------------------------------------------------------------------ discovery
knowledgeRouter.get(
  "/discover",
  h((req, res) => {
    const u = currentUser(req);
    const db = req.ctx.db;
    const f = knowledgeVisibleSql(u, "k");
    const today = orgToday(db);
    const list = (extra: string, extraParams: SQLInputValue[], order: string, limit = 6) =>
      db.all(`SELECT ${LIST_COLS} ${LIST_FROM} WHERE ${f.sql} AND ${extra} ORDER BY ${order} LIMIT ?`, ...f.params, ...extraParams, limit);
    const myProjects = `(k.project_id IN (SELECT project_id FROM project_members WHERE user_id = ?) OR k.project_id IN (SELECT id FROM projects WHERE owner_id = ?)
      OR EXISTS (SELECT 1 FROM entity_links el WHERE ((el.a_type = 'knowledge' AND el.a_id = k.id AND el.b_type = 'project' AND el.b_id IN (SELECT project_id FROM project_members WHERE user_id = ?))
        OR (el.b_type = 'knowledge' AND el.b_id = k.id AND el.a_type = 'project' AND el.a_id IN (SELECT project_id FROM project_members WHERE user_id = ?)))))`;
    const manager = can(u, "knowledge.manage");
    const categories = db.all<{ category: string; n: number }>(
      `SELECT k.category, COUNT(*) n FROM knowledge_items k WHERE ${f.sql} AND k.status = 'published' GROUP BY k.category ORDER BY k.category`,
      ...f.params,
    );
    res.json({
      recent: list("k.status = 'published'", [], "COALESCE(k.published_date, substr(k.created_at,1,10)) DESC, k.created_at DESC"),
      popular: list("k.status = 'published' AND k.view_count > 0", [], "k.view_count DESC"),
      my_projects: list(`k.status = 'published' AND ${myProjects}`, [u.id, u.id, u.id, u.id], "k.updated_at DESC"),
      procedures: list("k.status = 'published' AND k.item_type = 'procedure'", [], "k.title COLLATE NOCASE", 8),
      lessons: list("k.status = 'published' AND k.item_type IN ('lesson','insight')", [], "COALESCE(k.published_date, substr(k.created_at,1,10)) DESC", 6),
      review_due: list(
        "k.status = 'published' AND k.review_date IS NOT NULL AND k.review_date <= ? AND (k.owner_id = ? OR k.author_id = ? OR ? = 1)",
        [addDays(today, 14), u.id, u.id, manager ? 1 : 0],
        "k.review_date ASC",
        10,
      ),
      awaiting_review: manager ? list("k.status = 'in_review'", [], "k.updated_at ASC", 20) : [],
      my_drafts: list("k.status IN ('draft','in_review') AND k.author_id = ?", [u.id], "k.updated_at DESC", 10),
      categories,
      today,
    });
  }),
);

// ------------------------------------------------------------------ create
const baseSchema = z.object({
  title: zTitle,
  summary: zText(2000).optional().default(""),
  body: zText(50000).optional().default(""),
  category: z.string().trim().min(1, "Choose a category.").max(80).default("Other"),
  item_type: z.enum(ITEM_TYPES).default("resource"),
  keywords: zText(500).optional().default(""),
  tags: zText(500).optional().default(""),
  owner_id: zOptId,
  source: zText(300).optional().default(""),
  document_url: zUrl,
  project_id: zOptId,
  programme_id: zOptId,
  access_level: z.enum(ACCESS).default("all_staff"),
  review_date: zOptDate,
  what_happened: zText(5000).optional().default(""),
  what_worked: zText(5000).optional().default(""),
  what_did_not_work: zText(5000).optional().default(""),
  why: zText(5000).optional().default(""),
  do_differently: zText(5000).optional().default(""),
  future_benefit: zText(5000).optional().default(""),
  grant_user_ids: z.array(z.string().max(64)).max(100).optional(),
});

function normaliseTags(s: string) {
  return [...new Set(s.split(",").map((t) => t.trim()).filter(Boolean))].join(",");
}

function validateRefs(db: Db, u: AuthUser, b: { project_id: string | null; programme_id: string | null; owner_id: string | null; access_level: string }) {
  if (b.project_id && !canViewProject(db, u, b.project_id)) throw badRequest("Please check the highlighted fields.", { fields: { project_id: "Choose a project you can access." } });
  if (b.access_level === "project" && !b.project_id) throw badRequest("Please check the highlighted fields.", { fields: { project_id: "Project-level access needs a linked project." } });
  if (b.programme_id && !db.get("SELECT 1 FROM programmes WHERE id = ?", b.programme_id)) throw badRequest("Please check the highlighted fields.", { fields: { programme_id: "Unknown programme." } });
  if (b.owner_id && !db.get("SELECT 1 FROM users WHERE id = ? AND active = 1", b.owner_id)) throw badRequest("Please check the highlighted fields.", { fields: { owner_id: "Choose an active user." } });
}

function setGrants(db: Db, id: string, userIds: string[] | undefined) {
  if (!userIds) return;
  for (const uid of userIds) {
    if (db.get("SELECT 1 FROM users WHERE id = ?", uid)) db.run("INSERT OR IGNORE INTO knowledge_access (knowledge_id, user_id) VALUES (?, ?)", id, uid);
  }
}

knowledgeRouter.post(
  "/",
  h((req, res) => {
    const u = currentUser(req);
    const db = req.ctx.db;
    requirePerm(u, "knowledge.contribute");
    const b = parse(baseSchema.extend({ action: z.enum(["draft", "submit", "publish"]).default("draft") }), req.body);
    validateRefs(db, u, b);
    if (b.action === "publish" && !can(u, "knowledge.manage")) throw forbidden("Only knowledge managers can publish directly. Submit it for review instead.");
    const status = b.action === "publish" ? "published" : b.action === "submit" ? "in_review" : "draft";
    const id = newId("kno");
    const now = nowIso();
    db.tx(() => {
      db.insert("knowledge_items", {
        id,
        title: b.title,
        summary: b.summary,
        body: b.body,
        category: b.category,
        item_type: b.item_type,
        keywords: b.keywords,
        tags: normaliseTags(b.tags),
        author_id: u.id,
        owner_id: b.owner_id ?? u.id,
        source: b.source,
        document_url: b.document_url,
        project_id: b.project_id,
        programme_id: b.programme_id,
        access_level: b.access_level,
        status,
        review_date: b.review_date,
        published_date: status === "published" ? orgToday(db) : null,
        what_happened: b.what_happened,
        what_worked: b.what_worked,
        what_did_not_work: b.what_did_not_work,
        why: b.why,
        do_differently: b.do_differently,
        future_benefit: b.future_benefit,
        created_at: now,
        updated_at: now,
      });
      if (b.access_level === "restricted") setGrants(db, id, b.grant_user_ids);
      if (b.project_id) db.run("INSERT OR IGNORE INTO entity_links (id, a_type, a_id, b_type, b_id, relation, created_by, created_at) VALUES (?, 'knowledge', ?, 'project', ?, 'related', ?, ?)", newId("lnk"), id, b.project_id, u.id, now);
    });
    audit(db, req, "knowledge.create", { type: "knowledge", id }, { status, access_level: b.access_level });
    if (status === "published") activity(db, u, "knowledge.published", { type: "knowledge", id, label: b.title }, { projectId: b.project_id });
    if (status === "in_review") {
      activity(db, u, "knowledge.submitted", { type: "knowledge", id, label: b.title }, { projectId: b.project_id });
      for (const m of knowledgeManagers(db)) notify(db, { userId: m, type: "knowledge_review", title: `${u.name} submitted '${b.title}' for knowledge review`, entity: { type: "knowledge", id }, actorId: u.id });
    }
    res.status(201).json(load(db, id));
  }),
);

// ------------------------------------------------------------------ detail
function similarItems(db: Db, u: AuthUser, k: KnowledgeRow) {
  const f = knowledgeVisibleSql(u, "x");
  const cands = db.all<{ id: string; title: string; category: string; item_type: string; tags: string; keywords: string; summary: string }>(
    `SELECT x.id, x.title, x.category, x.item_type, x.tags, x.keywords, x.summary FROM knowledge_items x WHERE ${f.sql} AND x.status = 'published' AND x.id <> ? LIMIT 400`,
    ...f.params,
    k.id,
  );
  const words = (s: string) => new Set(s.toLowerCase().split(/[,;]/).map((w) => w.trim()).filter(Boolean));
  const mine = new Set([...words(k.tags), ...words(k.keywords)]);
  return cands
    .map((c) => {
      let score = 0;
      for (const w of new Set([...words(c.tags), ...words(c.keywords)])) if (mine.has(w)) score += 2;
      if (c.category === k.category) score += 1;
      if (c.item_type === k.item_type && k.item_type !== "resource") score += 1;
      return { ...c, score };
    })
    .filter((c) => c.score >= 2)
    .sort((a, b) => b.score - a.score)
    .slice(0, 5);
}

knowledgeRouter.get(
  "/:id",
  h((req, res) => {
    const u = currentUser(req);
    const db = req.ctx.db;
    const k = viewable(db, u, req.params.id);
    if (k.author_id !== u.id) db.run("UPDATE knowledge_items SET view_count = view_count + 1 WHERE id = ?", k.id);
    const editable = canEdit(u, k);
    const versions = db.all(
      "SELECT v.id, v.version, v.title, v.changed_at, us.name AS changed_by_name FROM knowledge_versions v LEFT JOIN users us ON us.id = v.changed_by WHERE v.knowledge_id = ? ORDER BY v.version DESC",
      k.id,
    );
    res.json({
      item: k,
      permissions: {
        can_edit: editable,
        can_manage: can(u, "knowledge.manage"),
        can_submit: editable && (k.status === "draft" || k.status === "archived"),
        can_publish: can(u, "knowledge.manage") && k.status !== "published",
        can_return: can(u, "knowledge.manage") && k.status === "in_review",
        can_archive: editable && k.status !== "archived",
        can_mark_reviewed: editable && k.status === "published",
      },
      versions,
      related: linkedRecords(db, u, "knowledge", k.id),
      similar: similarItems(db, u, k),
      grants:
        editable && k.access_level === "restricted"
          ? db.all("SELECT us.id, us.name, us.job_title FROM knowledge_access ka JOIN users us ON us.id = ka.user_id WHERE ka.knowledge_id = ? ORDER BY us.name", k.id)
          : [],
      source:
        k.source_type && k.source_id
          ? { type: k.source_type, id: k.source_id }
          : null,
    });
  }),
);

knowledgeRouter.get(
  "/:id/versions/:v",
  h((req, res) => {
    const u = currentUser(req);
    const db = req.ctx.db;
    viewable(db, u, req.params.id);
    const v = db.get(
      "SELECT v.*, us.name AS changed_by_name FROM knowledge_versions v LEFT JOIN users us ON us.id = v.changed_by WHERE v.knowledge_id = ? AND v.version = ?",
      req.params.id,
      parseInt(req.params.v, 10) || 0,
    );
    if (!v) throw notFound("Version not found.");
    res.json(v);
  }),
);

// ------------------------------------------------------------------ update
knowledgeRouter.patch(
  "/:id",
  h((req, res) => {
    const u = currentUser(req);
    const db = req.ctx.db;
    const k = viewable(db, u, req.params.id);
    if (!canEdit(u, k)) throw forbidden("Only the author, owner or a knowledge manager can edit this item.");
    const b = parse(baseSchema.partial().extend({ change_note: zText(300).optional() }), req.body);
    const merged = {
      project_id: b.project_id !== undefined ? b.project_id : k.project_id,
      programme_id: b.programme_id !== undefined ? b.programme_id : k.programme_id,
      owner_id: b.owner_id !== undefined ? b.owner_id : k.owner_id,
      access_level: b.access_level ?? k.access_level,
    };
    validateRefs(db, u, merged);
    const substantive = (["title", "summary", "body"] as const).some((f) => b[f] !== undefined && b[f] !== k[f]);
    const patch: Record<string, unknown> = { ...b };
    delete patch.grant_user_ids;
    delete patch.change_note;
    if (b.tags !== undefined) patch.tags = normaliseTags(b.tags);
    if (b.owner_id === null) patch.owner_id = k.author_id;
    patch.updated_at = nowIso();
    db.tx(() => {
      if (substantive) {
        db.run(
          "INSERT INTO knowledge_versions (id, knowledge_id, version, title, summary, body, changed_by, changed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
          newId("knv"),
          k.id,
          k.version,
          k.title,
          k.summary,
          k.body,
          u.id,
          nowIso(),
        );
        patch.version = k.version + 1;
      }
      db.update("knowledge_items", k.id, patch);
      if (merged.access_level === "restricted" && b.grant_user_ids) setGrants(db, k.id, b.grant_user_ids);
    });
    const sensitive = ["access_level", "project_id", "owner_id"].filter((f) => (b as Record<string, unknown>)[f] !== undefined && (b as Record<string, unknown>)[f] !== k[f]);
    audit(db, req, "knowledge.update", { type: "knowledge", id: k.id }, { fields: Object.keys(b), access_changes: sensitive, new_version: substantive ? k.version + 1 : undefined });
    res.json(load(db, k.id));
  }),
);

// ------------------------------------------------------------------ workflow
function transition(req: import("express").Request, to: string, k: KnowledgeRow, extra: Record<string, unknown> = {}) {
  const db = req.ctx.db;
  db.update("knowledge_items", k.id, { status: to, updated_at: nowIso(), ...extra });
  audit(db, req, `knowledge.${to}`, { type: "knowledge", id: k.id }, { from: k.status, to });
}

knowledgeRouter.post(
  "/:id/submit",
  h((req, res) => {
    const u = currentUser(req);
    const db = req.ctx.db;
    const k = viewable(db, u, req.params.id);
    if (!canEdit(u, k)) throw forbidden();
    if (!["draft", "archived"].includes(k.status)) throw badRequest("Only draft or archived items can be submitted for review.");
    transition(req, "in_review", k);
    activity(db, u, "knowledge.submitted", { type: "knowledge", id: k.id, label: k.title }, { projectId: k.project_id });
    for (const m of knowledgeManagers(db)) notify(db, { userId: m, type: "knowledge_review", title: `${u.name} submitted '${k.title}' for knowledge review`, entity: { type: "knowledge", id: k.id }, actorId: u.id });
    res.json(load(db, k.id));
  }),
);

knowledgeRouter.post(
  "/:id/publish",
  h((req, res) => {
    const u = currentUser(req);
    const db = req.ctx.db;
    requirePerm(u, "knowledge.manage");
    const k = viewable(db, u, req.params.id);
    if (k.status === "published") throw badRequest("This item is already published.");
    transition(req, "published", k, { published_date: (k.published_date as string | null) ?? orgToday(db) });
    activity(db, u, "knowledge.published", { type: "knowledge", id: k.id, label: k.title }, { projectId: k.project_id });
    notify(db, { userId: k.author_id, type: "knowledge_review", title: `'${k.title}' was published to the Knowledge Hub`, entity: { type: "knowledge", id: k.id }, actorId: u.id });
    res.json(load(db, k.id));
  }),
);

knowledgeRouter.post(
  "/:id/return",
  h((req, res) => {
    const u = currentUser(req);
    const db = req.ctx.db;
    requirePerm(u, "knowledge.manage");
    const k = viewable(db, u, req.params.id);
    if (k.status !== "in_review") throw badRequest("Only items in review can be returned.");
    const b = parse(z.object({ note: z.string().trim().min(1, "Explain what needs to change.").max(2000) }), req.body);
    transition(req, "draft", k);
    db.insert("comments", { id: newId("cmt"), entity_type: "knowledge", entity_id: k.id, author_id: u.id, body: b.note, kind: "review_feedback", created_at: nowIso() });
    notify(db, { userId: k.author_id, type: "changes_requested", title: `Changes requested on '${k.title}'`, body: b.note, entity: { type: "knowledge", id: k.id }, actorId: u.id });
    res.json(load(db, k.id));
  }),
);

knowledgeRouter.post(
  "/:id/archive",
  h((req, res) => {
    const u = currentUser(req);
    const db = req.ctx.db;
    const k = viewable(db, u, req.params.id);
    if (!canEdit(u, k)) throw forbidden();
    if (k.status === "archived") throw badRequest("Already archived.");
    transition(req, "archived", k);
    res.json(load(db, k.id));
  }),
);

knowledgeRouter.post(
  "/:id/review-complete",
  h((req, res) => {
    const u = currentUser(req);
    const db = req.ctx.db;
    const k = viewable(db, u, req.params.id);
    if (!canEdit(u, k)) throw forbidden();
    const b = parse(z.object({ next_review_date: zOptDate }), req.body);
    const today = orgToday(db);
    if (b.next_review_date && b.next_review_date <= today) throw badRequest("Please check the highlighted fields.", { fields: { next_review_date: "The next review date must be in the future." } });
    db.update("knowledge_items", k.id, { last_reviewed_date: today, review_date: b.next_review_date ?? addDays(today, 180), updated_at: nowIso() });
    audit(db, req, "knowledge.reviewed", { type: "knowledge", id: k.id });
    res.json(load(db, k.id));
  }),
);

// ------------------------------------------------------------------ restricted access grants
knowledgeRouter.post(
  "/:id/access",
  h((req, res) => {
    const u = currentUser(req);
    const db = req.ctx.db;
    const k = viewable(db, u, req.params.id);
    if (!canEdit(u, k)) throw forbidden();
    const b = parse(z.object({ user_id: z.string().min(3).max(64) }), req.body);
    if (!db.get("SELECT 1 FROM users WHERE id = ? AND active = 1", b.user_id)) throw badRequest("Choose an active user.");
    db.run("INSERT OR IGNORE INTO knowledge_access (knowledge_id, user_id) VALUES (?, ?)", k.id, b.user_id);
    audit(db, req, "knowledge.access_grant", { type: "knowledge", id: k.id }, { user_id: b.user_id });
    res.status(201).json({ ok: true });
  }),
);

knowledgeRouter.delete(
  "/:id/access/:userId",
  h((req, res) => {
    const u = currentUser(req);
    const db = req.ctx.db;
    const k = viewable(db, u, req.params.id);
    if (!canEdit(u, k)) throw forbidden();
    db.run("DELETE FROM knowledge_access WHERE knowledge_id = ? AND user_id = ?", k.id, req.params.userId);
    audit(db, req, "knowledge.access_revoke", { type: "knowledge", id: k.id }, { user_id: req.params.userId });
    res.json({ ok: true });
  }),
);
