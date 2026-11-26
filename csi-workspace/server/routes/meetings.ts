/**
 * Meetings & meeting intelligence (spec §10) and call report generation (§11.1).
 *
 * Principles enforced here:
 *  - Processing notes only creates *suggestions* (ai_suggestions). Nothing becomes a task,
 *    decision, risk or knowledge item until the meeting owner accepts it.
 *  - Accepted actions assigned to someone else become 'suggested' tasks that the assignee
 *    must confirm — the system never assumes a person accepted responsibility.
 *  - Call reports are built only from human-approved meeting content.
 */
import { Router } from "express";
import { z } from "zod";
import type { Request } from "express";
import { h, parse, parsePatch, badRequest, notFound, forbidden, zDate, zOptDate, zTime, zOptId, zText, zTitle } from "../lib/http.js";
import { currentUser, can, type AuthUser } from "../lib/context.js";
import { newId, nowIso } from "../lib/ids.js";
import { audit, activity, notify, nextTaskRef, statusChange, orgToday, getSetting } from "../lib/events.js";
import {
  meetingVisibleSql,
  canViewMeeting,
  canManageMeeting,
  assertMeetingView,
  assertMeetingManage,
  canViewProject,
  canManageProject,
  taskVisibleSql,
} from "../lib/access.js";
import { analyseMeeting } from "../ai/service.js";
import type { Db } from "../db/index.js";

export const meetingsRouter = Router();

interface MeetingRow {
  id: string;
  title: string;
  meeting_type: string;
  purpose: string;
  project_id: string | null;
  programme_id: string | null;
  meeting_date: string;
  start_time: string | null;
  end_time: string | null;
  timezone: string;
  location: string;
  meeting_link: string;
  organiser_id: string | null;
  notes: string;
  transcript: string;
  transcript_source: string;
  key_points: string;
  summary: string;
  summary_source: string;
  follow_up_date: string | null;
  preparation_required: number;
  preparation_notes: string;
  status: string;
  review_status: string;
  confidential: number;
  approved_by: string | null;
  approved_at: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

const zLink = z
  .union([z.literal(""), z.string().trim().url("Use a full URL starting with https://").refine((u) => /^https?:\/\//i.test(u), "Only http(s) links are allowed.")])
  .optional()
  .default("");

const participantsSchema = z
  .object({
    user_ids: z.array(z.string().min(3).max(64)).max(100).optional().default([]),
    external: z
      .array(z.object({ name: z.string().trim().min(1, "Name is required.").max(120), org: z.string().trim().max(160).optional().default("") }))
      .max(50)
      .optional()
      .default([]),
  })
  .optional()
  .default({ user_ids: [], external: [] });

const meetingBase = {
  title: zTitle,
  meeting_type: z.string().trim().max(80).optional().default("Internal planning"),
  purpose: zText(2000).optional().default(""),
  project_id: zOptId,
  programme_id: zOptId,
  meeting_date: zDate,
  start_time: zTime,
  end_time: zTime,
  timezone: z.string().trim().max(60).optional(),
  location: zText(300).optional().default(""),
  meeting_link: zLink,
  notes: zText(100000).optional().default(""),
  transcript: zText(400000).optional().default(""),
  transcript_source: zText(200).optional().default(""),
  key_points: zText(10000).optional().default(""),
  follow_up_date: zOptDate,
  preparation_required: z.boolean().optional().default(false),
  preparation_notes: zText(2000).optional().default(""),
  confidential: z.boolean().optional().default(false),
  organiser_id: zOptId,
};

const createSchema = z.object({ ...meetingBase, participants: participantsSchema }).refine((v) => !v.start_time || !v.end_time || v.end_time >= v.start_time, {
  message: "End time must be after the start time.",
  path: ["end_time"],
});

function validateRefs(db: Db, u: AuthUser, b: { project_id?: string | null; programme_id?: string | null; organiser_id?: string | null }) {
  if (b.project_id) {
    if (!db.get("SELECT 1 FROM projects WHERE id = ?", b.project_id) || !canViewProject(db, u, b.project_id)) throw badRequest("Choose a project you have access to.", { fields: { project_id: "Unknown project." } });
  }
  if (b.programme_id && !db.get("SELECT 1 FROM programmes WHERE id = ?", b.programme_id)) throw badRequest("Unknown programme.", { fields: { programme_id: "Unknown programme." } });
  if (b.organiser_id && !db.get("SELECT 1 FROM users WHERE id = ? AND active = 1", b.organiser_id)) throw badRequest("Unknown organiser.", { fields: { organiser_id: "Unknown person." } });
}

function setParticipants(db: Db, meetingId: string, p: { user_ids: string[]; external: { name: string; org: string }[] }, isPast: boolean) {
  const valid = new Set(db.all<{ id: string }>(`SELECT id FROM users WHERE active = 1 AND id IN (${p.user_ids.map(() => "?").join(",") || "''"})`, ...p.user_ids).map((r) => r.id));
  const invalid = p.user_ids.filter((id) => !valid.has(id));
  if (invalid.length) throw badRequest("One or more participants are not active users.", { fields: { participants: "Unknown participant." } });
  db.run("DELETE FROM meeting_participants WHERE meeting_id = ?", meetingId);
  for (const uid of [...valid]) db.insert("meeting_participants", { id: newId("mpt"), meeting_id: meetingId, user_id: uid, attendance: isPast ? "attended" : "invited" });
  for (const e of p.external) db.insert("meeting_participants", { id: newId("mpt"), meeting_id: meetingId, user_id: null, external_name: e.name, external_org: e.org, attendance: isPast ? "attended" : "invited" });
}

function getMeeting(db: Db, id: string): MeetingRow {
  const m = db.get<MeetingRow>("SELECT * FROM meetings WHERE id = ?", id);
  if (!m) throw notFound("Meeting not found.");
  return m;
}

function participants(db: Db, id: string) {
  return db.all<{ id: string; user_id: string | null; name: string | null; email: string | null; external_name: string; external_org: string; attendance: string }>(
    `SELECT mp.id, mp.user_id, u.name, u.email, mp.external_name, mp.external_org, mp.attendance
     FROM meeting_participants mp LEFT JOIN users u ON u.id = mp.user_id WHERE mp.meeting_id = ? ORDER BY u.name IS NULL, u.name, mp.external_name`,
    id,
  );
}

/** Allocate a task ref, tolerating a sequence that lags behind existing rows (e.g. imported/seeded tasks). */

const isParticipant = (db: Db, u: AuthUser, id: string) => !!db.get("SELECT 1 FROM meeting_participants WHERE meeting_id = ? AND user_id = ?", id, u.id);

// ---------------------------------------------------------------- list
meetingsRouter.get(
  "/",
  h((req, res) => {
    const u = currentUser(req);
    const db = req.ctx.db;
    const today = orgToday(db);
    const f = meetingVisibleSql(u, "m");
    const where: string[] = [f.sql];
    const params: (string | number)[] = [...(f.params as (string | number)[])];
    const view = String(req.query.view ?? "all");
    if (view === "upcoming") {
      where.push("m.meeting_date >= ? AND m.status <> 'cancelled'");
      params.push(today);
    } else if (view === "past") {
      where.push("m.meeting_date < ?");
      params.push(today);
    } else if (view === "needs_review") {
      where.push("(m.status IN ('notes_submitted','in_review') OR EXISTS (SELECT 1 FROM ai_suggestions s WHERE s.source_type='meeting' AND s.source_id = m.id AND s.status = 'pending'))");
    } else if (view === "mine") {
      where.push("(m.organiser_id = ? OR m.created_by = ? OR EXISTS (SELECT 1 FROM meeting_participants mp2 WHERE mp2.meeting_id = m.id AND mp2.user_id = ?))");
      params.push(u.id, u.id, u.id);
    }
    if (req.query.project_id) {
      where.push("m.project_id = ?");
      params.push(String(req.query.project_id));
    }
    if (req.query.from) {
      where.push("m.meeting_date >= ?");
      params.push(String(req.query.from));
    }
    if (req.query.to) {
      where.push("m.meeting_date <= ?");
      params.push(String(req.query.to));
    }
    if (req.query.q) {
      where.push("(m.title LIKE ? OR m.purpose LIKE ? OR m.notes LIKE ?)");
      const q = `%${String(req.query.q).slice(0, 100)}%`;
      params.push(q, q, q);
    }
    const limit = Math.min(Math.max(parseInt(String(req.query.limit ?? 100), 10) || 100, 1), 300);
    const order = view === "upcoming" ? "m.meeting_date ASC, m.start_time ASC" : "m.meeting_date DESC, m.start_time DESC";
    const tf = taskVisibleSql(u, "t");
    const rows = db.all(
      `SELECT m.id, m.title, m.meeting_type, m.project_id, p.name AS project_name, m.meeting_date, m.start_time, m.end_time, m.status, m.review_status,
        m.confidential, m.meeting_link, m.location, m.preparation_required, m.organiser_id, ou.name AS organiser_name,
        (SELECT COUNT(*) FROM meeting_participants mp WHERE mp.meeting_id = m.id) AS participant_count,
        (SELECT COUNT(*) FROM tasks t WHERE t.meeting_id = m.id AND t.status NOT IN ('completed','cancelled') AND ${tf.sql}) AS open_actions,
        (SELECT COUNT(*) FROM ai_suggestions s WHERE s.source_type = 'meeting' AND s.source_id = m.id AND s.status = 'pending') AS pending_suggestions
       FROM meetings m LEFT JOIN projects p ON p.id = m.project_id LEFT JOIN users ou ON ou.id = m.organiser_id
       WHERE ${where.join(" AND ")} ORDER BY ${order} LIMIT ?`,
      ...tf.params,
      ...params,
      limit,
    );
    res.json({ items: rows, total: rows.length, today });
  }),
);

// ---------------------------------------------------------------- create
meetingsRouter.post(
  "/",
  h((req, res) => {
    const u = currentUser(req);
    const db = req.ctx.db;
    if (!can(u, "meeting.create")) throw forbidden("You do not have permission to create meetings.");
    const b = parse(createSchema, req.body);
    validateRefs(db, u, b);
    const id = newId("mtg");
    const now = nowIso();
    const today = orgToday(db);
    const hasNotes = !!(b.notes.trim() || b.transcript.trim());
    db.tx(() => {
      db.insert("meetings", {
        id,
        title: b.title,
        meeting_type: b.meeting_type,
        purpose: b.purpose,
        project_id: b.project_id,
        programme_id: b.programme_id,
        meeting_date: b.meeting_date,
        start_time: b.start_time,
        end_time: b.end_time,
        timezone: b.timezone || getSetting(db, "org.timezone", "Africa/Johannesburg"),
        location: b.location,
        meeting_link: b.meeting_link,
        organiser_id: b.organiser_id ?? u.id,
        notes: b.notes,
        transcript: b.transcript,
        transcript_source: b.transcript ? b.transcript_source || "pasted" : "",
        key_points: b.key_points,
        follow_up_date: b.follow_up_date,
        preparation_required: b.preparation_required ? 1 : 0,
        preparation_notes: b.preparation_notes,
        confidential: b.confidential ? 1 : 0,
        status: hasNotes ? "notes_submitted" : "scheduled",
        review_status: hasNotes ? "pending" : "not_started",
        created_by: u.id,
        created_at: now,
        updated_at: now,
      });
      const ids = new Set(b.participants.user_ids);
      ids.add(u.id);
      setParticipants(db, id, { user_ids: [...ids], external: b.participants.external }, b.meeting_date < today);
    });
    activity(db, u, hasNotes ? "meeting.notes_submitted" : "meeting.created", { type: "meeting", id, label: b.title }, { projectId: b.project_id });
    audit(db, req, "meeting.create", { type: "meeting", id }, { title: b.title, confidential: b.confidential });
    if (b.meeting_date >= today) {
      for (const p of participants(db, id)) {
        if (!p.user_id) continue;
        notify(db, {
          userId: p.user_id,
          actorId: u.id,
          type: "meeting_upcoming",
          title: `${u.name} added you to “${b.title}” on ${b.meeting_date}${b.start_time ? ` at ${b.start_time}` : ""}`,
          body: b.preparation_required ? `Preparation required: ${b.preparation_notes}` : "",
          entity: { type: "meeting", id },
        });
      }
    }
    res.status(201).json({ id });
  }),
);

// ---------------------------------------------------------------- detail
function suggestionRows(db: Db, meetingId: string) {
  return db
    .all<{ id: string; kind: string; payload: string; status: string; engine: string; resulting_type: string | null; resulting_id: string | null; reviewed_by: string | null; reviewed_at: string | null; created_at: string; reviewer_name: string | null }>(
      "SELECT s.*, u.name AS reviewer_name FROM ai_suggestions s LEFT JOIN users u ON u.id = s.reviewed_by WHERE s.source_type = 'meeting' AND s.source_id = ? ORDER BY s.created_at, s.rowid",
      meetingId,
    )
    .map((s) => ({ ...s, payload: safeJson(s.payload) }));
}

function safeJson(s: string): Record<string, unknown> {
  try {
    return JSON.parse(s);
  } catch {
    return {};
  }
}

meetingsRouter.get(
  "/:id",
  h((req, res) => {
    const u = currentUser(req);
    const db = req.ctx.db;
    assertMeetingView(db, u, req.params.id);
    const m = getMeeting(db, req.params.id);
    const manage = canManageMeeting(db, u, m.id);
    const tf = taskVisibleSql(u, "t");
    const tasks = db.all(
      `SELECT t.id, t.ref, t.title, t.status, t.priority, t.due_date, t.assignee_id, a.name AS assignee_name, t.review_status, t.source_ref
       FROM tasks t LEFT JOIN users a ON a.id = t.assignee_id WHERE t.meeting_id = ? AND ${tf.sql} ORDER BY t.created_at`,
      m.id,
      ...tf.params,
    );
    const decisions = db.all(
      "SELECT d.id, d.title, d.description, d.status, d.decision_date, d.decision_maker_id, u.name AS decision_maker_name FROM decisions d LEFT JOIN users u ON u.id = d.decision_maker_id WHERE d.meeting_id = ? ORDER BY d.created_at",
      m.id,
    );
    const risks = db.all("SELECT r.id, r.title, r.type, r.severity, r.status, r.project_id FROM risks r WHERE r.source_meeting_id = ? ORDER BY r.created_at", m.id);
    const reports = db.all("SELECT id, title, status, version, report_type, created_at FROM reports WHERE meeting_id = ? ORDER BY created_at DESC", m.id);
    const suggestions = suggestionRows(db, m.id);
    const engines = [...new Set(suggestions.map((s) => s.engine))];

    // Meeting history for the same project: previous visible meetings with their decisions + outstanding actions.
    let history: unknown[] = [];
    let completedSinceLast: unknown[] = [];
    if (m.project_id && canViewProject(db, u, m.project_id)) {
      const f = meetingVisibleSql(u, "pm");
      const prev = db.all<{ id: string; title: string; meeting_date: string; status: string; summary: string }>(
        `SELECT pm.id, pm.title, pm.meeting_date, pm.status, pm.summary FROM meetings pm
         WHERE pm.project_id = ? AND pm.id <> ? AND pm.status <> 'cancelled' AND pm.meeting_date <= ? AND ${f.sql}
         ORDER BY pm.meeting_date DESC, pm.start_time DESC LIMIT 6`,
        m.project_id,
        m.id,
        m.meeting_date,
        ...f.params,
      );
      history = prev.map((p) => ({
        ...p,
        decisions: db.all("SELECT id, title, status FROM decisions WHERE meeting_id = ? ORDER BY created_at", p.id),
        outstanding_actions: db.all(
          `SELECT t.id, t.ref, t.title, t.status, t.due_date, a.name AS assignee_name FROM tasks t LEFT JOIN users a ON a.id = t.assignee_id
           WHERE t.meeting_id = ? AND t.status NOT IN ('completed','cancelled') AND ${tf.sql} ORDER BY t.due_date IS NULL, t.due_date`,
          p.id,
          ...tf.params,
        ),
      }));
      const last = prev[0];
      if (last) {
        completedSinceLast = db.all(
          `SELECT t.id, t.ref, t.title, t.completed_at, a.name AS assignee_name FROM tasks t LEFT JOIN users a ON a.id = t.assignee_id
           WHERE t.project_id = ? AND t.status = 'completed' AND t.completed_at >= ? AND ${tf.sql} ORDER BY t.completed_at DESC LIMIT 30`,
          m.project_id,
          last.meeting_date,
          ...tf.params,
        );
      }
    }
    res.json({
      meeting: {
        ...m,
        project_name: m.project_id ? (db.get<{ name: string }>("SELECT name FROM projects WHERE id = ?", m.project_id)?.name ?? null) : null,
        programme_name: m.programme_id ? (db.get<{ name: string }>("SELECT name FROM programmes WHERE id = ?", m.programme_id)?.name ?? null) : null,
        organiser_name: m.organiser_id ? (db.get<{ name: string }>("SELECT name FROM users WHERE id = ?", m.organiser_id)?.name ?? null) : null,
        approved_by_name: m.approved_by ? (db.get<{ name: string }>("SELECT name FROM users WHERE id = ?", m.approved_by)?.name ?? null) : null,
      },
      participants: participants(db, m.id),
      tasks,
      decisions,
      risks,
      reports,
      suggestions: {
        pending: suggestions.filter((s) => s.status === "pending").length,
        total: suggestions.length,
        engines,
        summary: suggestions.find((s) => s.kind === "summary" && s.status === "pending") ?? null,
      },
      history,
      completed_since_last: completedSinceLast,
      permissions: {
        can_manage: manage,
        can_submit_notes: manage || isParticipant(db, u, m.id),
        can_process: manage && can(u, "ai.use"),
        can_approve: manage,
        can_generate_report: manage && m.status === "approved",
      },
    });
  }),
);

// ---------------------------------------------------------------- update
meetingsRouter.patch(
  "/:id",
  h((req, res) => {
    const u = currentUser(req);
    const db = req.ctx.db;
    assertMeetingManage(db, u, req.params.id);
    const m = getMeeting(db, req.params.id);
    const partial = z.object(meetingBase).partial().extend({ participants: participantsSchema.optional(), summary: zText(10000).optional() });
    const raw = req.body ?? {};
    const b = parsePatch(partial, raw);
    // Defaults from the base schema would overwrite unset fields — only apply keys actually sent.
    const sent = (k: string) => Object.prototype.hasOwnProperty.call(raw, k);
    validateRefs(db, u, { project_id: sent("project_id") ? b.project_id : null, programme_id: sent("programme_id") ? b.programme_id : null, organiser_id: sent("organiser_id") ? b.organiser_id : null });
    const patch: Record<string, unknown> = {};
    for (const k of Object.keys(meetingBase)) {
      if (!sent(k)) continue;
      const v = (b as Record<string, unknown>)[k];
      patch[k] = typeof v === "boolean" ? (v ? 1 : 0) : v;
    }
    if (sent("summary")) {
      patch.summary = b.summary;
      patch.summary_source = "human";
    }
    if (sent("transcript") && b.transcript && !sent("transcript_source")) patch.transcript_source = m.transcript_source || "pasted";
    const st = (patch.start_time ?? m.start_time) as string | null;
    const et = (patch.end_time ?? m.end_time) as string | null;
    if (st && et && et < st) throw badRequest("End time must be after the start time.", { fields: { end_time: "End time must be after the start time." } });
    if (Object.keys(patch).length === 0 && !sent("participants")) throw badRequest("Nothing to update.");
    db.tx(() => {
      db.update("meetings", m.id, { ...patch, updated_at: nowIso() });
      if (sent("participants") && b.participants) setParticipants(db, m.id, b.participants, ((patch.meeting_date as string) ?? m.meeting_date) < orgToday(db));
    });
    audit(db, req, "meeting.update", { type: "meeting", id: m.id }, { fields: Object.keys(patch).concat(sent("participants") ? ["participants"] : []) });
    res.json({ ok: true });
  }),
);

meetingsRouter.post(
  "/:id/notes",
  h((req, res) => {
    const u = currentUser(req);
    const db = req.ctx.db;
    assertMeetingView(db, u, req.params.id);
    const m = getMeeting(db, req.params.id);
    if (!canManageMeeting(db, u, m.id) && !isParticipant(db, u, m.id)) throw forbidden("Only participants or the organiser can submit notes.");
    if (m.status === "approved") throw badRequest("This meeting record has been approved. Ask the organiser to reopen it before changing notes.");
    if (m.status === "cancelled") throw badRequest("This meeting was cancelled.");
    const b = parse(
      z.object({ notes: zText(100000).optional(), transcript: zText(400000).optional(), transcript_source: zText(200).optional(), key_points: zText(10000).optional() }),
      req.body,
    );
    const notes = b.notes ?? m.notes;
    const transcript = b.transcript ?? m.transcript;
    if (!notes.trim() && !transcript.trim()) throw badRequest("Add notes or a transcript first.", { fields: { notes: "Notes are empty." } });
    db.update("meetings", m.id, {
      notes,
      transcript,
      transcript_source: b.transcript !== undefined ? (b.transcript ? b.transcript_source || "pasted" : "") : undefined,
      key_points: b.key_points,
      status: "notes_submitted",
      review_status: "pending",
      updated_at: nowIso(),
    });
    statusChange(db, u.id, "meeting", m.id, "status", m.status, "notes_submitted");
    activity(db, u, "meeting.notes_submitted", { type: "meeting", id: m.id, label: m.title }, { projectId: m.project_id });
    if (m.organiser_id && m.organiser_id !== u.id) {
      notify(db, { userId: m.organiser_id, actorId: u.id, type: "meeting_actions", title: `${u.name} submitted notes for “${m.title}”`, entity: { type: "meeting", id: m.id } });
    }
    res.json({ ok: true });
  }),
);

meetingsRouter.delete(
  "/:id",
  h((req, res) => {
    const u = currentUser(req);
    const db = req.ctx.db;
    assertMeetingManage(db, u, req.params.id);
    const m = getMeeting(db, req.params.id);
    if (m.status === "cancelled") return res.json({ ok: true });
    db.update("meetings", m.id, { status: "cancelled", updated_at: nowIso() });
    statusChange(db, u.id, "meeting", m.id, "status", m.status, "cancelled");
    audit(db, req, "meeting.cancel", { type: "meeting", id: m.id });
    for (const p of participants(db, m.id)) {
      if (p.user_id && m.meeting_date >= orgToday(db)) notify(db, { userId: p.user_id, actorId: u.id, type: "meeting_upcoming", title: `Cancelled: “${m.title}” on ${m.meeting_date}`, entity: { type: "meeting", id: m.id } });
    }
    res.json({ ok: true });
  }),
);

// ---------------------------------------------------------------- AI / rule-based processing
meetingsRouter.post(
  "/:id/process",
  h(async (req, res) => {
    const u = currentUser(req);
    const db = req.ctx.db;
    assertMeetingManage(db, u, req.params.id);
    if (!can(u, "ai.use")) throw forbidden("You do not have permission to use AI-assisted features.");
    const m = getMeeting(db, req.params.id);
    if (!m.notes.trim() && !m.transcript.trim()) throw badRequest("Submit meeting notes or a transcript before extracting actions.");
    if (m.status === "approved") throw badRequest("This meeting is already approved.");
    const ppl = participants(db, m.id)
      .map((p) => ({ id: p.user_id, name: p.name ?? p.external_name }))
      .filter((p) => !!p.name) as { id: string | null; name: string }[];
    const projectName = m.project_id ? (db.get<{ name: string }>("SELECT name FROM projects WHERE id = ?", m.project_id)?.name ?? null) : null;
    const { engine, analysis } = await analyseMeeting(req.ctx, u.id, { title: m.title, date: m.meeting_date, projectName, participants: ppl, notes: m.notes, transcript: m.transcript });
    const byName = (name: string) => {
      if (!name) return null;
      const n = name.trim().toLowerCase();
      const exact = ppl.find((p) => p.name.toLowerCase() === n);
      if (exact) return exact.id;
      const first = ppl.filter((p) => p.name.toLowerCase().split(/\s+/)[0] === n.split(/\s+/)[0]);
      return first.length === 1 ? first[0].id : null;
    };
    const now = nowIso();
    let count = 0;
    db.tx(() => {
      db.run("DELETE FROM ai_suggestions WHERE source_type = 'meeting' AND source_id = ? AND status = 'pending'", m.id);
      const add = (kind: string, payload: Record<string, unknown>) => {
        db.insert("ai_suggestions", { id: newId("sug"), source_type: "meeting", source_id: m.id, kind, payload: JSON.stringify(payload), status: "pending", engine, created_at: now });
        count++;
      };
      if (analysis.summary) add("summary", { text: analysis.summary, key_topics: analysis.key_topics });
      for (const a of analysis.actions) {
        const validDate = /^\d{4}-\d{2}-\d{2}$/.test(a.due_date) ? a.due_date : "";
        add("action", { ...a, due_date: validDate, owner_id: byName(a.owner_name), project_id: m.project_id });
      }
      for (const d of analysis.decisions) add("decision", d);
      for (const r of analysis.risks) add(r.kind === "blocker" ? "blocker" : "risk", r);
      for (const q of analysis.follow_up_questions) add("follow_up_question", { text: q });
      if (analysis.project_update && m.project_id) add("project_update", { text: analysis.project_update, project_id: m.project_id });
      for (const k of analysis.knowledge_items) add("knowledge", k);
      db.update("meetings", m.id, { status: "in_review", review_status: "pending", updated_at: now });
    });
    statusChange(db, u.id, "meeting", m.id, "status", m.status, "in_review");
    activity(db, u, "meeting.processed", { type: "meeting", id: m.id, label: m.title }, { projectId: m.project_id, detail: `${count} suggestion(s) generated (${engine === "rules" ? "rule-based" : "AI"})` });
    audit(db, req, "meeting.process", { type: "meeting", id: m.id }, { engine, suggestions: count });
    const owner = m.organiser_id ?? m.created_by;
    if (owner && owner !== u.id) notify(db, { userId: owner, actorId: u.id, type: "meeting_actions", title: `Suggested actions are ready for review: ${m.title}`, entity: { type: "meeting", id: m.id }, link: `/meetings/${m.id}/review` });
    res.json({ ok: true, engine, count });
  }),
);

meetingsRouter.get(
  "/:id/suggestions",
  h((req, res) => {
    const u = currentUser(req);
    const db = req.ctx.db;
    assertMeetingView(db, u, req.params.id);
    const m = getMeeting(db, req.params.id);
    if (!canManageMeeting(db, u, m.id)) throw forbidden("Only the meeting owner can review suggestions.");
    res.json({ items: suggestionRows(db, m.id), participants: participants(db, m.id), project_id: m.project_id, meeting_title: m.title, meeting_status: m.status });
  }),
);

const acceptSchema = z
  .object({
    title: z.string().trim().min(1, "A title is required.").max(300).optional(),
    description: zText(5000).optional(),
    text: zText(10000).optional(),
    owner_id: zOptId,
    due_date: zOptDate,
    priority: z.enum(["low", "normal", "high", "urgent"]).optional(),
    severity: z.enum(["low", "medium", "high", "critical"]).optional(),
    project_id: zOptId,
  })
  .partial();

type AcceptInput = z.infer<typeof acceptSchema>;

function acceptSuggestion(req: Request, meeting: MeetingRow, sid: string, edits: AcceptInput, rawEdits: Record<string, unknown>) {
  const u = currentUser(req);
  const db = req.ctx.db;
  const s = db.get<{ id: string; kind: string; payload: string; status: string; engine: string }>("SELECT * FROM ai_suggestions WHERE id = ? AND source_type = 'meeting' AND source_id = ?", sid, meeting.id);
  if (!s) throw notFound("Suggestion not found.");
  if (s.status !== "pending") throw badRequest("This suggestion has already been reviewed.");
  const p = safeJson(s.payload) as Record<string, string | null>;
  const edited = Object.keys(rawEdits).length > 0;
  const now = nowIso();
  const projectId = (rawEdits.project_id !== undefined ? edits.project_id : null) ?? meeting.project_id;
  if (projectId && !canViewProject(db, u, projectId)) throw badRequest("Choose a project you have access to.");
  let resultType: string | null = null;
  let resultId: string | null = null;

  db.tx(() => {
    switch (s.kind) {
      case "action": {
        const title = (edits.title ?? p.title ?? "").trim();
        if (!title) throw badRequest("An action needs a title.", { fields: { title: "Required." } });
        const ownerId = rawEdits.owner_id !== undefined ? (edits.owner_id ?? null) : (p.owner_id ?? null);
        if (ownerId && !db.get("SELECT 1 FROM users WHERE id = ? AND active = 1", ownerId)) throw badRequest("Unknown owner.", { fields: { owner_id: "Unknown person." } });
        const due = rawEdits.due_date !== undefined ? (edits.due_date ?? null) : p.due_date || null;
        // The reviewer accepting the suggestion doesn't mean the named person accepted it: they must confirm.
        const status = !ownerId || ownerId === u.id ? "todo" : "suggested";
        const id = newId("tsk");
        db.insert("tasks", {
          id,
          ref: nextTaskRef(db),
          title,
          description: edits.description ?? p.detail ?? "",
          assignee_id: ownerId,
          creator_id: u.id,
          project_id: projectId,
          meeting_id: meeting.id,
          source: "meeting",
          source_ref: String(p.evidence ?? "").slice(0, 1000),
          priority: edits.priority ?? "normal",
          status,
          due_date: due,
          created_at: now,
          updated_at: now,
        });
        resultType = "task";
        resultId = id;
        activity(db, u, "task.created", { type: "task", id, label: title }, { projectId, detail: `From meeting “${meeting.title}”` });
        audit(db, req, "task.assign", { type: "task", id }, { assignee: ownerId, status, from: "meeting_suggestion" });
        if (ownerId && ownerId !== u.id) {
          notify(db, {
            userId: ownerId,
            actorId: u.id,
            type: "task_suggested",
            title: `A meeting action was suggested for you: ${title} — please confirm`,
            body: `From “${meeting.title}” (${meeting.meeting_date}).`,
            entity: { type: "task", id },
          });
        }
        break;
      }
      case "decision": {
        const title = (edits.title ?? p.title ?? "").trim();
        if (!title) throw badRequest("A decision needs a title.");
        const id = newId("dec");
        db.insert("decisions", {
          id,
          title,
          description: edits.description ?? p.detail ?? "",
          context: `Recorded from meeting “${meeting.title}” (${meeting.meeting_date}). Evidence: ${String(p.evidence ?? "").slice(0, 500)}`,
          project_id: projectId,
          meeting_id: meeting.id,
          decision_maker_id: rawEdits.owner_id !== undefined ? (edits.owner_id ?? null) : null,
          decision_date: meeting.meeting_date,
          status: "made",
          created_by: u.id,
          created_at: now,
          updated_at: now,
        });
        resultType = "decision";
        resultId = id;
        activity(db, u, "decision.recorded", { type: "decision", id, label: title }, { projectId });
        break;
      }
      case "risk":
      case "blocker": {
        if (!projectId) throw badRequest("Risks are recorded in a project risk register. Link this meeting to a project (or choose one) before accepting.");
        const title = (edits.title ?? p.title ?? "").trim();
        if (!title) throw badRequest("A risk needs a title.");
        const id = newId("rsk");
        db.insert("risks", {
          id,
          project_id: projectId,
          type: s.kind === "blocker" ? "blocker" : "risk",
          title,
          description: edits.description ?? p.detail ?? "",
          severity: edits.severity ?? (s.kind === "blocker" ? "high" : "medium"),
          owner_id: rawEdits.owner_id !== undefined ? (edits.owner_id ?? null) : null,
          identified_date: meeting.meeting_date,
          status: "open",
          source_meeting_id: meeting.id,
          created_by: u.id,
          created_at: now,
          updated_at: now,
        });
        resultType = "risk";
        resultId = id;
        activity(db, u, "risk.identified", { type: "risk", id, label: title }, { projectId });
        const projOwner = db.get<{ owner_id: string | null }>("SELECT owner_id FROM projects WHERE id = ?", projectId)?.owner_id;
        notify(db, { userId: projOwner, actorId: u.id, type: "risk_identified", title: `${s.kind === "blocker" ? "Blocker" : "Risk"} identified: ${title}`, entity: { type: "project", id: projectId } });
        break;
      }
      case "project_update": {
        if (!projectId) throw badRequest("Project updates need a linked project.");
        if (!canManageProject(db, u, projectId)) throw forbidden("Only the project owner or manager can post project updates.");
        const text = (edits.text ?? p.text ?? "").trim();
        if (!text) throw badRequest("The update is empty.");
        const id = newId("pup");
        db.insert("project_updates", { id, project_id: projectId, author_id: u.id, summary: text, period_end: meeting.meeting_date, created_at: now });
        resultType = "project_update";
        resultId = id;
        activity(db, u, "project.update", { type: "project", id: projectId, label: db.get<{ name: string }>("SELECT name FROM projects WHERE id = ?", projectId)?.name ?? "" }, { projectId, detail: text.slice(0, 300) });
        break;
      }
      case "knowledge": {
        const title = (edits.title ?? p.title ?? "").trim();
        if (!title) throw badRequest("A knowledge item needs a title.");
        const id = newId("kno");
        db.insert("knowledge_items", {
          id,
          title,
          summary: (edits.text ?? p.insight ?? "").slice(0, 2000),
          body: `${edits.text ?? p.insight ?? ""}\n\nSource: meeting “${meeting.title}” (${meeting.meeting_date}).`,
          category: "Meeting insights",
          item_type: "insight",
          author_id: u.id,
          owner_id: u.id,
          source: `Meeting: ${meeting.title}`,
          project_id: projectId,
          access_level: meeting.confidential ? "restricted" : projectId ? "project" : "all_staff",
          status: "in_review",
          source_type: "meeting",
          source_id: meeting.id,
          created_at: now,
          updated_at: now,
        });
        if (meeting.confidential) db.run("INSERT OR IGNORE INTO knowledge_access (knowledge_id, user_id) VALUES (?, ?)", id, u.id);
        resultType = "knowledge";
        resultId = id;
        activity(db, u, "knowledge.submitted", { type: "knowledge", id, label: title }, { projectId });
        break;
      }
      case "summary": {
        const text = (edits.text ?? p.text ?? "").trim();
        if (!text) throw badRequest("The summary is empty.");
        db.update("meetings", meeting.id, { summary: text, summary_source: edited ? "human" : "ai_approved", updated_at: now });
        resultType = "meeting";
        resultId = meeting.id;
        break;
      }
      case "follow_up_question": {
        // Accepting a question records it in the meeting's key points for follow-up.
        const text = (edits.text ?? p.text ?? "").trim();
        const cur = db.get<{ key_points: string }>("SELECT key_points FROM meetings WHERE id = ?", meeting.id)!.key_points;
        db.update("meetings", meeting.id, { key_points: `${cur ? cur + "\n" : ""}Follow-up: ${text}`, updated_at: now });
        resultType = "meeting";
        resultId = meeting.id;
        break;
      }
      default:
        throw badRequest("Unsupported suggestion type.");
    }
    db.update("ai_suggestions", s.id, {
      status: edited ? "edited_accepted" : "accepted",
      resulting_type: resultType,
      resulting_id: resultId,
      reviewed_by: u.id,
      reviewed_at: now,
      payload: edited ? JSON.stringify({ ...p, ...rawEdits, original: p }) : undefined,
    });
  });
  return { resulting_type: resultType, resulting_id: resultId };
}

function loadForReview(req: Request) {
  const u = currentUser(req);
  const db = req.ctx.db;
  assertMeetingView(db, u, req.params.id);
  const m = getMeeting(db, req.params.id);
  if (!canManageMeeting(db, u, m.id)) throw forbidden("Only the meeting owner can review suggestions.");
  return m;
}

meetingsRouter.post(
  "/:id/suggestions/:sid/accept",
  h((req, res) => {
    const m = loadForReview(req);
    const raw = (req.body ?? {}) as Record<string, unknown>;
    const edits = parse(acceptSchema, raw);
    const out = acceptSuggestion(req, m, req.params.sid, edits, raw);
    res.json({ ok: true, ...out });
  }),
);

meetingsRouter.post(
  "/:id/suggestions/:sid/reject",
  h((req, res) => {
    const u = currentUser(req);
    const m = loadForReview(req);
    const db = req.ctx.db;
    const s = db.get<{ status: string }>("SELECT status FROM ai_suggestions WHERE id = ? AND source_type = 'meeting' AND source_id = ?", req.params.sid, m.id);
    if (!s) throw notFound("Suggestion not found.");
    if (s.status !== "pending") throw badRequest("This suggestion has already been reviewed.");
    db.update("ai_suggestions", req.params.sid, { status: "rejected", reviewed_by: u.id, reviewed_at: nowIso() });
    res.json({ ok: true });
  }),
);

meetingsRouter.post(
  "/:id/suggestions/bulk",
  h((req, res) => {
    const u = currentUser(req);
    const m = loadForReview(req);
    const db = req.ctx.db;
    const b = parse(z.object({ ids: z.array(z.string()).min(1, "Select at least one suggestion.").max(200), action: z.enum(["accept", "reject"]) }), req.body);
    const results: { id: string; ok: boolean; error?: string }[] = [];
    for (const id of b.ids) {
      try {
        if (b.action === "accept") acceptSuggestion(req, m, id, {}, {});
        else {
          const s = db.get<{ status: string }>("SELECT status FROM ai_suggestions WHERE id = ? AND source_type = 'meeting' AND source_id = ?", id, m.id);
          if (!s) throw notFound("Suggestion not found.");
          if (s.status !== "pending") throw badRequest("Already reviewed.");
          db.update("ai_suggestions", id, { status: "rejected", reviewed_by: u.id, reviewed_at: nowIso() });
        }
        results.push({ id, ok: true });
      } catch (e) {
        results.push({ id, ok: false, error: e instanceof Error ? e.message : "Failed" });
      }
    }
    res.json({ results, accepted: results.filter((r) => r.ok).length, failed: results.filter((r) => !r.ok).length });
  }),
);

// ---------------------------------------------------------------- approval & decisions
meetingsRouter.post(
  "/:id/approve",
  h((req, res) => {
    const u = currentUser(req);
    const db = req.ctx.db;
    assertMeetingManage(db, u, req.params.id);
    const m = getMeeting(db, req.params.id);
    if (m.status === "approved") throw badRequest("This meeting is already approved.");
    if (m.status === "cancelled") throw badRequest("A cancelled meeting cannot be approved.");
    if (!m.notes.trim() && !m.summary.trim()) throw badRequest("Add meeting notes or a summary before approving the record.");
    const b = parse(z.object({ summary: zText(10000).optional() }), req.body ?? {});
    const pending = db.get<{ n: number }>("SELECT COUNT(*) n FROM ai_suggestions WHERE source_type='meeting' AND source_id = ? AND status = 'pending'", m.id)!.n;
    const now = nowIso();
    db.update("meetings", m.id, {
      status: "approved",
      review_status: "approved",
      approved_by: u.id,
      approved_at: now,
      summary: b.summary !== undefined ? b.summary : undefined,
      summary_source: b.summary !== undefined ? "human" : undefined,
      updated_at: now,
    });
    statusChange(db, u.id, "meeting", m.id, "status", m.status, "approved");
    audit(db, req, "meeting.approve", { type: "meeting", id: m.id }, { pending_suggestions_left: pending });
    activity(db, u, "meeting.approved", { type: "meeting", id: m.id, label: m.title }, { projectId: m.project_id });
    res.json({ ok: true, pending_suggestions_left: pending });
  }),
);

meetingsRouter.post(
  "/:id/reopen",
  h((req, res) => {
    const u = currentUser(req);
    const db = req.ctx.db;
    assertMeetingManage(db, u, req.params.id);
    const m = getMeeting(db, req.params.id);
    if (m.status !== "approved") throw badRequest("Only approved meetings can be reopened.");
    db.update("meetings", m.id, { status: "notes_submitted", review_status: "pending", approved_by: null, approved_at: null, updated_at: nowIso() });
    statusChange(db, u.id, "meeting", m.id, "status", m.status, "notes_submitted", "Reopened");
    audit(db, req, "meeting.reopen", { type: "meeting", id: m.id });
    res.json({ ok: true });
  }),
);

meetingsRouter.post(
  "/:id/decisions",
  h((req, res) => {
    const u = currentUser(req);
    const db = req.ctx.db;
    assertMeetingManage(db, u, req.params.id);
    const m = getMeeting(db, req.params.id);
    const b = parse(
      z.object({
        title: zTitle,
        description: zText(5000).optional().default(""),
        context: zText(5000).optional().default(""),
        decision_maker_id: zOptId,
        status: z.enum(["proposed", "pending_approval", "made"]).optional().default("made"),
        requires_management: z.boolean().optional().default(false),
      }),
      req.body,
    );
    if (b.decision_maker_id && !db.get("SELECT 1 FROM users WHERE id = ?", b.decision_maker_id)) throw badRequest("Unknown decision maker.");
    const id = newId("dec");
    const now = nowIso();
    db.insert("decisions", {
      id,
      title: b.title,
      description: b.description,
      context: b.context,
      project_id: m.project_id,
      meeting_id: m.id,
      decision_maker_id: b.decision_maker_id,
      decision_date: b.status === "made" ? m.meeting_date : null,
      status: b.status,
      requires_management: b.requires_management ? 1 : 0,
      created_by: u.id,
      created_at: now,
      updated_at: now,
    });
    activity(db, u, "decision.recorded", { type: "decision", id, label: b.title }, { projectId: m.project_id });
    audit(db, req, "decision.create", { type: "decision", id }, { meeting: m.id, status: b.status });
    res.status(201).json({ id });
  }),
);

// ---------------------------------------------------------------- call report
meetingsRouter.get(
  "/:id/report-templates",
  h((req, res) => {
    const u = currentUser(req);
    const db = req.ctx.db;
    assertMeetingView(db, u, req.params.id);
    res.json(db.all("SELECT id, name, is_default FROM report_templates WHERE report_type = 'call_report' AND active = 1 ORDER BY is_default DESC, name"));
  }),
);

meetingsRouter.post(
  "/:id/call-report",
  h((req, res) => {
    const u = currentUser(req);
    const db = req.ctx.db;
    assertMeetingManage(db, u, req.params.id);
    const m = getMeeting(db, req.params.id);
    if (m.status !== "approved") throw badRequest("Approve the meeting record first. Call reports are generated only from approved meeting information.");
    const b = parse(z.object({ template_id: zOptId }), req.body ?? {});
    const tpl =
      (b.template_id ? db.get<{ id: string; sections: string; name: string }>("SELECT id, sections, name FROM report_templates WHERE id = ? AND report_type = 'call_report' AND active = 1", b.template_id) : undefined) ??
      db.get<{ id: string; sections: string; name: string }>("SELECT id, sections, name FROM report_templates WHERE report_type = 'call_report' AND active = 1 ORDER BY is_default DESC LIMIT 1");
    if (b.template_id && tpl?.id !== b.template_id) throw badRequest("Unknown report template.");
    const enabled: { key: string; title: string }[] = tpl ? (safeArr(tpl.sections) as { key: string; title: string; enabled: boolean }[]).filter((s) => s.enabled !== false) : [];
    const sections = buildCallReportSections(db, m, enabled.length ? enabled : DEFAULT_CALL_SECTIONS);
    const flags: string[] = [];
    if (!m.summary.trim()) flags.push("No approved meeting summary — overview uses the purpose/notes headline only.");
    const pending = db.get<{ n: number }>("SELECT COUNT(*) n FROM ai_suggestions WHERE source_type='meeting' AND source_id = ? AND status = 'pending'", m.id)!.n;
    if (pending) flags.push(`${pending} suggestion(s) were not reviewed and are excluded from this report.`);
    const noOwner = db.get<{ n: number }>("SELECT COUNT(*) n FROM tasks WHERE meeting_id = ? AND assignee_id IS NULL AND status <> 'cancelled'", m.id)!.n;
    if (noOwner) flags.push(`${noOwner} action item(s) have no responsible person.`);
    const noDue = db.get<{ n: number }>("SELECT COUNT(*) n FROM tasks WHERE meeting_id = ? AND due_date IS NULL AND status NOT IN ('cancelled','completed')", m.id)!.n;
    if (noDue) flags.push(`${noDue} action item(s) have no deadline.`);
    const id = newId("rep");
    const now = nowIso();
    const content = JSON.stringify({ sections });
    db.tx(() => {
      db.insert("reports", {
        id,
        report_type: "call_report",
        title: `Call report — ${m.title}`,
        meeting_id: m.id,
        project_id: m.project_id,
        template_id: tpl?.id ?? null,
        content,
        status: "draft",
        audience: "participants",
        version: 1,
        generated_by: "system",
        author_id: u.id,
        source_records: JSON.stringify([{ type: "meeting", id: m.id, label: m.title }]),
        quality_flags: JSON.stringify(flags),
        created_at: now,
        updated_at: now,
      });
      db.insert("report_versions", { id: newId("rpv"), report_id: id, version: 1, content, status: "draft", changed_by: u.id, change_note: "Generated from approved meeting record", created_at: now });
    });
    activity(db, u, "report.generated", { type: "report", id, label: `Call report — ${m.title}` }, { projectId: m.project_id });
    audit(db, req, "report.generate", { type: "report", id }, { meeting: m.id, template: tpl?.name });
    res.status(201).json({ id });
  }),
);

const DEFAULT_CALL_SECTIONS = [
  { key: "overview", title: "Meeting overview" },
  { key: "participants", title: "Participants" },
  { key: "discussion", title: "Key discussion points" },
  { key: "decisions", title: "Decisions" },
  { key: "actions", title: "Action items" },
  { key: "risks", title: "Risks and blockers" },
  { key: "next_steps", title: "Next steps" },
  { key: "project_context", title: "Project context" },
  { key: "documents", title: "Related documents" },
];

function safeArr(s: string): unknown[] {
  try {
    const v = JSON.parse(s);
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

interface Section {
  key: string;
  title: string;
  body?: string;
  items?: string[];
  sources?: { type: string; id: string; label: string }[];
}

export function buildCallReportSections(db: Db, m: MeetingRow, wanted: { key: string; title: string }[]): Section[] {
  const out: Section[] = [];
  const meetingSrc = { type: "meeting", id: m.id, label: m.title };
  const ppl = participants(db, m.id);
  const project = m.project_id ? db.get<{ id: string; name: string; status: string; health: string; target_date: string | null; description: string }>("SELECT id, name, status, health, target_date, description FROM projects WHERE id = ?", m.project_id) : undefined;
  const when = `${m.meeting_date}${m.start_time ? ` ${m.start_time}${m.end_time ? `–${m.end_time}` : ""}` : ""} (${m.timezone})`;
  for (const w of wanted) {
    const s: Section = { key: w.key, title: w.title };
    switch (w.key) {
      case "overview":
        s.body = [
          `${m.title} — ${m.meeting_type}, ${when}${m.location ? `, ${m.location}` : ""}.`,
          m.purpose ? `Purpose: ${m.purpose}` : "",
          m.summary || "",
        ]
          .filter(Boolean)
          .join("\n\n");
        s.sources = [meetingSrc];
        break;
      case "participants":
        s.items = ppl.map((p) => (p.user_id ? `${p.name}` : `${p.external_name}${p.external_org ? ` (${p.external_org})` : ""}`) + (p.attendance === "apologies" ? " — apologies" : ""));
        break;
      case "discussion": {
        const pts = m.key_points
          .split(/\r?\n/)
          .map((l) => l.replace(/^\s*[-*•]\s*/, "").trim())
          .filter(Boolean);
        if (pts.length) s.items = pts;
        else s.body = "No key discussion points were recorded on the approved meeting record.";
        break;
      }
      case "decisions": {
        const ds = db.all<{ id: string; title: string; status: string; dm: string | null }>(
          "SELECT d.id, d.title, d.status, u.name AS dm FROM decisions d LEFT JOIN users u ON u.id = d.decision_maker_id WHERE d.meeting_id = ? AND d.status NOT IN ('rejected') ORDER BY d.created_at",
          m.id,
        );
        s.items = ds.map((d) => `${d.title}${d.status !== "made" && d.status !== "approved" ? ` (${d.status.replace(/_/g, " ")})` : ""}${d.dm ? ` — ${d.dm}` : ""}`);
        s.sources = ds.map((d) => ({ type: "decision", id: d.id, label: d.title }));
        if (!ds.length) s.body = "No decisions were recorded.";
        break;
      }
      case "actions": {
        // Only confirmed responsibilities and unassigned actions; 'suggested' tasks are pending confirmation.
        const ts = db.all<{ id: string; ref: number; title: string; status: string; due_date: string | null; who: string | null }>(
          "SELECT t.id, t.ref, t.title, t.status, t.due_date, u.name AS who FROM tasks t LEFT JOIN users u ON u.id = t.assignee_id WHERE t.meeting_id = ? AND t.status <> 'cancelled' AND t.is_personal = 0 ORDER BY t.due_date IS NULL, t.due_date",
          m.id,
        );
        s.items = ts.map(
          (t) =>
            `${t.who ?? "Owner not yet assigned"} — ${t.title}${t.due_date ? ` (due ${t.due_date})` : " (no deadline stated)"}${t.status === "suggested" ? " [awaiting owner confirmation]" : t.status === "completed" ? " [completed]" : ""}`,
        );
        s.sources = ts.map((t) => ({ type: "task", id: t.id, label: `T-${t.ref}` }));
        if (!ts.length) s.body = "No action items were recorded.";
        break;
      }
      case "risks": {
        const rs = db.all<{ id: string; title: string; type: string; severity: string; status: string }>("SELECT id, title, type, severity, status FROM risks WHERE source_meeting_id = ? ORDER BY created_at", m.id);
        s.items = rs.map((r) => `${r.type === "blocker" ? "Blocker" : r.type === "issue" ? "Issue" : "Risk"} (${r.severity}): ${r.title} — ${r.status}`);
        s.sources = rs.map((r) => ({ type: "risk", id: r.id, label: r.title }));
        if (!rs.length) s.body = "No risks or blockers were recorded.";
        break;
      }
      case "next_steps": {
        const lines: string[] = [];
        if (m.follow_up_date) lines.push(`Follow-up scheduled for ${m.follow_up_date}.`);
        const open = db.get<{ n: number }>("SELECT COUNT(*) n FROM tasks WHERE meeting_id = ? AND status NOT IN ('completed','cancelled')", m.id)!.n;
        if (open) lines.push(`${open} action item(s) remain open.`);
        s.body = lines.join(" ") || "No follow-up date was set.";
        break;
      }
      case "project_context":
        if (!project) {
          s.body = "This meeting is not linked to a project.";
        } else {
          const next = db.get<{ title: string; target_date: string | null }>("SELECT title, target_date FROM milestones WHERE project_id = ? AND status IN ('not_started','in_progress') ORDER BY target_date IS NULL, target_date LIMIT 1", project.id);
          s.body = `${project.name} — status: ${project.status.replace(/_/g, " ")}, health: ${project.health.replace(/_/g, " ")}${project.target_date ? `, target date ${project.target_date}` : ""}.${next ? ` Next milestone: ${next.title}${next.target_date ? ` (${next.target_date})` : ""}.` : ""}`;
          s.sources = [{ type: "project", id: project.id, label: project.name }];
        }
        break;
      case "documents": {
        const docs = db.all<{ title: string; url: string }>("SELECT title, url FROM attachments WHERE entity_type = 'meeting' AND entity_id = ? ORDER BY created_at", m.id);
        s.items = docs.map((d) => `${d.title}: ${d.url}`);
        if (!docs.length) s.body = "No documents were linked to the meeting.";
        break;
      }
      default:
        s.body = "";
    }
    out.push(s);
  }
  return out;
}
