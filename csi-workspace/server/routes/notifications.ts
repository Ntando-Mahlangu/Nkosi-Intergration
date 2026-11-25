/**
 * Notification centre (/api/notifications). Users only ever see and change their own notifications.
 * Opening a notification links to the record; the record's own route enforces access.
 */
import { Router } from "express";
import { z } from "zod";
import { h, parse, notFound, pageParams } from "../lib/http.js";
import { currentUser } from "../lib/context.js";
import { NOTIFICATION_TYPES, audit } from "../lib/events.js";
import { nowIso } from "../lib/ids.js";

export const notificationsRouter = Router();

const unreadCount = (db: import("../db/index.js").Db, uid: string) =>
  db.get<{ n: number }>("SELECT COUNT(*) n FROM notifications WHERE user_id = ? AND read_at IS NULL AND archived_at IS NULL", uid)!.n;

notificationsRouter.get(
  "/",
  h((req, res) => {
    const u = currentUser(req);
    const db = req.ctx.db;
    const { limit, offset } = pageParams(req.query as Record<string, unknown>, 30, 100);
    const filter = String(req.query.filter ?? "all");
    const where = ["user_id = ?"];
    const params: string[] = [u.id];
    if (filter === "archived") where.push("archived_at IS NOT NULL");
    else {
      where.push("archived_at IS NULL");
      if (filter === "unread") where.push("read_at IS NULL");
    }
    if (req.query.type && NOTIFICATION_TYPES[String(req.query.type)]) {
      where.push("type = ?");
      params.push(String(req.query.type));
    }
    const w = where.join(" AND ");
    const total = db.get<{ n: number }>(`SELECT COUNT(*) n FROM notifications WHERE ${w}`, ...params)!.n;
    const items = db.all(`SELECT id, type, title, body, entity_type, entity_id, link, read_at, archived_at, created_at FROM notifications WHERE ${w} ORDER BY created_at DESC LIMIT ? OFFSET ?`, ...params, limit, offset);
    res.json({ items, total, unread: unreadCount(db, u.id), limit, offset });
  }),
);

notificationsRouter.get(
  "/types",
  h((req, res) => {
    const u = currentUser(req);
    const muted = Array.isArray(u.preferences.mutedNotifications) ? (u.preferences.mutedNotifications as string[]) : [];
    res.json({ types: Object.entries(NOTIFICATION_TYPES).map(([key, label]) => ({ key, label, muted: muted.includes(key), mutable: key !== "system" })) });
  }),
);

notificationsRouter.patch(
  "/preferences",
  h((req, res) => {
    const u = currentUser(req);
    const db = req.ctx.db;
    const b = parse(z.object({ mutedNotifications: z.array(z.string()).max(50) }), req.body);
    const muted = [...new Set(b.mutedNotifications.filter((t) => NOTIFICATION_TYPES[t] && t !== "system"))];
    const prefs = { ...u.preferences, mutedNotifications: muted };
    db.run("UPDATE users SET preferences = ?, updated_at = ? WHERE id = ?", JSON.stringify(prefs), nowIso(), u.id);
    audit(db, req, "user.notification_preferences", { type: "user", id: u.id }, { muted });
    res.json({ mutedNotifications: muted });
  }),
);

notificationsRouter.post(
  "/read-all",
  h((req, res) => {
    const u = currentUser(req);
    const r = req.ctx.db.run("UPDATE notifications SET read_at = ? WHERE user_id = ? AND read_at IS NULL", nowIso(), u.id);
    res.json({ updated: Number(r.changes), unread: 0 });
  }),
);

notificationsRouter.post(
  "/archive-read",
  h((req, res) => {
    const u = currentUser(req);
    const db = req.ctx.db;
    const r = db.run("UPDATE notifications SET archived_at = ? WHERE user_id = ? AND read_at IS NOT NULL AND archived_at IS NULL", nowIso(), u.id);
    res.json({ updated: Number(r.changes), unread: unreadCount(db, u.id) });
  }),
);

for (const [path, col] of [["read", "read_at"], ["archive", "archived_at"], ["unread", null]] as const) {
  notificationsRouter.post(
    `/:id/${path}`,
    h((req, res) => {
      const u = currentUser(req);
      const db = req.ctx.db;
      const n = db.get("SELECT 1 FROM notifications WHERE id = ? AND user_id = ?", req.params.id, u.id);
      if (!n) throw notFound("Notification not found.");
      if (col === "archived_at") db.run("UPDATE notifications SET archived_at = ?, read_at = COALESCE(read_at, ?) WHERE id = ?", nowIso(), nowIso(), req.params.id);
      else if (col) db.run(`UPDATE notifications SET ${col} = COALESCE(${col}, ?) WHERE id = ?`, nowIso(), req.params.id);
      else db.run("UPDATE notifications SET read_at = NULL, archived_at = NULL WHERE id = ?", req.params.id);
      res.json({ ok: true, unread: unreadCount(db, u.id) });
    }),
  );
}
