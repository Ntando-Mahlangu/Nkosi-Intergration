import { describe, it, expect } from "vitest";
import { setup } from "./helpers";

describe("management intelligence", () => {
  it("is forbidden without management.view", async () => {
    const t = await setup();
    for (const u of ["lerato", "sipho", "grace"] as const) {
      const a = await t.as(u);
      for (const ep of ["overview", "portfolio", "attention", "trends", "decisions"]) await a.get(`/api/management/${ep}`).expect(403);
    }
  });

  it("overview counts only project-linked actions and visible projects", async () => {
    const t = await setup();
    const n = await t.as("naledi");
    const r = await n.get("/api/management/overview").expect(200);
    expect(r.body.projects.active).toBeGreaterThan(0);
    const expected = t.db.get<{ n: number }>("SELECT COUNT(*) n FROM tasks WHERE project_id IS NOT NULL AND is_personal = 0 AND status IN ('todo','in_progress','blocked','awaiting_review')")!.n;
    expect(r.body.actions.open).toBe(expected);
    expect(r.body.pipeline.length).toBeGreaterThan(0);
  });

  it("portfolio includes progress explanation and suggested health; hides restricted projects from non-members", async () => {
    const t = await setup();
    const n = await t.as("naledi");
    const r = await n.get("/api/management/portfolio?sort=name").expect(200);
    const unm = r.body.items.find((x: { name: string }) => x.name === "Unmasking");
    expect(unm.progress_explanation).toMatch(/milestones/);
    expect(unm.suggested_health).toBeTruthy();
    // Naledi owns the restricted project → visible to her.
    expect(r.body.items.some((x: { name: string }) => x.name === "Leadership Retreat Planning")).toBe(true);
    // Remove her membership/ownership: then it must not appear.
    t.db.run("UPDATE projects SET owner_id = NULL WHERE name = 'Leadership Retreat Planning'");
    t.db.run("DELETE FROM project_members WHERE user_id = ? AND project_id = (SELECT id FROM projects WHERE name = 'Leadership Retreat Planning')", t.userId("naledi"));
    const r2 = await n.get("/api/management/portfolio").expect(200);
    expect(r2.body.items.some((x: { name: string }) => x.name === "Leadership Retreat Planning")).toBe(false);
  });

  it("attention items carry explicit reasons", async () => {
    const t = await setup();
    const n = await t.as("naledi");
    const r = await n.get("/api/management/attention").expect(200);
    expect(r.body.items.length).toBeGreaterThan(0);
    for (const i of r.body.items) {
      expect(i.why.length).toBeGreaterThan(5);
      expect(["critical", "high", "medium"]).toContain(i.severity);
    }
    const types = new Set(r.body.items.map((i: { type: string }) => i.type));
    for (const k of ["project", "milestone", "risk", "decision", "task", "opportunity"]) expect(types.has(k)).toBe(true);
  });

  it("trends flag insufficient data instead of charting it", async () => {
    const t = await setup();
    const n = await t.as("naledi");
    const r = await n.get("/api/management/trends").expect(200);
    const opp = r.body.series.find((s: { key: string }) => s.key === "opportunities_secured");
    expect(opp.sufficient).toBe(false);
    expect(opp.reason).toMatch(/weeks/);
    for (const s of r.body.series) expect(s.points.length).toBe(10);
  });

  it("decision approval requires decision.approve and a reason to reject", async () => {
    const t = await setup();
    const id = t.db.get<{ id: string }>("SELECT id FROM decisions WHERE status = 'pending_approval'")!.id;
    const n = await t.as("naledi");
    await n.post(`/api/management/decisions/${id}/decide`, { outcome: "rejected" }).expect(400);
    await n.post(`/api/management/decisions/${id}/decide`, { outcome: "approved", note: "Go ahead" }).expect(200);
    expect(t.db.get<{ status: string }>("SELECT status FROM decisions WHERE id = ?", id)!.status).toBe("approved");
    await n.post(`/api/management/decisions/${id}/decide`, { outcome: "approved" }).expect(409);
    expect(t.db.get("SELECT 1 FROM audit_log WHERE action = 'decision.approved'")).toBeTruthy();
  });

  it("refuses per-person productivity metrics", async () => {
    const t = await setup();
    const n = await t.as("naledi");
    await n.get("/api/management/people").expect(403);
  });
});
