import { describe, it, expect } from "vitest";
import { setup } from "./helpers";
import { runAllRules, runRule, notifyMeetingActions } from "../server/automation";
import { addDays, nowIso } from "../server/lib/ids";
import { orgToday } from "../server/lib/events";

describe("automation engine", () => {
  it("sends overdue/due reminders once — reruns never duplicate", async () => {
    const t = await setup();
    const ctx = { db: t.db, config: t.config };
    const count = () => t.db.get<{ n: number }>("SELECT COUNT(*) n FROM notifications")!.n;
    const r1 = runAllRules(ctx);
    expect(r1.every((r) => r.outcome === "ok")).toBe(true);
    const after1 = count();
    expect(r1.find((r) => r.key === "task_overdue")!.notified).toBeGreaterThan(0);
    runAllRules(ctx);
    expect(count()).toBe(after1);
    expect(t.db.get<{ n: number }>("SELECT COUNT(*) n FROM automation_runs")!.n).toBeGreaterThan(0);
    // overdue notification for Lerato's overdue task
    expect(t.db.get("SELECT 1 FROM notifications n JOIN tasks t ON t.id = n.entity_id WHERE n.type = 'task_overdue' AND t.title = 'Book online workshop platform trial'")).toBeTruthy();
  });

  it("respects disabled rules and muted preferences", async () => {
    const t = await setup();
    const ctx = { db: t.db, config: t.config };
    t.db.run("UPDATE automation_rules SET enabled = 0 WHERE key = 'task_overdue'");
    expect(runRule(ctx, "task_overdue").outcome).toBe("disabled");
    t.db.run("UPDATE automation_rules SET enabled = 1 WHERE key = 'task_overdue'");
    t.db.run("UPDATE users SET preferences = ? WHERE id = ?", JSON.stringify({ mutedNotifications: ["task_overdue"] }), t.userId("lerato"));
    t.db.run("DELETE FROM notifications");
    runRule(ctx, "task_overdue");
    expect(t.db.get("SELECT 1 FROM notifications WHERE user_id = ? AND type = 'task_overdue'", t.userId("lerato"))).toBeFalsy();
    expect(t.db.get("SELECT 1 FROM notifications WHERE user_id = ? AND type = 'task_overdue'", t.userId("thabo"))).toBeTruthy();
  });

  it("applies retention policy and audits counts", async () => {
    const t = await setup();
    const ctx = { db: t.db, config: t.config };
    const today = orgToday(t.db);
    const old = `${addDays(today, -400)}T00:00:00.000Z`;
    t.db.run("UPDATE notifications SET created_at = ? WHERE rowid IN (SELECT rowid FROM notifications LIMIT 2)", old);
    t.db.run("INSERT INTO audit_log (id, action, changes, created_at) VALUES ('aud_old', 'x.old', '{}', ?)", `${addDays(today, -3000)}T00:00:00.000Z`);
    t.db.run("INSERT INTO sessions (id, user_id, created_at, expires_at, last_seen_at) VALUES ('expired', ?, ?, ?, ?)", t.userId("lerato"), old, old, old);
    const r = runRule(ctx, "retention_purge");
    expect(r.outcome).toBe("ok");
    expect(t.db.get("SELECT 1 FROM audit_log WHERE id = 'aud_old'")).toBeFalsy();
    expect(t.db.get("SELECT 1 FROM sessions WHERE id = 'expired'")).toBeFalsy();
    expect(t.db.get<{ n: number }>("SELECT COUNT(*) n FROM notifications WHERE created_at = ?", old)!.n).toBe(0);
    expect(t.db.get("SELECT 1 FROM audit_log WHERE action = 'retention.purge'")).toBeTruthy();
    expect(nowIso()).toBeTruthy();
  });

  it("notifies meeting owner when suggestions are pending (deduplicated)", async () => {
    const t = await setup();
    const ctx = { db: t.db, config: t.config };
    const m = t.db.get<{ id: string }>("SELECT id FROM meetings WHERE title = 'D4C partner check-in'")!.id;
    t.db.run("DELETE FROM notifications WHERE type = 'meeting_actions'");
    expect(notifyMeetingActions(ctx, m)).toBe(true);
    expect(notifyMeetingActions(ctx, m)).toBe(false);
  });

  it("admin can run a rule now via the API and see history", async () => {
    const t = await setup();
    const grace = await t.as("grace");
    const r = await grace.post("/api/admin/automations/meeting_upcoming/run").expect(200);
    expect(r.body.outcome).toBe("ok");
    const list = await grace.get("/api/admin/automations").expect(200);
    expect(list.body.runs.length).toBeGreaterThan(0);
    await grace.patch("/api/admin/automations/meeting_upcoming", { enabled: false }).expect(200);
    expect(t.db.get<{ enabled: number }>("SELECT enabled FROM automation_rules WHERE key = 'meeting_upcoming'")!.enabled).toBe(0);
  });
});
