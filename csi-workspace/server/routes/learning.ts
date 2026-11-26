/**
 * Organisational learning & continuous improvement (spec §17).
 * - Learning records: shared (all staff) or private (contributor only — no role bypass).
 * - Monthly themes: managed by learning.manage.
 * - Improvement register: open to all staff; status workflow by owner or learning.manage.
 * This module deliberately exposes no per-person participation or performance metrics.
 */
import { Router } from "express";
import { z } from "zod";
import type { Db } from "../db/index.js";
import { h, parse, parsePatch, notFound, forbidden, badRequest, zTitle, zText, zOptDate, zOptId, zPriority } from "../lib/http.js";
import { can, currentUser, requirePerm, type AuthUser } from "../lib/context.js";
import { newId, nowIso } from "../lib/ids.js";
import { audit, activity, notify, statusChange, orgToday } from "../lib/events.js";
import { learningVisibleSql, canViewProject } from "../lib/access.js";
import { draftFromFacts, engine } from "../ai/service.js";

export const learningRouter = Router();

const RECORD_TYPES = ["lesson", "insight", "experiment", "process_change", "behaviour_change", "approach_change", "unexpected_outcome", "theme_contribution"] as const;

const RSELECT = `SELECT l.*, us.name AS contributor_name, p.name AS project_name, th.title AS theme_title, th.month AS theme_month
  FROM learning_records l LEFT JOIN users us ON us.id = l.contributor_id LEFT JOIN projects p ON p.id = l.project_id LEFT JOIN learning_themes th ON th.id = l.theme_id`;

const recordBody = z.object({
  record_type: z.enum(RECORD_TYPES).default("lesson"),
  title: zTitle,
  topic: zText(120).optional().default(""),
  project_id: zOptId,
  theme_id: zOptId,
  what_learned: zText(5000).optional().default(""),
  what_changed: zText(5000).optional().default(""),
  what_tried: zText(5000).optional().default(""),
  what_worked: zText(5000).optional().default(""),
  what_did_not_work: zText(5000).optional().default(""),
  do_differently: zText(5000).optional().default(""),
  suggested_improvement: zText(5000).optional().default(""),
  others_could_learn: zText(5000).optional().default(""),
  outcome: zText(5000).optional().default(""),
  document_url: z.union([z.literal(""), z.string().trim().url("Use a full URL starting with https://").refine((s) => /^https?:\/\//i.test(s), "Only http(s) links are allowed.")]).optional().default(""),
  visibility: z.enum(["shared", "private"]).default("shared"),
});

const REFLECTIVE = ["what_learned", "what_changed", "what_tried", "what_worked", "what_did_not_work", "do_differently", "suggested_improvement", "others_could_learn", "outcome"] as const;

function loadRecord(db: Db, u: AuthUser, id: string) {
  const f = learningVisibleSql(u, "l");
  const r = db.get<Record<string, unknown> & { id: string; contributor_id: string | null; visibility: string; title: string; project_id: string | null }>(`${RSELECT} WHERE l.id = ? AND ${f.sql}`, id, ...f.params);
  if (!r) throw notFound("Learning record not found.");
  // A shared record tied to a project the viewer cannot see hides the project name.
  if (r.project_id && !canViewProject(db, u, r.project_id)) {
    r.project_id = null;
    r.project_name = null;
  }
  return r;
}

function validateRefs(db: Db, u: AuthUser, b: { project_id?: string | null; theme_id?: string | null }) {
  if (b.project_id && !canViewProject(db, u, b.project_id)) throw badRequest("Choose a project you can access.", { fields: { project_id: "Choose a project you can access." } });
  if (b.theme_id && !db.get("SELECT 1 FROM learning_themes WHERE id = ?", b.theme_id)) throw badRequest("Unknown learning theme.", { fields: { theme_id: "Unknown theme." } });
}

// ---------------------------------------------------------------- learning records
learningRouter.get(
  "/learning/records",
  h((req, res) => {
    const u = currentUser(req);
    const db = req.ctx.db;
    const f = learningVisibleSql(u, "l");
    const where = [f.sql];
    const params = [...f.params];
    const q = req.query;
    if (q.type) { where.push("l.record_type = ?"); params.push(String(q.type)); }
    if (q.topic) { where.push("l.topic = ?"); params.push(String(q.topic)); }
    if (q.project_id) { where.push("l.project_id = ?"); params.push(String(q.project_id)); }
    if (q.theme_id) { where.push("l.theme_id = ?"); params.push(String(q.theme_id)); }
    if (q.mine === "1") { where.push("l.contributor_id = ?"); params.push(u.id); }
    if (q.q) {
      const like = `%${String(q.q).slice(0, 100)}%`;
      where.push("(l.title LIKE ? OR l.topic LIKE ? OR l.what_learned LIKE ? OR l.what_tried LIKE ? OR l.outcome LIKE ?)");
      params.push(like, like, like, like, like);
    }
    const rows = db.all<Record<string, unknown> & { project_id: string | null }>(`${RSELECT} WHERE ${where.join(" AND ")} ORDER BY l.created_at DESC LIMIT 300`, ...params);
    for (const r of rows) if (r.project_id && !canViewProject(db, u, r.project_id)) { r.project_id = null; r.project_name = null; }
    const topics = db.all<{ topic: string }>(`SELECT DISTINCT l.topic FROM learning_records l WHERE ${f.sql} AND l.topic <> '' ORDER BY l.topic`, ...f.params).map((t) => t.topic);
    res.json({ items: rows, topics });
  }),
);

learningRouter.post(
  "/learning/records",
  h((req, res) => {
    const u = currentUser(req);
    const db = req.ctx.db;
    const b = parse(recordBody, req.body);
    validateRefs(db, u, b);
    if (!REFLECTIVE.some((k) => (b[k] ?? "").trim())) throw badRequest("Share at least one reflection (for example, what you learned or what you tried).", { fields: { what_learned: "Add at least one reflection." } });
    const id = newId("lrn");
    const now = nowIso();
    db.insert("learning_records", { ...b, id, contributor_id: u.id, created_at: now, updated_at: now });
    if (b.visibility === "shared") activity(db, u, "learning.shared", { type: "learning", id, label: b.title }, { projectId: b.project_id });
    res.status(201).json(loadRecord(db, u, id));
  }),
);

learningRouter.get(
  "/learning/records/:id",
  h((req, res) => {
    const u = currentUser(req);
    const db = req.ctx.db;
    const r = loadRecord(db, u, req.params.id);
    const promoted = db.get<{ id: string; title: string; status: string }>("SELECT id, title, status FROM knowledge_items WHERE source_type = 'learning' AND source_id = ?", r.id);
    res.json({
      record: r,
      is_owner: r.contributor_id === u.id,
      can_promote: r.visibility === "shared" && can(u, "knowledge.contribute") && !promoted,
      promoted_to: promoted ?? null,
    });
  }),
);

learningRouter.patch(
  "/learning/records/:id",
  h((req, res) => {
    const u = currentUser(req);
    const db = req.ctx.db;
    const r = loadRecord(db, u, req.params.id);
    if (r.contributor_id !== u.id) throw forbidden("Only the contributor can edit this record.");
    const b = parsePatch(recordBody.partial(), req.body);
    const sent = new Set(Object.keys(req.body ?? {}));
    const patch: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(b)) if (sent.has(k)) patch[k] = v;
    validateRefs(db, u, patch as { project_id?: string | null; theme_id?: string | null });
    db.update("learning_records", r.id, { ...patch, updated_at: nowIso() });
    res.json(loadRecord(db, u, r.id));
  }),
);

learningRouter.delete(
  "/learning/records/:id",
  h((req, res) => {
    const u = currentUser(req);
    const db = req.ctx.db;
    const r = loadRecord(db, u, req.params.id);
    if (r.contributor_id !== u.id) throw forbidden("Only the contributor can delete this record.");
    db.run("DELETE FROM learning_records WHERE id = ?", r.id);
    db.run("DELETE FROM entity_links WHERE (a_type = 'learning' AND a_id = ?) OR (b_type = 'learning' AND b_id = ?)", r.id, r.id);
    res.json({ ok: true });
  }),
);

learningRouter.post(
  "/learning/records/:id/promote",
  h((req, res) => {
    const u = currentUser(req);
    const db = req.ctx.db;
    requirePerm(u, "knowledge.contribute");
    const r = loadRecord(db, u, req.params.id) as Record<string, string | null> & { id: string };
    if (r.visibility !== "shared") throw badRequest("Only shared learning records can become knowledge items.");
    if (db.get("SELECT 1 FROM knowledge_items WHERE source_type = 'learning' AND source_id = ?", r.id)) throw badRequest("This record has already been submitted to the Knowledge Hub.");
    const id = newId("kno");
    const now = nowIso();
    const summary = (r.what_learned || r.outcome || r.what_tried || "").slice(0, 500);
    const body = [
      r.what_tried && `What was tried:\n${r.what_tried}`,
      r.what_changed && `What changed:\n${r.what_changed}`,
      r.others_could_learn && `What others could learn:\n${r.others_could_learn}`,
      r.suggested_improvement && `Suggested improvement:\n${r.suggested_improvement}`,
      `Source: learning record contributed by ${r.contributor_name ?? "a colleague"}.`,
    ].filter(Boolean).join("\n\n");
    db.tx(() => {
      db.insert("knowledge_items", {
        id, title: `Lesson: ${r.title}`.slice(0, 300), summary, body, category: "Project lessons", item_type: "lesson",
        keywords: r.topic ?? "", tags: "learning", author_id: u.id, owner_id: u.id, project_id: r.project_id,
        access_level: "all_staff", status: "in_review", what_happened: r.what_tried ?? "", what_worked: r.what_worked ?? "",
        what_did_not_work: r.what_did_not_work ?? "", do_differently: r.do_differently ?? "", future_benefit: r.others_could_learn ?? "",
        source_type: "learning", source_id: r.id, created_at: now, updated_at: now,
      });
      db.insert("entity_links", { id: newId("lnk"), a_type: "knowledge", a_id: id, b_type: "learning", b_id: r.id, relation: "derived_from", created_by: u.id, created_at: now });
      activity(db, u, "knowledge.submitted", { type: "knowledge", id, label: `Lesson: ${r.title}` }, { projectId: r.project_id });
      // Let knowledge managers know there is something to review.
      const managers = db.all<{ id: string; permissions: string }>("SELECT u.id, r.permissions FROM users u JOIN roles r ON r.key = u.role_key WHERE u.active = 1");
      for (const m of managers) {
        if (JSON.parse(m.permissions || "[]").includes("knowledge.manage")) {
          notify(db, { userId: m.id, type: "knowledge_review", title: `Knowledge submission awaiting review: Lesson: ${r.title}`, entity: { type: "knowledge", id }, actorId: u.id });
        }
      }
    });
    res.status(201).json({ id, status: "in_review" });
  }),
);

// ---------------------------------------------------------------- themes
const themeBody = z.object({
  month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, "Use a month in the form YYYY-MM."),
  title: zTitle,
  description: zText(5000).optional().default(""),
  reading_material: zText(5000).optional().default(""),
  discussion_prompts: zText(5000).optional().default(""),
  summary: zText(10000).optional().default(""),
  participation: z.enum(["optional", "encouraged"]).default("optional"),
});

const TSELECT = `SELECT th.*, us.name AS created_by_name,
  (SELECT COUNT(*) FROM learning_records l WHERE l.theme_id = th.id AND l.visibility = 'shared') AS contribution_count
  FROM learning_themes th LEFT JOIN users us ON us.id = th.created_by`;

learningRouter.get(
  "/learning/themes",
  h((req, res) => {
    const u = currentUser(req);
    res.json({ items: req.ctx.db.all(`${TSELECT} ORDER BY th.month DESC`), can_manage: can(u, "learning.manage"), ai_available: engine(req.ctx).kind === "anthropic" });
  }),
);

function themeDetail(db: Db, u: AuthUser, themeId: string) {
  const theme = db.get(`${TSELECT} WHERE th.id = ?`, themeId);
  if (!theme) return null;
  // Contributions shown are shared ones, plus the viewer's own private ones.
  const f = learningVisibleSql(u, "l");
  const contributions = db.all<Record<string, unknown> & { project_id: string | null }>(`${RSELECT} WHERE l.theme_id = ? AND ${f.sql} ORDER BY l.created_at DESC`, themeId, ...f.params);
  for (const r of contributions) if (r.project_id && !canViewProject(db, u, r.project_id)) { r.project_id = null; r.project_name = null; }
  return { theme, contributions };
}

learningRouter.get(
  "/learning/themes/current",
  h((req, res) => {
    const u = currentUser(req);
    const db = req.ctx.db;
    const month = orgToday(db).slice(0, 7);
    const t = db.get<{ id: string }>("SELECT id FROM learning_themes WHERE month = ?", month);
    res.json({ month, ...(t ? themeDetail(db, u, t.id) : { theme: null, contributions: [] }), can_manage: can(u, "learning.manage") });
  }),
);

learningRouter.get(
  "/learning/themes/:id",
  h((req, res) => {
    const u = currentUser(req);
    const d = themeDetail(req.ctx.db, u, req.params.id);
    if (!d) throw notFound("Theme not found.");
    res.json({ ...d, can_manage: can(u, "learning.manage"), ai_available: engine(req.ctx).kind === "anthropic" });
  }),
);

learningRouter.post(
  "/learning/themes",
  h((req, res) => {
    const u = currentUser(req);
    const db = req.ctx.db;
    requirePerm(u, "learning.manage");
    const b = parse(themeBody, req.body);
    if (db.get("SELECT 1 FROM learning_themes WHERE month = ?", b.month)) throw badRequest("A theme already exists for that month.", { fields: { month: "A theme already exists for that month." } });
    const id = newId("lth");
    db.insert("learning_themes", { ...b, id, created_by: u.id, created_at: nowIso() });
    audit(db, req, "learning.theme_create", { type: "learning_theme", id }, { month: b.month });
    res.status(201).json(db.get(`${TSELECT} WHERE th.id = ?`, id));
  }),
);

learningRouter.patch(
  "/learning/themes/:id",
  h((req, res) => {
    const u = currentUser(req);
    const db = req.ctx.db;
    requirePerm(u, "learning.manage");
    const t = db.get<{ id: string; month: string }>("SELECT id, month FROM learning_themes WHERE id = ?", req.params.id);
    if (!t) throw notFound("Theme not found.");
    const b = parsePatch(themeBody.partial(), req.body);
    const sent = new Set(Object.keys(req.body ?? {}));
    const patch: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(b)) if (sent.has(k)) patch[k] = v;
    if (patch.month && patch.month !== t.month && db.get("SELECT 1 FROM learning_themes WHERE month = ?", String(patch.month))) {
      throw badRequest("A theme already exists for that month.", { fields: { month: "A theme already exists for that month." } });
    }
    db.update("learning_themes", t.id, patch);
    audit(db, req, "learning.theme_update", { type: "learning_theme", id: t.id }, { fields: Object.keys(patch) });
    res.json(db.get(`${TSELECT} WHERE th.id = ?`, t.id));
  }),
);

/** Draft a theme summary from shared contributions. Only when AI is configured — never faked. */
learningRouter.post(
  "/learning/themes/:id/draft-summary",
  h(async (req, res) => {
    const u = currentUser(req);
    const db = req.ctx.db;
    requirePerm(u, "learning.manage");
    const t = db.get<{ id: string; title: string; description: string }>("SELECT id, title, description FROM learning_themes WHERE id = ?", req.params.id);
    if (!t) throw notFound("Theme not found.");
    const recs = db.all<Record<string, string>>("SELECT title, topic, what_learned, what_tried, what_worked, what_did_not_work, outcome FROM learning_records WHERE theme_id = ? AND visibility = 'shared'", t.id);
    if (!recs.length) throw badRequest("There are no shared contributions to summarise yet.");
    const facts = [`Theme: ${t.title}`, t.description, ...recs.map((r, i) => `Contribution ${i + 1}: ${r.title}. Topic: ${r.topic}. Learned: ${r.what_learned}. Tried: ${r.what_tried}. Worked: ${r.what_worked}. Did not work: ${r.what_did_not_work}. Outcome: ${r.outcome}`)].join("\n");
    const out = await draftFromFacts(
      req.ctx,
      u.id,
      "learning_theme_summary",
      "Write a short (2 paragraph) synthesis of the shared learning contributions for this monthly theme. Focus on common insights and practical suggestions. Do not name or evaluate individuals.",
      facts,
    );
    if (!out) throw badRequest("AI drafting is not available. Please write the summary manually.");
    res.json({ engine: out.engine, text: out.text });
  }),
);

// ---------------------------------------------------------------- improvements register
const IMP_STATUSES = ["submitted", "under_review", "accepted", "in_progress", "implemented", "rejected", "deferred"] as const;
const ISELECT = `SELECT i.*, sb.name AS suggested_by_name, ow.name AS owner_name, p.name AS project_name
  FROM improvements i LEFT JOIN users sb ON sb.id = i.suggested_by LEFT JOIN users ow ON ow.id = i.owner_id LEFT JOIN projects p ON p.id = i.project_id`;

const impBody = z.object({
  title: zTitle,
  description: zText(5000).optional().default(""),
  area: zText(80).optional().default(""),
  origin: zText(300).optional().default(""),
  problem: zText(5000).optional().default(""),
  proposed_solution: zText(5000).optional().default(""),
  potential_benefit: zText(5000).optional().default(""),
  priority: zPriority.default("normal"),
  project_id: zOptId,
});
const impManageBody = z.object({
  status: z.enum(IMP_STATUSES).optional(),
  owner_id: zOptId,
  review_date: zOptDate,
  outcome: zText(5000).optional(),
  note: zText(1000).optional().default(""),
});

function scrubProject(db: Db, u: AuthUser, r: Record<string, unknown> & { project_id?: unknown }) {
  if (r.project_id && !canViewProject(db, u, String(r.project_id))) { r.project_id = null; r.project_name = null; }
  return r;
}

learningRouter.get(
  "/improvements",
  h((req, res) => {
    const u = currentUser(req);
    const db = req.ctx.db;
    const where: string[] = ["1 = 1"];
    const params: string[] = [];
    const q = req.query;
    if (q.status) { where.push("i.status = ?"); params.push(String(q.status)); }
    if (q.area) { where.push("i.area = ?"); params.push(String(q.area)); }
    if (q.priority) { where.push("i.priority = ?"); params.push(String(q.priority)); }
    if (q.owner_id) { where.push("i.owner_id = ?"); params.push(String(q.owner_id)); }
    if (q.q) {
      const like = `%${String(q.q).slice(0, 100)}%`;
      where.push("(i.title LIKE ? OR i.problem LIKE ? OR i.proposed_solution LIKE ?)");
      params.push(like, like, like);
    }
    const rows = db.all<Record<string, unknown>>(`${ISELECT} WHERE ${where.join(" AND ")} ORDER BY CASE i.status WHEN 'submitted' THEN 0 WHEN 'under_review' THEN 1 WHEN 'accepted' THEN 2 WHEN 'in_progress' THEN 3 ELSE 4 END, i.updated_at DESC LIMIT 500`, ...params);
    const counts = db.all<{ status: string; n: number }>("SELECT status, COUNT(*) n FROM improvements GROUP BY status");
    res.json({ items: rows.map((r) => scrubProject(db, u, r)), counts: Object.fromEntries(counts.map((c) => [c.status, c.n])), can_manage: can(u, "learning.manage") });
  }),
);

learningRouter.post(
  "/improvements",
  h((req, res) => {
    const u = currentUser(req);
    const db = req.ctx.db;
    const b = parse(impBody, req.body);
    if (b.project_id && !canViewProject(db, u, b.project_id)) throw badRequest("Choose a project you can access.", { fields: { project_id: "Choose a project you can access." } });
    const id = newId("imp");
    const now = nowIso();
    db.insert("improvements", { ...b, id, suggested_by: u.id, status: "submitted", created_at: now, updated_at: now });
    statusChange(db, u.id, "improvement", id, "status", null, "submitted");
    activity(db, u, "improvement.submitted", { type: "improvement", id, label: b.title }, { projectId: b.project_id });
    res.status(201).json(scrubProject(db, u, db.get<Record<string, unknown>>(`${ISELECT} WHERE i.id = ?`, id)!));
  }),
);

function loadImp(db: Db, id: string) {
  const r = db.get<Record<string, unknown> & { id: string; title: string; status: string; suggested_by: string | null; owner_id: string | null }>(`${ISELECT} WHERE i.id = ?`, id);
  if (!r) throw notFound("Improvement not found.");
  return r;
}

learningRouter.get(
  "/improvements/:id",
  h((req, res) => {
    const u = currentUser(req);
    const db = req.ctx.db;
    const r = loadImp(db, req.params.id);
    const history = db.all("SELECT s.*, us.name AS changed_by_name FROM status_history s LEFT JOIN users us ON us.id = s.changed_by WHERE s.entity_type = 'improvement' AND s.entity_id = ? ORDER BY s.changed_at DESC", r.id);
    res.json({
      improvement: scrubProject(db, u, r),
      history,
      can_edit: r.suggested_by === u.id && r.status === "submitted",
      can_manage: can(u, "learning.manage") || r.owner_id === u.id,
      can_assign: can(u, "learning.manage"),
    });
  }),
);

learningRouter.patch(
  "/improvements/:id",
  h((req, res) => {
    const u = currentUser(req);
    const db = req.ctx.db;
    const r = loadImp(db, req.params.id);
    const sent = new Set(Object.keys(req.body ?? {}));
    const contentKeys = Object.keys(impBody.shape).filter((k) => sent.has(k));
    const manageKeys = ["status", "owner_id", "review_date", "outcome"].filter((k) => sent.has(k));
    const isManager = can(u, "learning.manage");
    const isOwner = r.owner_id === u.id;

    if (contentKeys.length) {
      const canEditContent = (r.suggested_by === u.id && r.status === "submitted") || isManager;
      if (!canEditContent) throw forbidden("Only the submitter can edit an improvement while it is still submitted.");
      const b = parsePatch(impBody.partial(), req.body);
      const patch: Record<string, unknown> = {};
      for (const k of contentKeys) patch[k] = (b as Record<string, unknown>)[k];
      if (patch.project_id && !canViewProject(db, u, String(patch.project_id))) throw badRequest("Choose a project you can access.", { fields: { project_id: "Choose a project you can access." } });
      db.update("improvements", r.id, { ...patch, updated_at: nowIso() });
    }
    if (manageKeys.length) {
      if (!isManager && !isOwner) throw forbidden("Only the improvement owner or a learning coordinator can change its status.");
      const b = parse(impManageBody, req.body);
      if (sent.has("owner_id") && !isManager) throw forbidden("Only a learning coordinator can assign an owner.");
      if (b.owner_id && !db.get("SELECT 1 FROM users WHERE id = ? AND active = 1", b.owner_id)) throw badRequest("Choose an active owner.", { fields: { owner_id: "Choose an active owner." } });
      const patch: Record<string, unknown> = { updated_at: nowIso() };
      if (sent.has("status")) patch.status = b.status;
      if (sent.has("owner_id")) patch.owner_id = b.owner_id;
      if (sent.has("review_date")) patch.review_date = b.review_date;
      if (sent.has("outcome")) patch.outcome = b.outcome ?? "";
      db.tx(() => {
        db.update("improvements", r.id, patch);
        if (b.status && b.status !== r.status) {
          statusChange(db, u.id, "improvement", r.id, "status", r.status, b.status, b.note);
          activity(db, u, "improvement.status", { type: "improvement", id: r.id, label: r.title }, { detail: `${r.status} → ${b.status}` });
          audit(db, req, "improvement.status", { type: "improvement", id: r.id }, { from: r.status, to: b.status });
          notify(db, { userId: r.suggested_by, type: "system", title: `Your improvement suggestion “${r.title}” is now ${b.status.replace("_", " ")}`, entity: { type: "improvement", id: r.id }, actorId: u.id });
        }
        if (sent.has("owner_id") && b.owner_id && b.owner_id !== r.owner_id) {
          notify(db, { userId: b.owner_id, type: "system", title: `You are now the owner of improvement: ${r.title}`, entity: { type: "improvement", id: r.id }, actorId: u.id });
        }
      });
    }
    if (!contentKeys.length && !manageKeys.length) throw badRequest("Nothing to update.");
    res.json(scrubProject(db, u, loadImp(db, r.id)));
  }),
);
