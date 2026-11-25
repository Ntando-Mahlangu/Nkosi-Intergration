import { describe, it, expect } from "vitest";
import { setup } from "./helpers";

const oppId = (t: Awaited<ReturnType<typeof setup>>, nameLike: string) => t.db.get<{ id: string }>("SELECT id FROM opportunities WHERE name LIKE ?", `%${nameLike}%`)!.id;

describe("opportunities", () => {
  it("hides confidential opportunities from non-owners without management view", async () => {
    const t = await setup();
    const grant = oppId(t, "Foundation grant");
    const names = async (u: "lerato" | "ayesha" | "naledi") => ((await (await t.as(u)).get("/api/opportunities").expect(200)).body.items as { name: string }[]).map((o) => o.name);
    expect((await names("ayesha")).some((n) => n.includes("Foundation grant"))).toBe(false); // PM with view_all
    expect((await names("lerato")).some((n) => n.includes("Foundation grant"))).toBe(false); // employee
    expect((await names("naledi")).some((n) => n.includes("Foundation grant"))).toBe(true); // owner / management
    await (await t.as("ayesha")).get(`/api/opportunities/${grant}`).expect(404);
    // Employees only see opportunities they own/created
    expect(await names("lerato")).toEqual([]);
  });

  it("lets any staff member submit an opportunity they own, but not assign it to others", async () => {
    const t = await setup();
    const lerato = await t.as("lerato");
    const r = await lerato.post("/api/opportunities", { name: "Community workshop interest", owner_id: t.userId("ayesha") }).expect(201);
    expect(r.body.owner_id).toBe(t.userId("lerato"));
    expect(r.body.stage).toBe("identified");
    await lerato.post("/api/opportunities", { name: "" }).expect(400);
  });

  it("records stage changes with history and audits secured/lost", async () => {
    const t = await setup();
    const ayesha = await t.as("ayesha");
    const id = oppId(t, "Leadership programme for Partner Org B");
    await ayesha.post(`/api/opportunities/${id}/stage`, { stage: "proposal", note: "Outline sent" }).expect(200);
    await ayesha.post(`/api/opportunities/${id}/stage`, { stage: "secured" }).expect(200);
    const hist = t.db.all<{ from_value: string; to_value: string }>("SELECT from_value, to_value FROM status_history WHERE entity_type = 'opportunity' AND entity_id = ? ORDER BY changed_at", id);
    expect(hist.map((h) => h.to_value)).toEqual(["proposal", "secured"]);
    expect(t.db.get("SELECT 1 FROM audit_log WHERE action = 'opportunity.secured' AND entity_id = ?", id)).toBeTruthy();
    const detail = await ayesha.get(`/api/opportunities/${id}`).expect(200);
    expect(detail.body.history.length).toBe(2);
    // a non-owner employee cannot move it
    const lerato = await t.as("lerato");
    await lerato.post(`/api/opportunities/${id}/stage`, { stage: "lost" }).expect(404);
    await ayesha.post(`/api/opportunities/${id}/stage`, { stage: "won" }).expect(400);
  });

  it("creates an assigned follow-up task with a notification", async () => {
    const t = await setup();
    const ayesha = await t.as("ayesha");
    const id = oppId(t, "Leadership programme for Partner Org B");
    const r = await ayesha.post(`/api/opportunities/${id}/follow-up-task`, { title: "Call HR lead", due_date: "2030-01-15", assignee_id: t.userId("lerato") }).expect(201);
    expect(r.body.source).toBe("opportunity");
    expect(r.body.source_ref).toBe(id);
    expect(r.body.assignee_id).toBe(t.userId("lerato"));
    expect(t.db.get("SELECT 1 FROM notifications WHERE user_id = ? AND type = 'task_assigned' AND entity_id = ?", t.userId("lerato"), r.body.id)).toBeTruthy();
    const detail = await ayesha.get(`/api/opportunities/${id}`).expect(200);
    expect(detail.body.follow_up_tasks.map((x: { id: string }) => x.id)).toContain(r.body.id);
    expect(detail.body.opportunity.follow_up_date).toBe("2030-01-15");
    await ayesha.post(`/api/opportunities/${id}/follow-up-task`, { title: "x", due_date: "bad" }).expect(400);
  });

  it("logs engagements and summarises the pipeline", async () => {
    const t = await setup();
    const naledi = await t.as("naledi");
    const id = oppId(t, "Foundation grant");
    await naledi.post(`/api/opportunities/${id}/engagements`, { body: "Call with programme officer" }).expect(201);
    const d = await naledi.get(`/api/opportunities/${id}`).expect(200);
    expect(d.body.engagements[0].body).toContain("programme officer");
    const s = await naledi.get("/api/opportunities/summary").expect(200);
    expect(s.body.by_stage.find((x: { stage: string }) => x.stage === "proposal").count).toBe(1);
    expect(s.body.weighted_value).toBeGreaterThan(0);
  });

  it("only suggests signals from visible sources and never auto-creates opportunities", async () => {
    const t = await setup();
    const now = new Date().toISOString();
    const zanele = t.userId("zanele");
    t.db.run(`INSERT INTO knowledge_items (id, title, summary, body, author_id, access_level, status, created_at, updated_at) VALUES ('kno_pub_sig', 'Partner chat notes', 'Example Org said they are interested in a joint pilot.', '', ?, 'all_staff', 'published', ?, ?)`, zanele, now, now);
    t.db.run(`INSERT INTO knowledge_items (id, title, summary, body, author_id, access_level, status, created_at, updated_at) VALUES ('kno_mgmt_sig', 'Board note', 'A funder would like to explore funding a new stream.', '', ?, 'management', 'published', ?, ?)`, t.userId("naledi"), now, now);
    const before = t.db.get<{ n: number }>("SELECT COUNT(*) n FROM opportunities")!.n;
    const lerato = await t.as("lerato");
    const s = await lerato.get("/api/opportunities/signals").expect(200);
    const ids = s.body.items.map((x: { source_id: string }) => x.source_id);
    expect(s.body.engine).toBe("rules");
    expect(ids).toContain("kno_pub_sig");
    expect(ids).not.toContain("kno_mgmt_sig");
    expect(t.db.get<{ n: number }>("SELECT COUNT(*) n FROM opportunities")!.n).toBe(before);
    // converting a restricted source is refused; a visible one creates an identified opportunity + link
    await lerato.post("/api/opportunities/signals/convert", { source_type: "knowledge", source_id: "kno_mgmt_sig", name: "x" }).expect(404);
    const c = await lerato.post("/api/opportunities/signals/convert", { source_type: "knowledge", source_id: "kno_pub_sig", name: "Joint pilot with Example Org" }).expect(201);
    expect(c.body.stage).toBe("identified");
    const again = await lerato.get("/api/opportunities/signals").expect(200);
    expect(again.body.items.map((x: { source_id: string }) => x.source_id)).not.toContain("kno_pub_sig");
    const naledi = await t.as("naledi");
    expect((await naledi.get("/api/opportunities/signals")).body.items.map((x: { source_id: string }) => x.source_id)).toContain("kno_mgmt_sig");
  });

  it("links only records the user can see", async () => {
    const t = await setup();
    const ayesha = await t.as("ayesha");
    const id = oppId(t, "Leadership programme for Partner Org B");
    const retreat = t.db.get<{ id: string }>("SELECT id FROM projects WHERE name = 'Leadership Retreat Planning'")!.id;
    const corp = t.db.get<{ id: string }>("SELECT id FROM projects WHERE name = 'Corporate Programme Development'")!.id;
    await ayesha.post(`/api/opportunities/${id}/links`, { type: "project", id: retreat }).expect(404);
    const r = await ayesha.post(`/api/opportunities/${id}/links`, { type: "project", id: corp }).expect(201);
    expect(r.body.find((x: { id: string }) => x.id === corp)).toBeTruthy();
    const link = r.body.find((x: { id: string }) => x.id === corp).link_id;
    await ayesha.del(`/api/opportunities/${id}/links/${link}`).expect(200);
  });
});
