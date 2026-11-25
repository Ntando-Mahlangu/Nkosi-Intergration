/**
 * Opportunity & Partnership pipeline (spec §16).
 * Visibility follows opportunityVisibleSql: owner/creator always; staff with
 * opportunity.view_all see non-confidential ones; management sees all.
 * Signals are rule-based *suggestions* only — nothing is created without a person converting it.
 */
import { Router } from "express";
import { z } from "zod";
import type { Db } from "../db/index.js";
import { h, parse, notFound, forbidden, badRequest, zTitle, zText, zOptDate, zDate, zOptId } from "../lib/http.js";
import { can, currentUser, type AuthUser } from "../lib/context.js";
import { newId, nowIso, addDays } from "../lib/ids.js";
import { audit, activity, notify, statusChange, nextTaskRef, orgToday, linkFor } from "../lib/events.js";
import {
  opportunityVisibleSql,
  canViewOpportunity,
  canViewEntity,
  canAssignTo,
  meetingVisibleSql,
  knowledgeVisibleSql,
} from "../lib/access.js";
import { linkedRecords } from "./core.js";

export const opportunitiesRouter = Router();

export const STAGES = ["identified", "exploring", "developing", "engagement", "proposal", "negotiation", "secured", "lost", "on_hold"] as const;
const zStage = z.enum(STAGES);
const zRelevance = z.enum(["low", "medium", "high"]);

const SELECT = `SELECT o.*, ow.name AS owner_name, cr.name AS created_by_name FROM opportunities o
  LEFT JOIN users ow ON ow.id = o.owner_id LEFT JOIN users cr ON cr.id = o.created_by`;

function canManageOpp(u: AuthUser, o: { owner_id: string | null; created_by: string | null }) {
  return o.owner_id === u.id || o.created_by === u.id || can(u, "opportunity.manage") || can(u, "management.view");
}

function loadOpp(db: Db, u: AuthUser, id: string) {
  if (!canViewOpportunity(db, u, id)) throw notFound("Opportunity not found.");
  return db.get<Record<string, unknown> & { id: string; name: string; owner_id: string | null; created_by: string | null; stage: string; confidential: number }>(`${SELECT} WHERE o.id = ?`, id)!;
}

const oppBody = z.object({
  name: zTitle,
  opportunity_type: z.string().trim().min(1).max(80).default("Business development"),
  description: zText(5000).optional().default(""),
  organisation: zText(200).optional().default(""),
  contact_name: zText(200).optional().default(""),
  contact_email: z.union([z.literal(""), z.string().trim().email("Enter a valid email.")]).optional().default(""),
  source: zText(300).optional().default(""),
  date_identified: zOptDate,
  strategic_relevance: zRelevance.default("medium"),
  potential_value: zText(300).optional().default(""),
  estimated_value: z.union([z.number().min(0).max(1e12), z.null()]).optional(),
  probability: z.union([z.number().int().min(0).max(100), z.null()]).optional(),
  owner_id: zOptId,
  next_action: zText(500).optional().default(""),
  follow_up_date: zOptDate,
  stage: zStage.default("identified"),
  notes: zText(5000).optional().default(""),
  confidential: z.boolean().optional().default(false),
});

// ---------------------------------------------------------------- list & summary
opportunitiesRouter.get(
  "/opportunities",
  h((req, res) => {
    const u = currentUser(req);
    const db = req.ctx.db;
    const f = opportunityVisibleSql(u, "o");
    const where = [f.sql];
    const params = [...f.params];
    const q = req.query;
    if (q.stage) { where.push("o.stage = ?"); params.push(String(q.stage)); }
    if (q.type) { where.push("o.opportunity_type = ?"); params.push(String(q.type)); }
    if (q.owner_id) { where.push("o.owner_id = ?"); params.push(String(q.owner_id)); }
    if (q.relevance) { where.push("o.strategic_relevance = ?"); params.push(String(q.relevance)); }
    if (q.follow_up_due === "1") { where.push("o.follow_up_date IS NOT NULL AND o.follow_up_date <= ? AND o.stage NOT IN ('secured','lost')"); params.push(orgToday(db)); }
    if (q.q) {
      const like = `%${String(q.q).slice(0, 100)}%`;
      where.push("(o.name LIKE ? OR o.organisation LIKE ? OR o.description LIKE ? OR o.contact_name LIKE ?)");
      params.push(like, like, like, like);
    }
    const rows = db.all(`${SELECT} WHERE ${where.join(" AND ")} ORDER BY CASE WHEN o.follow_up_date IS NULL THEN 1 ELSE 0 END, o.follow_up_date, o.updated_at DESC LIMIT 500`, ...params);
    res.json({ items: rows, total: rows.length, can_manage_all: can(u, "opportunity.manage") });
  }),
);

opportunitiesRouter.get(
  "/opportunities/summary",
  h((req, res) => {
    const u = currentUser(req);
    const db = req.ctx.db;
    const f = opportunityVisibleSql(u, "o");
    const today = orgToday(db);
    const byStage = db.all<{ stage: string; count: number; value: number | null; weighted: number | null }>(
      `SELECT o.stage, COUNT(*) AS count, SUM(o.estimated_value) AS value,
         SUM(CASE WHEN o.estimated_value IS NOT NULL AND o.probability IS NOT NULL THEN o.estimated_value * o.probability / 100.0 ELSE 0 END) AS weighted
       FROM opportunities o WHERE ${f.sql} GROUP BY o.stage`,
      ...f.params,
    );
    const open = byStage.filter((s) => !["secured", "lost"].includes(s.stage));
    const followUpsDue = db.get<{ n: number }>(
      `SELECT COUNT(*) n FROM opportunities o WHERE ${f.sql} AND o.follow_up_date IS NOT NULL AND o.follow_up_date <= ? AND o.stage NOT IN ('secured','lost')`,
      ...f.params,
      today,
    )!.n;
    const since = addDays(today, -30);
    const recent = db.all(
      `SELECT o.id, o.name, o.stage, o.updated_at FROM opportunities o WHERE ${f.sql} AND o.stage IN ('secured','lost')
       AND o.id IN (SELECT entity_id FROM status_history WHERE entity_type = 'opportunity' AND field = 'stage' AND changed_at >= ?) ORDER BY o.updated_at DESC LIMIT 10`,
      ...f.params,
      since,
    );
    res.json({
      by_stage: STAGES.map((s) => byStage.find((b) => b.stage === s) ?? { stage: s, count: 0, value: 0, weighted: 0 }),
      open_count: open.reduce((a, s) => a + s.count, 0),
      open_value: open.reduce((a, s) => a + (s.value ?? 0), 0),
      weighted_value: Math.round(open.reduce((a, s) => a + (s.weighted ?? 0), 0)),
      follow_ups_due: followUpsDue,
      recently_closed: recent,
      note: "Values only include opportunities where an estimate was recorded; weighted value uses recorded probabilities only.",
    });
  }),
);

// ---------------------------------------------------------------- signals (rule-based suggestions)
const SIGNAL_PATTERNS: { re: RegExp; label: string }[] = [
  { re: /\binterested in\b/i, label: "Expressed interest" },
  { re: /\bwould like to explore\b/i, label: "Wants to explore" },
  { re: /\bpartnership\b/i, label: "Partnership mention" },
  { re: /\bexpand(ing|sion)?\b/i, label: "Expansion potential" },
  { re: /\bfunding\b/i, label: "Funding mention" },
  { re: /\bproposal\b/i, label: "Proposal mention" },
];

interface Signal {
  key: string;
  source_type: "meeting" | "knowledge";
  source_id: string;
  source_title: string;
  source_link: string;
  signal: string;
  evidence: string;
  suggested_name: string;
  project_id: string | null;
  engine: "rules";
}

function findSignals(db: Db, u: AuthUser): Signal[] {
  const mf = meetingVisibleSql(u, "m");
  const kf = knowledgeVisibleSql(u, "k");
  const meetings = db.all<{ id: string; title: string; notes: string; summary: string; key_points: string; project_id: string | null }>(
    `SELECT m.id, m.title, m.notes, m.summary, m.key_points, m.project_id FROM meetings m WHERE m.status = 'approved' AND ${mf.sql} ORDER BY m.meeting_date DESC LIMIT 200`,
    ...mf.params,
  );
  const knowledge = db.all<{ id: string; title: string; summary: string; body: string; project_id: string | null }>(
    `SELECT k.id, k.title, k.summary, k.body, k.project_id FROM knowledge_items k WHERE k.status = 'published' AND ${kf.sql} ORDER BY k.updated_at DESC LIMIT 200`,
    ...kf.params,
  );
  // Records already linked to an opportunity (or converted) are not re-suggested.
  const linked = new Set(
    db
      .all<{ t: string; i: string }>(
        "SELECT b_type AS t, b_id AS i FROM entity_links WHERE a_type = 'opportunity' UNION SELECT a_type, a_id FROM entity_links WHERE b_type = 'opportunity'",
      )
      .map((r) => `${r.t}:${r.i}`),
  );
  const out: Signal[] = [];
  const scan = (type: "meeting" | "knowledge", id: string, title: string, text: string, projectId: string | null) => {
    if (linked.has(`${type}:${id}`)) return;
    const sentences = text.split(/(?<=[.!?])\s+|\r?\n/).map((s) => s.trim()).filter((s) => s.length > 8);
    for (const s of sentences) {
      const p = SIGNAL_PATTERNS.find((x) => x.re.test(s));
      if (!p) continue;
      const evidence = s.replace(/^[-*•]\s*/, "").slice(0, 300);
      out.push({
        key: `${type}:${id}:${out.length}`,
        source_type: type,
        source_id: id,
        source_title: title,
        source_link: linkFor(type, id),
        signal: p.label,
        evidence,
        suggested_name: evidence.length > 90 ? evidence.slice(0, 89).trimEnd() + "…" : evidence,
        project_id: projectId,
        engine: "rules",
      });
      break; // one signal per record keeps the list reviewable
    }
  };
  for (const m of meetings) scan("meeting", m.id, m.title, [m.summary, m.key_points, m.notes].join("\n"), m.project_id);
  for (const k of knowledge) scan("knowledge", k.id, k.title, [k.summary, k.body].join("\n"), k.project_id);
  return out.slice(0, 50);
}

opportunitiesRouter.get(
  "/opportunities/signals",
  h((req, res) => {
    const u = currentUser(req);
    res.json({
      engine: "rules",
      note: "Rule-based suggestions found by scanning approved meetings and published knowledge you can access for interest phrases. They are not opportunities until you convert them.",
      items: findSignals(req.ctx.db, u),
    });
  }),
);

opportunitiesRouter.post(
  "/opportunities/signals/convert",
  h((req, res) => {
    const u = currentUser(req);
    const db = req.ctx.db;
    const b = parse(
      z.object({
        source_type: z.enum(["meeting", "knowledge"]),
        source_id: z.string().min(3).max(64),
        name: zTitle,
        opportunity_type: z.string().trim().min(1).max(80).default("Other"),
        organisation: zText(200).optional().default(""),
        description: zText(5000).optional().default(""),
      }),
      req.body,
    );
    if (!canViewEntity(db, u, b.source_type, b.source_id)) throw notFound("Source record not found.");
    const id = newId("opp");
    const now = nowIso();
    db.tx(() => {
      db.insert("opportunities", {
        id, name: b.name, opportunity_type: b.opportunity_type, organisation: b.organisation, description: b.description,
        source: `${b.source_type === "meeting" ? "Meeting" : "Knowledge item"}: ${labelOf(db, b.source_type, b.source_id)}`,
        date_identified: orgToday(db), owner_id: u.id, stage: "identified", created_by: u.id, created_at: now, updated_at: now,
      });
      db.insert("entity_links", { id: newId("lnk"), a_type: "opportunity", a_id: id, b_type: b.source_type, b_id: b.source_id, relation: "source", created_by: u.id, created_at: now });
      statusChange(db, u.id, "opportunity", id, "stage", null, "identified", "Converted from a rule-based signal");
      activity(db, u, "opportunity.created", { type: "opportunity", id, label: b.name }, { detail: "Converted from a suggested signal" });
      audit(db, req, "opportunity.create", { type: "opportunity", id }, { from_signal: `${b.source_type}:${b.source_id}` });
    });
    res.status(201).json(db.get(`${SELECT} WHERE o.id = ?`, id));
  }),
);


function labelOf(db: Db, type: string, id: string) {
  const row = type === "meeting" ? db.get<{ l: string }>("SELECT title AS l FROM meetings WHERE id = ?", id) : db.get<{ l: string }>("SELECT title AS l FROM knowledge_items WHERE id = ?", id);
  return row?.l ?? id;
}

// ---------------------------------------------------------------- create / read / update
opportunitiesRouter.post(
  "/opportunities",
  h((req, res) => {
    const u = currentUser(req);
    const db = req.ctx.db;
    const b = parse(oppBody, req.body);
    // Any staff member may submit an opportunity they identified; only managers may assign it to someone else.
    let owner = b.owner_id ?? u.id;
    if (owner !== u.id && !can(u, "opportunity.manage") && !can(u, "management.view")) owner = u.id;
    if (owner && !db.get("SELECT 1 FROM users WHERE id = ? AND active = 1", owner)) throw badRequest("Choose an active owner.", { fields: { owner_id: "Choose an active owner." } });
    const id = newId("opp");
    const now = nowIso();
    db.tx(() => {
      db.insert("opportunities", {
        ...b,
        id,
        owner_id: owner,
        confidential: b.confidential ? 1 : 0,
        estimated_value: b.estimated_value ?? null,
        probability: b.probability ?? null,
        date_identified: b.date_identified ?? orgToday(db),
        created_by: u.id,
        created_at: now,
        updated_at: now,
      });
      statusChange(db, u.id, "opportunity", id, "stage", null, b.stage);
      activity(db, u, "opportunity.created", { type: "opportunity", id, label: b.name });
      audit(db, req, "opportunity.create", { type: "opportunity", id }, { stage: b.stage });
      if (owner !== u.id) notify(db, { userId: owner, type: "opportunity_follow_up", title: `${u.name} made you owner of opportunity: ${b.name}`, entity: { type: "opportunity", id }, actorId: u.id });
    });
    res.status(201).json(db.get(`${SELECT} WHERE o.id = ?`, id));
  }),
);

opportunitiesRouter.get(
  "/opportunities/:id",
  h((req, res) => {
    const u = currentUser(req);
    const db = req.ctx.db;
    const o = loadOpp(db, u, req.params.id);
    const history = db.all(
      `SELECT s.*, us.name AS changed_by_name FROM status_history s LEFT JOIN users us ON us.id = s.changed_by WHERE s.entity_type = 'opportunity' AND s.entity_id = ? ORDER BY s.changed_at DESC`,
      o.id,
    );
    const engagements = db.all(
      "SELECT c.*, us.name AS author_name FROM comments c LEFT JOIN users us ON us.id = c.author_id WHERE c.entity_type = 'opportunity' AND c.entity_id = ? AND c.kind = 'engagement' ORDER BY c.created_at DESC",
      o.id,
    );
    const tasks = db.all(
      `SELECT t.id, t.ref, t.title, t.status, t.due_date, t.assignee_id, us.name AS assignee_name FROM tasks t LEFT JOIN users us ON us.id = t.assignee_id
       WHERE t.source = 'opportunity' AND t.source_ref = ? ORDER BY t.created_at DESC`,
      o.id,
    );
    const visibleTasks = tasks.filter((t) => canViewEntity(db, u, "task", (t as { id: string }).id));
    res.json({
      opportunity: o,
      can_manage: canManageOpp(u, o),
      history,
      engagements,
      follow_up_tasks: visibleTasks,
      related: linkedRecords(db, u, "opportunity", o.id),
      activity: db.all(
        "SELECT a.*, us.name AS actor_name FROM activity a LEFT JOIN users us ON us.id = a.actor_id WHERE a.entity_type = 'opportunity' AND a.entity_id = ? ORDER BY a.created_at DESC LIMIT 50",
        o.id,
      ),
    });
  }),
);

opportunitiesRouter.patch(
  "/opportunities/:id",
  h((req, res) => {
    const u = currentUser(req);
    const db = req.ctx.db;
    const o = loadOpp(db, u, req.params.id);
    if (!canManageOpp(u, o)) throw forbidden("Only the opportunity owner or a pipeline manager can edit this.");
    const b = parse(oppBody.partial().omit({ stage: true }), req.body);
    if (b.owner_id !== undefined && b.owner_id !== o.owner_id) {
      if (!b.owner_id) throw badRequest("An opportunity needs an owner.", { fields: { owner_id: "Choose an owner." } });
      if (!db.get("SELECT 1 FROM users WHERE id = ? AND active = 1", b.owner_id)) throw badRequest("Choose an active owner.", { fields: { owner_id: "Choose an active owner." } });
    }
    const patch: Record<string, unknown> = { ...b, updated_at: nowIso() };
    if (b.confidential !== undefined) patch.confidential = b.confidential ? 1 : 0;
    // Only set fields actually sent (zod defaults would otherwise blank them).
    const sent = new Set(Object.keys(req.body ?? {}));
    for (const k of Object.keys(patch)) if (k !== "updated_at" && !sent.has(k)) delete patch[k];
    db.update("opportunities", o.id, patch);
    activity(db, u, "opportunity.updated", { type: "opportunity", id: o.id, label: String(patch.name ?? o.name) });
    if (patch.owner_id && patch.owner_id !== o.owner_id) {
      audit(db, req, "opportunity.reassign", { type: "opportunity", id: o.id }, { from: o.owner_id, to: patch.owner_id });
      notify(db, { userId: patch.owner_id as string, type: "opportunity_follow_up", title: `You are now the owner of opportunity: ${o.name}`, entity: { type: "opportunity", id: o.id }, actorId: u.id });
    }
    res.json(db.get(`${SELECT} WHERE o.id = ?`, o.id));
  }),
);

opportunitiesRouter.post(
  "/opportunities/:id/stage",
  h((req, res) => {
    const u = currentUser(req);
    const db = req.ctx.db;
    const o = loadOpp(db, u, req.params.id);
    if (!canManageOpp(u, o)) throw forbidden("Only the opportunity owner or a pipeline manager can move this.");
    const b = parse(z.object({ stage: zStage, note: zText(1000).optional().default("") }), req.body);
    if (b.stage === o.stage) return res.json(o);
    db.tx(() => {
      db.update("opportunities", o.id, { stage: b.stage, updated_at: nowIso() });
      statusChange(db, u.id, "opportunity", o.id, "stage", o.stage, b.stage, b.note);
      activity(db, u, "opportunity.stage", { type: "opportunity", id: o.id, label: o.name }, { detail: `${o.stage} → ${b.stage}${b.note ? ` — ${b.note}` : ""}` });
      if (b.stage === "secured" || b.stage === "lost") audit(db, req, `opportunity.${b.stage}`, { type: "opportunity", id: o.id }, { from: o.stage, note: b.note });
      if (o.owner_id) notify(db, { userId: o.owner_id, type: "opportunity_follow_up", title: `${o.name} moved to ${b.stage.replace("_", " ")}`, entity: { type: "opportunity", id: o.id }, actorId: u.id });
    });
    res.json(db.get(`${SELECT} WHERE o.id = ?`, o.id));
  }),
);

opportunitiesRouter.post(
  "/opportunities/:id/engagements",
  h((req, res) => {
    const u = currentUser(req);
    const db = req.ctx.db;
    const o = loadOpp(db, u, req.params.id);
    const b = parse(z.object({ body: z.string().trim().min(1, "Describe the engagement.").max(5000), date: zOptDate }), req.body);
    const id = newId("cmt");
    const body = b.date ? `[${b.date}] ${b.body}` : b.body;
    db.insert("comments", { id, entity_type: "opportunity", entity_id: o.id, author_id: u.id, body, kind: "engagement", created_at: nowIso() });
    db.update("opportunities", o.id, { updated_at: nowIso() });
    activity(db, u, "opportunity.engagement", { type: "opportunity", id: o.id, label: o.name }, { detail: body.slice(0, 200) });
    res.status(201).json(db.get("SELECT c.*, ? AS author_name FROM comments c WHERE c.id = ?", u.name, id));
  }),
);

opportunitiesRouter.post(
  "/opportunities/:id/follow-up-task",
  h((req, res) => {
    const u = currentUser(req);
    const db = req.ctx.db;
    const o = loadOpp(db, u, req.params.id);
    if (!canManageOpp(u, o)) throw forbidden("Only the opportunity owner or a pipeline manager can add follow-ups.");
    const b = parse(z.object({ title: zTitle, due_date: zDate, assignee_id: zOptId, description: zText(2000).optional().default("") }), req.body);
    const assignee = b.assignee_id ?? o.owner_id ?? u.id;
    if (!db.get("SELECT 1 FROM users WHERE id = ? AND active = 1", assignee)) throw badRequest("Choose an active person.", { fields: { assignee_id: "Choose an active person." } });
    // Assigning to self/the owner is part of managing it; pipeline managers may delegate to colleagues.
    if (assignee !== u.id && assignee !== o.owner_id && !can(u, "opportunity.manage") && !canAssignTo(db, u, assignee, null)) throw forbidden("You can assign follow-ups to yourself or the opportunity owner.");
    const id = newId("tsk");
    const now = nowIso();
    db.tx(() => {
      db.insert("tasks", {
        id, ref: nextTaskRef(db), title: b.title, description: b.description || `Follow-up for opportunity: ${o.name}`,
        assignee_id: assignee, creator_id: u.id, source: "opportunity", source_ref: o.id, priority: "normal", status: "todo",
        due_date: b.due_date, created_at: now, updated_at: now,
      });
      db.insert("entity_links", { id: newId("lnk"), a_type: "opportunity", a_id: o.id, b_type: "task", b_id: id, relation: "follow_up", created_by: u.id, created_at: now });
      db.update("opportunities", o.id, { next_action: b.title, follow_up_date: b.due_date, updated_at: now });
      activity(db, u, "task.created", { type: "task", id, label: b.title }, { detail: `Follow-up for ${o.name}` });
      notify(db, { userId: assignee, type: "task_assigned", title: `${u.name} assigned you a follow-up: ${b.title}`, entity: { type: "task", id }, actorId: u.id });
      audit(db, req, "task.assign", { type: "task", id }, { assignee, source: "opportunity", opportunity: o.id });
    });
    res.status(201).json(db.get("SELECT t.*, us.name AS assignee_name FROM tasks t LEFT JOIN users us ON us.id = t.assignee_id WHERE t.id = ?", id));
  }),
);

const LINK_TYPES = ["project", "knowledge", "meeting"] as const;
opportunitiesRouter.post(
  "/opportunities/:id/links",
  h((req, res) => {
    const u = currentUser(req);
    const db = req.ctx.db;
    const o = loadOpp(db, u, req.params.id);
    if (!canManageOpp(u, o)) throw forbidden();
    const b = parse(z.object({ type: z.enum(LINK_TYPES), id: z.string().min(3).max(64) }), req.body);
    if (!canViewEntity(db, u, b.type, b.id)) throw notFound("Record not found.");
    db.run(
      "INSERT OR IGNORE INTO entity_links (id, a_type, a_id, b_type, b_id, relation, created_by, created_at) VALUES (?, 'opportunity', ?, ?, ?, 'related', ?, ?)",
      newId("lnk"), o.id, b.type, b.id, u.id, nowIso(),
    );
    res.status(201).json(linkedRecords(db, u, "opportunity", o.id));
  }),
);

opportunitiesRouter.delete(
  "/opportunities/:id/links/:linkId",
  h((req, res) => {
    const u = currentUser(req);
    const db = req.ctx.db;
    const o = loadOpp(db, u, req.params.id);
    if (!canManageOpp(u, o)) throw forbidden();
    const l = db.get("SELECT 1 FROM entity_links WHERE id = ? AND ((a_type = 'opportunity' AND a_id = ?) OR (b_type = 'opportunity' AND b_id = ?))", req.params.linkId, o.id, o.id);
    if (!l) throw notFound();
    db.run("DELETE FROM entity_links WHERE id = ?", req.params.linkId);
    res.json(linkedRecords(db, u, "opportunity", o.id));
  }),
);

