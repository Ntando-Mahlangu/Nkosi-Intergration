/**
 * Automation engine: configurable, auditable, individually disable-able scheduled rules.
 *
 * - Rules are defined in db/bootstrap.ts (DEFAULT_AUTOMATIONS) and stored in automation_rules,
 *   where administrators can enable/disable them and adjust config.
 * - Every notification a rule creates carries a dedupe key (rule:record:date) so running a rule
 *   any number of times never duplicates notifications.
 * - Each run is recorded in automation_runs with its outcome.
 */
import type { AppContext } from "./lib/context.js";
import type { Db } from "./db/index.js";
import { newId, nowIso, addDays } from "./lib/ids.js";
import { audit, getSetting, notify, orgToday } from "./lib/events.js";

export interface RuleResult {
  key: string;
  ran: boolean;
  outcome: "ok" | "error" | "disabled";
  notified: number;
  detail: string;
}

type RuleFn = (db: Db, today: string, config: Record<string, unknown>) => { notified: number; detail: string };

const num = (v: unknown, d: number) => (typeof v === "number" && Number.isFinite(v) ? v : d);

const RULES: Record<string, RuleFn> = {
  task_due_reminders(db, today, config) {
    const days = num(config.days, getSetting(db, "notifications.reminder_days_before_due", 2));
    let n = 0;
    const rows = db.all<{ id: string; title: string; assignee_id: string; due_date: string }>(
      "SELECT id, title, assignee_id, due_date FROM tasks WHERE status IN ('todo','in_progress','blocked') AND assignee_id IS NOT NULL AND due_date BETWEEN ? AND ?",
      today,
      addDays(today, days),
    );
    for (const t of rows) {
      const when = t.due_date === today ? "today" : t.due_date === addDays(today, 1) ? "tomorrow" : `on ${t.due_date}`;
      if (notify(db, { userId: t.assignee_id, type: "task_due_soon", title: `Due ${when}: ${t.title}`, entity: { type: "task", id: t.id }, dedupeKey: `task_due:${t.id}:${t.due_date}:${t.due_date === today ? "today" : "soon"}` })) n++;
    }
    return { notified: n, detail: `${rows.length} task(s) due within ${days} day(s)` };
  },

  task_overdue(db, today) {
    let n = 0;
    const rows = db.all<{ id: string; title: string; assignee_id: string; due_date: string }>(
      "SELECT id, title, assignee_id, due_date FROM tasks WHERE status IN ('todo','in_progress','blocked') AND assignee_id IS NOT NULL AND due_date < ?",
      today,
    );
    for (const t of rows) {
      if (notify(db, { userId: t.assignee_id, type: "task_overdue", title: `Overdue: ${t.title}`, body: `Was due ${t.due_date}.`, entity: { type: "task", id: t.id }, dedupeKey: `task_overdue:${t.id}:${today}` })) n++;
    }
    return { notified: n, detail: `${rows.length} overdue task(s)` };
  },

  review_reminders(db, today, config) {
    const after = num(config.after_days, 2);
    let n = 0;
    const rows = db.all<{ id: string; title: string; reviewer_id: string }>(
      "SELECT id, title, reviewer_id FROM tasks WHERE status = 'awaiting_review' AND reviewer_id IS NOT NULL AND date(updated_at) <= ?",
      addDays(today, -after),
    );
    for (const t of rows) {
      if (notify(db, { userId: t.reviewer_id, type: "review_requested", title: `Still awaiting your review: ${t.title}`, entity: { type: "task", id: t.id }, dedupeKey: `review_reminder:${t.id}:${today}` })) n++;
    }
    return { notified: n, detail: `${rows.length} review(s) pending more than ${after} day(s)` };
  },

  milestone_approaching(db, today, config) {
    const days = num(config.days, 7);
    let n = 0;
    const rows = db.all<{ id: string; title: string; owner_id: string | null; target_date: string; project_id: string; project_owner: string | null; project_name: string }>(
      `SELECT m.id, m.title, m.owner_id, m.target_date, m.project_id, p.owner_id AS project_owner, p.name AS project_name
       FROM milestones m JOIN projects p ON p.id = m.project_id
       WHERE m.status IN ('not_started','in_progress') AND m.target_date BETWEEN ? AND ? AND p.status NOT IN ('completed','cancelled')`,
      today,
      addDays(today, days),
    );
    for (const m of rows) {
      for (const uid of new Set([m.owner_id, m.project_owner].filter(Boolean) as string[])) {
        if (notify(db, { userId: uid, type: "milestone_due", title: `Milestone due ${m.target_date}: ${m.title}`, body: m.project_name, entity: { type: "project", id: m.project_id }, dedupeKey: `milestone_due:${m.id}:${m.target_date}` })) n++;
      }
    }
    return { notified: n, detail: `${rows.length} milestone(s) due within ${days} day(s)` };
  },

  deliverable_due(db, today, config) {
    const days = num(config.days, 3);
    let n = 0;
    const rows = db.all<{ id: string; name: string; owner_id: string; due_date: string; project_id: string }>(
      "SELECT id, name, owner_id, due_date, project_id FROM deliverables WHERE status IN ('not_started','in_progress','changes_requested') AND owner_id IS NOT NULL AND due_date BETWEEN ? AND ?",
      addDays(today, -365),
      addDays(today, days),
    );
    for (const d of rows) {
      const overdue = d.due_date < today;
      if (notify(db, { userId: d.owner_id, type: "deliverable_due", title: `${overdue ? "Overdue deliverable" : "Deliverable due " + d.due_date}: ${d.name}`, entity: { type: "project", id: d.project_id }, dedupeKey: `deliverable_due:${d.id}:${overdue ? today : d.due_date}` })) n++;
    }
    return { notified: n, detail: `${rows.length} deliverable(s) due or overdue` };
  },

  meeting_upcoming(db, today) {
    const tomorrow = addDays(today, 1);
    let n = 0;
    const rows = db.all<{ id: string; title: string; start_time: string | null; preparation_required: number; user_id: string }>(
      `SELECT m.id, m.title, m.start_time, m.preparation_required, mp.user_id FROM meetings m JOIN meeting_participants mp ON mp.meeting_id = m.id
       WHERE m.meeting_date = ? AND m.status = 'scheduled' AND mp.user_id IS NOT NULL`,
      tomorrow,
    );
    for (const r of rows) {
      const title = `Tomorrow${r.start_time ? ` ${r.start_time}` : ""}: ${r.title}${r.preparation_required ? " (preparation required)" : ""}`;
      if (notify(db, { userId: r.user_id, type: "meeting_upcoming", title, entity: { type: "meeting", id: r.id }, dedupeKey: `meeting_upcoming:${r.id}:${tomorrow}` })) n++;
    }
    return { notified: n, detail: `${new Set(rows.map((r) => r.id)).size} meeting(s) tomorrow` };
  },

  opportunity_follow_up(db, today) {
    let n = 0;
    const rows = db.all<{ id: string; name: string; owner_id: string; follow_up_date: string; next_action: string }>(
      "SELECT id, name, owner_id, follow_up_date, next_action FROM opportunities WHERE owner_id IS NOT NULL AND follow_up_date IS NOT NULL AND follow_up_date <= ? AND stage NOT IN ('secured','lost','on_hold')",
      today,
    );
    for (const o of rows) {
      if (notify(db, { userId: o.owner_id, type: "opportunity_follow_up", title: `Follow-up due: ${o.name}`, body: o.next_action, entity: { type: "opportunity", id: o.id }, dedupeKey: `opp_follow_up:${o.id}:${o.follow_up_date}` })) n++;
    }
    return { notified: n, detail: `${rows.length} opportunity follow-up(s) due` };
  },

  fakawe_missing_updates(db, today, config) {
    const lead = num(config.days_before_deadline, 2);
    let n = 0;
    const periods = db.all<{ id: string; name: string; start_date: string; end_date: string; submission_deadline: string | null }>(
      "SELECT id, name, start_date, end_date, submission_deadline FROM reporting_periods WHERE status IN ('open','drafting') AND submission_deadline IS NOT NULL AND submission_deadline BETWEEN ? AND ?",
      today,
      addDays(today, lead),
    );
    let missing = 0;
    for (const p of periods) {
      const projects = db.all<{ id: string; name: string; owner_id: string }>(
        `SELECT pr.id, pr.name, pr.owner_id FROM projects pr WHERE pr.status IN ('active','at_risk') AND pr.owner_id IS NOT NULL
         AND NOT EXISTS (SELECT 1 FROM project_updates u WHERE u.project_id = pr.id AND date(u.created_at) BETWEEN ? AND ?)`,
        p.start_date,
        p.end_date,
      );
      missing += projects.length;
      for (const pr of projects) {
        if (notify(db, { userId: pr.owner_id, type: "fakawe_draft", title: `Project update needed for ${p.name}: ${pr.name}`, body: `Reporting deadline ${p.submission_deadline}.`, entity: { type: "project", id: pr.id }, dedupeKey: `fakawe_missing:${p.id}:${pr.id}` })) n++;
      }
    }
    return { notified: n, detail: `${periods.length} period(s) near deadline; ${missing} project update(s) missing` };
  },

  knowledge_review_due(db, today) {
    let n = 0;
    const rows = db.all<{ id: string; title: string; owner: string | null }>(
      "SELECT id, title, COALESCE(owner_id, author_id) AS owner FROM knowledge_items WHERE status = 'published' AND review_date IS NOT NULL AND review_date <= ?",
      today,
    );
    for (const k of rows) {
      if (notify(db, { userId: k.owner, type: "knowledge_review", title: `Review due: ${k.title}`, body: "This knowledge item has passed its review date.", entity: { type: "knowledge", id: k.id }, dedupeKey: `knowledge_review:${k.id}:${today.slice(0, 7)}` })) n++;
    }
    return { notified: n, detail: `${rows.length} item(s) past review date` };
  },

  meeting_actions_review() {
    return { notified: 0, detail: "Event-driven: runs when meeting notes are processed." };
  },

  retention_purge(db, today) {
    const counts = applyRetention(db, today);
    const total = Object.values(counts).reduce((a, b) => a + b, 0);
    if (total) audit(db, null, "retention.purge", { type: "system", id: "retention" }, counts, { id: null, email: "system" });
    return { notified: 0, detail: total ? Object.entries(counts).map(([k, v]) => `${k}: ${v}`).join(", ") : "Nothing to purge" };
  },
};

/** Apply retention settings; returns counts of removed/blanked records. 0 days = keep forever. */
export function applyRetention(db: Db, today: string): Record<string, number> {
  const days = (k: string) => getSetting<number>(db, k, 0);
  const cutoff = (n: number) => `${addDays(today, -n)}T00:00:00.000Z`;
  const counts: Record<string, number> = {};
  db.tx(() => {
    const s = days("retention.sessions_days");
    counts.sessions = Number(db.run("DELETE FROM sessions WHERE expires_at < ? OR (? > 0 AND last_seen_at < ?)", nowIso(), s, cutoff(s || 1)).changes);
    const nd = days("retention.notifications_days");
    if (nd > 0) counts.notifications = Number(db.run("DELETE FROM notifications WHERE created_at < ?", cutoff(nd)).changes);
    const ad = days("retention.ai_suggestions_days");
    if (ad > 0) counts.ai_suggestions = Number(db.run("DELETE FROM ai_suggestions WHERE status IN ('pending','rejected') AND created_at < ?", cutoff(ad)).changes);
    const au = days("retention.audit_days");
    if (au > 0) counts.audit_log = Number(db.run("DELETE FROM audit_log WHERE created_at < ?", cutoff(Math.max(au, 365))).changes);
    const td = days("retention.meeting_transcripts_days");
    if (td > 0) counts.meeting_transcripts = Number(db.run("UPDATE meetings SET transcript = '', transcript_source = 'removed by retention policy' WHERE transcript <> '' AND meeting_date < ?", addDays(today, -td)).changes);
  });
  for (const k of Object.keys(counts)) if (!counts[k]) delete counts[k];
  return counts;
}

export function runRule(ctx: AppContext, key: string, opts: { force?: boolean } = {}): RuleResult {
  const db = ctx.db;
  const rule = db.get<{ enabled: number; config: string }>("SELECT enabled, config FROM automation_rules WHERE key = ?", key);
  const fn = RULES[key];
  if (!rule || !fn) return { key, ran: false, outcome: "error", notified: 0, detail: "Unknown rule" };
  if (!rule.enabled && !opts.force) return { key, ran: false, outcome: "disabled", notified: 0, detail: "Rule is disabled" };
  const runId = newId("arn");
  const started = nowIso();
  db.insert("automation_runs", { id: runId, rule_key: key, started_at: started, outcome: "" });
  let result: RuleResult;
  try {
    let config: Record<string, unknown> = {};
    try {
      config = JSON.parse(rule.config || "{}");
    } catch {
      /* default config */
    }
    const r = fn(db, orgToday(db), config);
    result = { key, ran: true, outcome: "ok", notified: r.notified, detail: `${r.detail}; ${r.notified} notification(s) sent` };
  } catch (e) {
    console.error(`[automation] ${key} failed`, e);
    result = { key, ran: true, outcome: "error", notified: 0, detail: "Rule failed — see server log." };
  }
  const fin = nowIso();
  db.run("UPDATE automation_runs SET finished_at = ?, outcome = ?, detail = ? WHERE id = ?", fin, result.outcome, result.detail, runId);
  db.run("UPDATE automation_rules SET last_run_at = ?, last_result = ? WHERE key = ?", fin, `${result.outcome}: ${result.detail}`.slice(0, 500), key);
  // keep run history bounded
  db.run("DELETE FROM automation_runs WHERE rule_key = ? AND id NOT IN (SELECT id FROM automation_runs WHERE rule_key = ? ORDER BY started_at DESC LIMIT 100)", key, key);
  return result;
}

export function runAllRules(ctx: AppContext): RuleResult[] {
  const keys = ctx.db.all<{ key: string }>("SELECT key FROM automation_rules WHERE enabled = 1 ORDER BY key").map((r) => r.key);
  return keys.map((k) => runRule(ctx, k));
}

/** Event-driven rule: tell the meeting owner that suggestions are ready for review. Safe to call repeatedly. */
export function notifyMeetingActions(ctx: AppContext, meetingId: string, actorId?: string | null): boolean {
  const db = ctx.db;
  if (!db.get("SELECT 1 FROM automation_rules WHERE key = 'meeting_actions_review' AND enabled = 1")) return false;
  const m = db.get<{ title: string; organiser_id: string | null; created_by: string | null }>("SELECT title, organiser_id, created_by FROM meetings WHERE id = ?", meetingId);
  if (!m) return false;
  const pending = db.get<{ n: number }>("SELECT COUNT(*) n FROM ai_suggestions WHERE source_type = 'meeting' AND source_id = ? AND status = 'pending'", meetingId)!.n;
  if (!pending) return false;
  return notify(db, {
    userId: m.organiser_id ?? m.created_by,
    actorId: actorId ?? null,
    type: "meeting_actions",
    title: `${pending} suggestion(s) ready for review: ${m.title}`,
    entity: { type: "meeting", id: meetingId },
    link: `/meetings/${meetingId}/review`,
    dedupeKey: `meeting_actions:${meetingId}:${pending}`,
  });
}

let timer: NodeJS.Timeout | null = null;

export function startAutomation(ctx: AppContext) {
  if (ctx.config.env === "test" || timer) return;
  const tick = () => {
    try {
      const results = runAllRules(ctx);
      const sent = results.reduce((a, r) => a + r.notified, 0);
      if (sent) console.log(`[automation] tick: ${sent} notification(s) sent`);
    } catch (e) {
      console.error("[automation] tick failed", e);
    }
  };
  setTimeout(tick, 15_000).unref();
  timer = setInterval(tick, 60 * 60 * 1000);
  timer.unref();
}
