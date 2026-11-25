/**
 * Shared side-effect helpers: audit log, activity feed, notifications, status history.
 * Routes call these instead of writing those tables directly so behaviour
 * (dedupe, preferences, link format) stays consistent.
 */
import type { Request } from "express";
import type { Db } from "../db/index.js";
import { newId, nowIso } from "./ids.js";
import type { AuthUser } from "./context.js";

export function audit(
  db: Db,
  req: Request | null,
  action: string,
  entity?: { type: string; id: string } | null,
  changes: Record<string, unknown> = {},
  userOverride?: { id: string | null; email: string },
) {
  const u = userOverride ?? (req?.user ? { id: req.user.id, email: req.user.email } : { id: null, email: "" });
  db.insert("audit_log", {
    id: newId("aud"),
    user_id: u.id,
    user_email: u.email,
    action,
    entity_type: entity?.type ?? null,
    entity_id: entity?.id ?? null,
    changes: JSON.stringify(changes),
    ip: req ? (req.ip ?? "") : "",
    created_at: nowIso(),
  });
}

export function activity(
  db: Db,
  actor: AuthUser | { id: string } | null,
  verb: string,
  entity: { type: string; id: string; label: string },
  opts: { projectId?: string | null; detail?: string } = {},
) {
  db.insert("activity", {
    id: newId("act"),
    actor_id: actor?.id ?? null,
    verb,
    entity_type: entity.type,
    entity_id: entity.id,
    entity_label: entity.label.slice(0, 300),
    project_id: opts.projectId ?? null,
    detail: (opts.detail ?? "").slice(0, 1000),
    created_at: nowIso(),
  });
}

export function statusChange(
  db: Db,
  actorId: string | null,
  entityType: string,
  entityId: string,
  field: string,
  from: string | null,
  to: string,
  note = "",
) {
  if (from === to) return;
  db.insert("status_history", {
    id: newId("sth"),
    entity_type: entityType,
    entity_id: entityId,
    field,
    from_value: from,
    to_value: to,
    note,
    changed_by: actorId,
    changed_at: nowIso(),
  });
}

/** Link builder for client routes (kept here so notifications/search agree). */
export function linkFor(type: string, id: string): string {
  switch (type) {
    case "task":
      return `/tasks/${id}`;
    case "project":
      return `/projects/${id}`;
    case "meeting":
      return `/meetings/${id}`;
    case "report":
      return `/reports/${id}`;
    case "knowledge":
      return `/knowledge/${id}`;
    case "opportunity":
      return `/opportunities/${id}`;
    case "improvement":
      return `/learning/improvements/${id}`;
    case "learning":
      return `/learning/records/${id}`;
    default:
      return "/";
  }
}

export interface NotifyInput {
  userId: string | null | undefined;
  type: string;
  title: string;
  body?: string;
  entity?: { type: string; id: string };
  link?: string;
  dedupeKey?: string;
  /** Skip if the recipient is the actor (don't notify people about their own actions). */
  actorId?: string | null;
}

/** Notification types users may mute in their preferences. */
export const NOTIFICATION_TYPES: Record<string, string> = {
  task_assigned: "Task assigned to me",
  task_due_soon: "Task due soon / due today",
  task_overdue: "Task overdue",
  task_completed: "A task I created or review was completed",
  review_requested: "Review requested from me",
  changes_requested: "Changes requested on my work",
  task_suggested: "Responsibility suggested to me (needs confirmation)",
  meeting_upcoming: "Meeting approaching",
  meeting_actions: "Meeting actions ready for review",
  milestone_due: "Project milestone approaching",
  risk_identified: "Project risk identified",
  deliverable_due: "Deliverable due",
  deliverable_submitted: "Deliverable submitted",
  report_review: "Report ready for review",
  fakawe_draft: "Fakawe draft generated",
  opportunity_follow_up: "Opportunity follow-up due",
  knowledge_review: "Knowledge submission awaiting review",
  decision_required: "Decision requires attention",
  system: "Important system notifications",
};

/** Create an in-app notification, honouring user mute preferences and dedupe keys. */
export function notify(db: Db, n: NotifyInput): boolean {
  if (!n.userId) return false;
  if (n.actorId && n.actorId === n.userId) return false;
  const u = db.get<{ preferences: string; active: number }>("SELECT preferences, active FROM users WHERE id = ?", n.userId);
  if (!u || !u.active) return false;
  if (n.type !== "system") {
    try {
      const prefs = JSON.parse(u.preferences || "{}");
      if (Array.isArray(prefs.mutedNotifications) && prefs.mutedNotifications.includes(n.type)) return false;
    } catch {
      /* malformed prefs → deliver */
    }
  }
  const r = db.run(
    `INSERT OR IGNORE INTO notifications (id, user_id, type, title, body, entity_type, entity_id, link, dedupe_key, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    newId("ntf"),
    n.userId,
    n.type,
    n.title.slice(0, 300),
    (n.body ?? "").slice(0, 1000),
    n.entity?.type ?? null,
    n.entity?.id ?? null,
    n.link ?? (n.entity ? linkFor(n.entity.type, n.entity.id) : ""),
    n.dedupeKey ?? null,
    nowIso(),
  );
  return Number(r.changes) > 0;
}

export function getSetting<T>(db: Db, key: string, fallback: T): T {
  const r = db.get<{ value: string }>("SELECT value FROM settings WHERE key = ?", key);
  if (!r) return fallback;
  try {
    return JSON.parse(r.value) as T;
  } catch {
    return fallback;
  }
}
export function setSetting(db: Db, key: string, value: unknown, by: string | null) {
  db.run(
    "INSERT INTO settings (key, value, updated_at, updated_by) VALUES (?, ?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at, updated_by = excluded.updated_by",
    key,
    JSON.stringify(value),
    nowIso(),
    by,
  );
}

export function nextTaskRef(db: Db): number {
  return db.tx(() => {
    const r = db.get<{ next: number }>("SELECT next FROM task_ref_seq WHERE id = 1")!;
    db.run("UPDATE task_ref_seq SET next = next + 1 WHERE id = 1");
    return r.next;
  });
}

export function orgToday(db: Db): string {
  const tz = getSetting(db, "org.timezone", "Africa/Johannesburg");
  return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
}

/** Accept a client-supplied local date (?today=YYYY-MM-DD) if sane (±1 day of server), else org date. */
export function resolveToday(db: Db, q: unknown): string {
  const org = orgToday(db);
  if (typeof q === "string" && /^\d{4}-\d{2}-\d{2}$/.test(q)) {
    const diff = Math.abs(Date.parse(q) - Date.parse(org)) / 86400000;
    if (diff <= 1) return q;
  }
  return org;
}
