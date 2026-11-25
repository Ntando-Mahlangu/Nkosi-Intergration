/**
 * My CSI Workspace API (spec §8): the personal landing page. Everything here is
 * scoped to the signed-in user and derived from real records (no hardcoded counts).
 */
import { Router } from "express";
import { h } from "../lib/http.js";
import { currentUser } from "../lib/context.js";
import { taskVisibleSql, canViewEntity, canViewProject, projectRole } from "../lib/access.js";
import { getSetting, resolveToday } from "../lib/events.js";
import { addDays } from "../lib/ids.js";
import { projectProgress } from "../lib/progress.js";

export const workspaceRouter = Router();
const OPEN = "('todo','in_progress','blocked','awaiting_review')";

workspaceRouter.get(
  "/summary",
  h((req, res) => {
    const u = currentUser(req);
    const db = req.ctx.db;
    const today = resolveToday(db, req.query.today);
    const n = (sql: string, ...p: (string | number)[]) => db.get<{ n: number }>(sql, ...p)!.n;
    const open = n(`SELECT COUNT(*) n FROM tasks WHERE assignee_id = ? AND status IN ${OPEN}`, u.id);
    const dueToday = n(`SELECT COUNT(*) n FROM tasks WHERE assignee_id = ? AND status IN ${OPEN} AND due_date = ?`, u.id, today);
    const overdue = n(`SELECT COUNT(*) n FROM tasks WHERE assignee_id = ? AND status IN ${OPEN} AND due_date < ?`, u.id, today);
    const week = n(`SELECT COUNT(*) n FROM tasks WHERE assignee_id = ? AND status IN ${OPEN} AND due_date >= ? AND due_date <= ?`, u.id, today, addDays(today, 6));
    const toReview = n("SELECT COUNT(*) n FROM tasks WHERE reviewer_id = ? AND status = 'awaiting_review' AND assignee_id <> ?", u.id, u.id);
    const mySubmissions = n("SELECT COUNT(*) n FROM tasks WHERE assignee_id = ? AND status = 'awaiting_review'", u.id);
    const suggested = n("SELECT COUNT(*) n FROM tasks WHERE assignee_id = ? AND status = 'suggested'", u.id);
    const completedWeek = n("SELECT COUNT(*) n FROM tasks WHERE assignee_id = ? AND status = 'completed' AND substr(completed_at, 1, 10) >= ?", u.id, addDays(today, -6));
    res.json({
      today,
      user: { first_name: u.name.split(/\s+/)[0], name: u.name, role_name: u.role_name },
      org: { name: getSetting(db, "org.name", "Change Science Institute") },
      counts: {
        open,
        due_today: dueToday,
        overdue,
        due_this_week: week,
        completed_this_week: completedWeek,
        awaiting_review: { total: toReview + mySubmissions, to_review_by_me: toReview, my_submissions: mySubmissions, suggested_for_me: suggested },
      },
    });
  }),
);

workspaceRouter.get(
  "/projects",
  h((req, res) => {
    const u = currentUser(req);
    const db = req.ctx.db;
    const today = resolveToday(db, req.query.today);
    const rows = db.all<{ id: string; name: string; code: string | null; status: string; health: string; owner_id: string | null; owner_name: string | null; target_date: string | null }>(
      `SELECT p.id, p.name, p.code, p.status, p.health, p.owner_id, uo.name AS owner_name, p.target_date
       FROM projects p LEFT JOIN users uo ON uo.id = p.owner_id
       WHERE (p.owner_id = ? OR EXISTS (SELECT 1 FROM project_members pm WHERE pm.project_id = p.id AND pm.user_id = ?))
         AND p.status NOT IN ('completed','cancelled')
       ORDER BY CASE p.status WHEN 'active' THEN 0 WHEN 'at_risk' THEN 0 WHEN 'planning' THEN 1 ELSE 2 END, p.target_date IS NULL, p.target_date`,
      u.id,
      u.id,
    );
    res.json(
      rows.map((p) => {
        const nextMs = db.get<{ title: string; target_date: string | null }>(
          "SELECT title, target_date FROM milestones WHERE project_id = ? AND status IN ('not_started','in_progress') ORDER BY target_date IS NULL, target_date LIMIT 1",
          p.id,
        );
        const nextDl = db.get<{ name: string; due_date: string }>(
          "SELECT name, due_date FROM deliverables WHERE project_id = ? AND status NOT IN ('approved','completed','cancelled') AND due_date IS NOT NULL AND due_date >= ? ORDER BY due_date LIMIT 1",
          p.id,
          today,
        );
        const candidates = [nextMs?.target_date && nextMs.target_date >= today ? { label: nextMs.title, date: nextMs.target_date } : null, nextDl ? { label: nextDl.name, date: nextDl.due_date } : null].filter(Boolean) as { label: string; date: string }[];
        candidates.sort((a, b) => a.date.localeCompare(b.date));
        const deadline = candidates[0] ?? (p.target_date ? { label: "Project target date", date: p.target_date } : null);
        const mine = db.get<{ n: number; overdue: number }>(
          `SELECT COUNT(*) n, SUM(due_date < ?) overdue FROM tasks WHERE project_id = ? AND assignee_id = ? AND status IN ${OPEN}`,
          today,
          p.id,
          u.id,
        )!;
        return {
          ...p,
          my_role: projectRole(db, u, p.id),
          progress: projectProgress(db, p.id),
          next_milestone: nextMs ?? null,
          next_deadline: deadline,
          my_outstanding: mine.n,
          my_overdue: mine.overdue ?? 0,
        };
      }),
    );
  }),
);

workspaceRouter.get(
  "/meetings",
  h((req, res) => {
    const u = currentUser(req);
    const db = req.ctx.db;
    const today = resolveToday(db, req.query.today);
    const rows = db.all<{ id: string; title: string; meeting_date: string; start_time: string | null; end_time: string | null; project_id: string | null; project_name: string | null; meeting_link: string; location: string; preparation_required: number; preparation_notes: string; status: string; meeting_type: string }>(
      `SELECT m.id, m.title, m.meeting_date, m.start_time, m.end_time, m.project_id, p.name AS project_name, m.meeting_link, m.location,
              m.preparation_required, m.preparation_notes, m.status, m.meeting_type
       FROM meetings m LEFT JOIN projects p ON p.id = m.project_id
       WHERE (m.organiser_id = ? OR EXISTS (SELECT 1 FROM meeting_participants mp WHERE mp.meeting_id = m.id AND mp.user_id = ?))
         AND m.status <> 'cancelled' AND m.meeting_date >= ? AND m.meeting_date <= ?
       ORDER BY m.meeting_date, m.start_time
       LIMIT 10`,
      u.id,
      u.id,
      today,
      addDays(today, 14),
    );
    const tv = taskVisibleSql(u, "t");
    res.json(
      rows.map((m) => {
        const prior = m.project_id
          ? db.get<{ n: number }>(
              `SELECT COUNT(*) n FROM tasks t JOIN meetings pm ON pm.id = t.meeting_id
               WHERE pm.project_id = ? AND pm.meeting_date < ? AND t.status IN ${OPEN} AND ${tv.sql}`,
              m.project_id,
              m.meeting_date,
              ...tv.params,
            )!.n
          : 0;
        return {
          ...m,
          project_name: m.project_id && canViewProject(db, u, m.project_id) ? m.project_name : null,
          preparation_required: !!m.preparation_required,
          is_today: m.meeting_date === today,
          outstanding_prior_actions: prior,
        };
      }),
    );
  }),
);

workspaceRouter.get(
  "/activity",
  h((req, res) => {
    const u = currentUser(req);
    const db = req.ctx.db;
    const limit = Math.min(Math.max(parseInt(String(req.query.limit ?? 15), 10) || 15, 1), 50);
    const out: unknown[] = [];
    // Walk recent activity in pages, keeping only rows the user is allowed to see.
    for (let offset = 0; out.length < limit && offset < 1000; offset += 100) {
      const rows = db.all<{ id: string; entity_type: string; entity_id: string; project_id: string | null; project_name: string | null }>(
        `SELECT a.*, us.name AS actor_name, p.name AS project_name FROM activity a
         LEFT JOIN users us ON us.id = a.actor_id LEFT JOIN projects p ON p.id = a.project_id
         ORDER BY a.created_at DESC LIMIT 100 OFFSET ?`,
        offset,
      );
      if (!rows.length) break;
      for (const r of rows) {
        if (!canViewEntity(db, u, r.entity_type, r.entity_id)) continue;
        if (r.project_id && !canViewProject(db, u, r.project_id)) continue;
        out.push(r);
        if (out.length >= limit) break;
      }
    }
    res.json(out);
  }),
);
