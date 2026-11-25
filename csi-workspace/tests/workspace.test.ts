import { describe, it, expect } from "vitest";
import { setup } from "./helpers";

describe("My Workspace", () => {
  it("summary counts match the underlying records", async () => {
    const t = await setup();
    const lerato = await t.as("lerato");
    const r = await lerato.get("/api/workspace/summary").expect(200);
    // Seed: 7 open (l1..l7), 2 due today (l1, l2), 1 overdue (l3), 1 own submission awaiting review (l4), 1 suggested.
    expect(r.body.counts.open).toBe(7);
    expect(r.body.counts.due_today).toBe(2);
    expect(r.body.counts.overdue).toBe(1);
    expect(r.body.counts.awaiting_review).toMatchObject({ my_submissions: 1, to_review_by_me: 0, suggested_for_me: 1, total: 1 });
    expect(r.body.user.first_name).toBe("Lerato");

    const id = t.userId("lerato");
    const open = t.db.get<{ n: number }>("SELECT COUNT(*) n FROM tasks WHERE assignee_id = ? AND status IN ('todo','in_progress','blocked','awaiting_review')", id)!.n;
    expect(r.body.counts.open).toBe(open);

    const zanele = await t.as("zanele");
    const z = await zanele.get("/api/workspace/summary").expect(200);
    expect(z.body.counts.awaiting_review.to_review_by_me).toBe(1);
  });

  it("counts update when a task is completed", async () => {
    const t = await setup();
    const lerato = await t.as("lerato");
    const l2 = t.db.get<{ id: string }>("SELECT id FROM tasks WHERE title LIKE 'Send pilot reminder%'")!.id;
    await lerato.post(`/api/tasks/${l2}/complete`).expect(200);
    const r = await lerato.get("/api/workspace/summary").expect(200);
    expect(r.body.counts.open).toBe(6);
    expect(r.body.counts.due_today).toBe(1);
  });

  it("lists my active projects with progress and my outstanding actions, including restricted projects I belong to", async () => {
    const t = await setup();
    const pieter = await t.as("pieter");
    const r = await pieter.get("/api/workspace/projects").expect(200);
    const names = r.body.map((p: { name: string }) => p.name);
    expect(names).toContain("Leadership Retreat Planning");
    const cos = r.body.find((p: { name: string }) => p.name === "Change OS");
    expect(cos.my_role).toBe("member");
    expect(cos.progress.method).toBe("deliverables");
    const lerato = await t.as("lerato");
    const lr = await lerato.get("/api/workspace/projects").expect(200);
    expect(lr.body.map((p: { name: string }) => p.name)).not.toContain("Leadership Retreat Planning");
    const unm = lr.body.find((p: { name: string }) => p.name === "Unmasking");
    expect(unm.my_outstanding).toBe(3);
    expect(unm.next_milestone.title).toBe("Pilot cohort recruited");
  });

  it("lists upcoming meetings for participants only", async () => {
    const t = await setup();
    const lerato = await t.as("lerato");
    const r = await lerato.get("/api/workspace/meetings").expect(200);
    const titles = r.body.map((m: { title: string }) => m.title);
    expect(titles).toContain("Knowledge Hub launch sync");
    expect(titles).not.toContain("Management meeting");
    const naledi = await t.as("naledi");
    const n = await naledi.get("/api/workspace/meetings").expect(200);
    expect(n.body.map((m: { title: string }) => m.title)).toContain("Management meeting");
  });

  it("recent activity hides records the user cannot see", async () => {
    const t = await setup();
    const lerato = await t.as("lerato");
    const r = await lerato.get("/api/workspace/activity").expect(200);
    expect(r.body.length).toBeGreaterThan(0);
    expect(r.body.some((a: { entity_label: string }) => a.entity_label === "Shortlist retreat venues")).toBe(false);
    const pieter = await t.as("pieter");
    const p = await pieter.get("/api/workspace/activity?limit=50").expect(200);
    expect(p.body.some((a: { entity_label: string }) => a.entity_label === "Shortlist retreat venues")).toBe(true);
  });
});
