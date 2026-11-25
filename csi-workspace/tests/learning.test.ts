import { describe, it, expect } from "vitest";
import { setup } from "./helpers";

describe("learning records", () => {
  it("keeps private records private — even from management", async () => {
    const t = await setup();
    const priv = t.db.get<{ id: string }>("SELECT id FROM learning_records WHERE visibility = 'private'")!.id;
    const naledi = await t.as("naledi");
    const list = await naledi.get("/api/learning/records").expect(200);
    expect(list.body.items.map((r: { id: string }) => r.id)).not.toContain(priv);
    await naledi.get(`/api/learning/records/${priv}`).expect(404);
    const pieter = await t.as("pieter");
    await pieter.get(`/api/learning/records/${priv}`).expect(200);
  });

  it("requires at least one reflection but never a claim of change; only the contributor edits", async () => {
    const t = await setup();
    const thabo = await t.as("thabo");
    await thabo.post("/api/learning/records", { title: "Nothing" }).expect(400);
    const r = await thabo.post("/api/learning/records", { title: "Tried pair-reviewing", what_tried: "Reviewed summaries in pairs" }).expect(201);
    expect(r.body.what_changed).toBe("");
    const lerato = await t.as("lerato");
    await lerato.patch(`/api/learning/records/${r.body.id}`, { title: "hijack" }).expect(403);
    await thabo.patch(`/api/learning/records/${r.body.id}`, { visibility: "private" }).expect(200);
    await lerato.get(`/api/learning/records/${r.body.id}`).expect(404);
    await thabo.del(`/api/learning/records/${r.body.id}`).expect(200);
  });

  it("promotes a shared record to an in-review knowledge lesson", async () => {
    const t = await setup();
    const rec = t.db.get<{ id: string }>("SELECT id FROM learning_records WHERE title = 'Shorter invitation emails'")!.id;
    const thabo = await t.as("thabo");
    const r = await thabo.post(`/api/learning/records/${rec}/promote`).expect(201);
    const k = t.db.get<{ status: string; source_type: string; item_type: string }>("SELECT status, source_type, item_type FROM knowledge_items WHERE id = ?", r.body.id)!;
    expect(k).toEqual({ status: "in_review", source_type: "learning", item_type: "lesson" });
    await thabo.post(`/api/learning/records/${rec}/promote`).expect(400);
    expect(t.db.get("SELECT 1 FROM notifications WHERE user_id = ? AND type = 'knowledge_review'", t.userId("zanele"))).toBeTruthy();
  });
});

describe("learning themes", () => {
  it("requires learning.manage to create themes and exposes the current theme", async () => {
    const t = await setup();
    const lerato = await t.as("lerato");
    await lerato.post("/api/learning/themes", { month: "2031-01", title: "Listening" }).expect(403);
    const naledi = await t.as("naledi");
    await naledi.post("/api/learning/themes", { month: "2031-01", title: "Listening" }).expect(201);
    await naledi.post("/api/learning/themes", { month: "2031-01", title: "Dup" }).expect(400);
    const cur = await lerato.get("/api/learning/themes/current").expect(200);
    expect(cur.body.theme.title).toBe("Learning from small experiments");
    expect(cur.body.contributions.length).toBe(1);
    // AI draft not offered without a key
    const id = cur.body.theme.id;
    await naledi.post(`/api/learning/themes/${id}/draft-summary`).expect(400);
    await naledi.patch(`/api/learning/themes/${id}`, { summary: "Short emails help." }).expect(200);
  });
});

describe("improvements register", () => {
  it("lets anyone submit, restricts status changes to owner/learning.manage", async () => {
    const t = await setup();
    const lerato = await t.as("lerato");
    const r = await lerato.post("/api/improvements", { title: "Shared calendar for events", area: "Operations" }).expect(201);
    expect(r.body.status).toBe("submitted");
    await lerato.patch(`/api/improvements/${r.body.id}`, { problem: "Clashing dates" }).expect(200);
    await lerato.patch(`/api/improvements/${r.body.id}`, { status: "accepted" }).expect(403);
    const thabo = await t.as("thabo");
    await thabo.patch(`/api/improvements/${r.body.id}`, { title: "x" }).expect(403);
    const zanele = await t.as("zanele"); // knowledge manager has learning.manage
    await zanele.patch(`/api/improvements/${r.body.id}`, { status: "accepted", owner_id: t.userId("pieter"), note: "Good idea" }).expect(200);
    // submitter can no longer edit content after acceptance; owner can progress status
    await lerato.patch(`/api/improvements/${r.body.id}`, { problem: "changed" }).expect(403);
    const pieter = await t.as("pieter");
    await pieter.patch(`/api/improvements/${r.body.id}`, { status: "implemented", outcome: "Calendar live" }).expect(200);
    await pieter.patch(`/api/improvements/${r.body.id}`, { owner_id: t.userId("thabo") }).expect(403);
    const d = await lerato.get(`/api/improvements/${r.body.id}`).expect(200);
    expect(d.body.history.map((h: { to_value: string }) => h.to_value)).toEqual(["implemented", "accepted", "submitted"]);
    expect(t.db.get("SELECT 1 FROM notifications WHERE user_id = ? AND entity_id = ?", t.userId("lerato"), r.body.id)).toBeTruthy();
  });
});
