import { describe, it, expect } from "vitest";
import { setup } from "./helpers";

describe("notifications", () => {
  it("lists only my notifications and scopes read/archive to the owner", async () => {
    const t = await setup();
    const lerato = await t.as("lerato");
    const zanele = await t.as("zanele");
    const list = await lerato.get("/api/notifications?filter=unread").expect(200);
    expect(list.body.items.length).toBeGreaterThan(0);
    expect(list.body.unread).toBe(list.body.items.length);
    const id = list.body.items[0].id;
    await zanele.post(`/api/notifications/${id}/read`).expect(404);
    await zanele.post(`/api/notifications/${id}/archive`).expect(404);
    const r = await lerato.post(`/api/notifications/${id}/read`).expect(200);
    expect(r.body.unread).toBe(list.body.unread - 1);
    await lerato.post(`/api/notifications/${id}/archive`).expect(200);
    const archived = await lerato.get("/api/notifications?filter=archived").expect(200);
    expect(archived.body.items.map((i: { id: string }) => i.id)).toContain(id);
    await lerato.post("/api/notifications/read-all").expect(200);
    expect((await lerato.get("/api/me")).body.unreadNotifications).toBe(0);
    // Zanele's untouched
    expect((await zanele.get("/api/notifications?filter=unread")).body.unread).toBeGreaterThan(0);
  });

  it("stores mute preferences and never mutes system notifications", async () => {
    const t = await setup();
    const lerato = await t.as("lerato");
    const r = await lerato.patch("/api/notifications/preferences", { mutedNotifications: ["task_overdue", "system", "bogus"] }).expect(200);
    expect(r.body.mutedNotifications).toEqual(["task_overdue"]);
    const types = await lerato.get("/api/notifications/types").expect(200);
    expect(types.body.types.find((x: { key: string }) => x.key === "task_overdue").muted).toBe(true);
  });
});
