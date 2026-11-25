import { describe, it, expect } from "vitest";
import { setup } from "./helpers";

const pid = (t: Awaited<ReturnType<typeof setup>>, name: string) => t.db.get<{ id: string }>("SELECT id FROM projects WHERE name = ?", name)!.id;

describe("projects module", () => {
  it("portfolio only lists visible projects (restricted + team visibility)", async () => {
    const t = await setup();
    const names = async (u: "lerato" | "thabo" | "naledi" | "grace" | "pieter") => ((await (await t.as(u)).get("/api/projects").expect(200)).body.items as { name: string }[]).map((p) => p.name);
    expect(await names("thabo")).not.toContain("D4C"); // team visibility, other team, not member
    expect(await names("lerato")).toContain("D4C"); // member
    expect(await names("naledi")).toContain("D4C"); // project.view_all
    expect(await names("grace")).not.toContain("Leadership Retreat Planning"); // admin has no bypass
    expect(await names("pieter")).toContain("Leadership Retreat Planning"); // member
    const thabo = await t.as("thabo");
    await thabo.get(`/api/projects/${pid(t, "D4C")}`).expect(404);
    await thabo.get(`/api/projects/${pid(t, "Leadership Retreat Planning")}/milestones`).expect(404);
  });

  it("filters the portfolio and returns computed fields", async () => {
    const t = await setup();
    const n = await t.as("naledi");
    const r = await n.get("/api/projects?status=active&sort=health").expect(200);
    expect(r.body.items.every((p: { status: string }) => p.status === "active")).toBe(true);
    const unm = r.body.items.find((p: { name: string }) => p.name === "Unmasking");
    expect(unm.progress.method).toBe("milestones");
    expect(unm.progress.explanation).toMatch(/1 of 3 milestones/);
    expect(unm.next_milestone.title).toBe("Pilot cohort recruited");
    expect(typeof unm.open_actions).toBe("number");
    expect(unm.risk_level).toBe("medium");
  });

  it("hides budget from non-managers but shows it to owners and management", async () => {
    const t = await setup();
    const id = pid(t, "Unmasking");
    const lerato = (await (await t.as("lerato")).get(`/api/projects/${id}`).expect(200)).body;
    expect(lerato.budget_amount).toBeUndefined();
    expect(lerato.budget_visible).toBe(false);
    const sipho = (await (await t.as("sipho")).get(`/api/projects/${id}`).expect(200)).body;
    expect(sipho.budget_amount).toBe(180000);
    const naledi = (await (await t.as("naledi")).get(`/api/projects/${id}`).expect(200)).body;
    expect(naledi.budget_amount).toBe(180000);
    // non-manager cannot write budget either
    await (await t.as("lerato")).patch(`/api/projects/${id}`, { budget_amount: 1 }).expect(403);
  });

  it("creates projects with members, milestones and validation", async () => {
    const t = await setup();
    const lerato = await t.as("lerato");
    await lerato.post("/api/projects", { name: "Nope" }).expect(403); // employee lacks project.create
    const ayesha = await t.as("ayesha");
    const bad = await ayesha.post("/api/projects", { name: "", start_date: "2026-05-01", target_date: "2026-01-01" }).expect(400);
    expect(bad.body.details.fields.name).toBeTruthy();
    const bad2 = await ayesha.post("/api/projects", { name: "X", start_date: "2026-05-01", target_date: "2026-01-01" }).expect(400);
    expect(bad2.body.details.fields.target_date).toBeTruthy();
    const r = await ayesha
      .post("/api/projects", {
        name: "Pilot evaluation",
        visibility: "restricted",
        members: [{ user_id: t.userId("thabo"), role: "member" }],
        milestones: [{ title: "Design", target_date: "2027-01-10" }],
        deliverables: [{ name: "Evaluation plan" }],
      })
      .expect(201);
    const p = (await ayesha.get(`/api/projects/${r.body.id}`).expect(200)).body;
    expect(p.members.map((m: { name: string }) => m.name)).toEqual(expect.arrayContaining(["Ayesha Patel", "Thabo Nkosi"]));
    expect(p.milestones).toHaveLength(1);
    expect(p.counts.deliverables).toBe(1);
    await (await t.as("naledi")).get(`/api/projects/${r.body.id}`).expect(404); // restricted
    expect(t.db.get("SELECT 1 FROM audit_log WHERE action = 'project.create' AND entity_id = ?", r.body.id)).toBeTruthy();
  });

  it("enforces member/role rules and protects the owner", async () => {
    const t = await setup();
    const id = pid(t, "Unmasking");
    const sipho = await t.as("sipho");
    const lerato = await t.as("lerato");
    await lerato.post(`/api/projects/${id}/members`, { user_id: t.userId("pieter") }).expect(403);
    await sipho.post(`/api/projects/${id}/members`, { user_id: t.userId("pieter"), role: "viewer" }).expect(201);
    await sipho.post(`/api/projects/${id}/members`, { user_id: t.userId("pieter") }).expect(409);
    await sipho.patch(`/api/projects/${id}/members/${t.userId("pieter")}`, { role: "manager" }).expect(200);
    await sipho.patch(`/api/projects/${id}/members/${t.userId("sipho")}`, { role: "member" }).expect(400);
    await sipho.del(`/api/projects/${id}/members/${t.userId("sipho")}`).expect(400);
    // Pieter is now a manager and can edit the project
    await (await t.as("pieter")).patch(`/api/projects/${id}`, { priority: "urgent" }).expect(200);
    // Ownership transfer demotes old owner to manager
    await sipho.patch(`/api/projects/${id}`, { owner_id: t.userId("lerato") }).expect(200);
    expect(t.db.get<{ role: string }>("SELECT role FROM project_members WHERE project_id = ? AND user_id = ?", id, t.userId("sipho"))!.role).toBe("manager");
    expect(t.db.get<{ role: string }>("SELECT role FROM project_members WHERE project_id = ? AND user_id = ?", id, t.userId("lerato"))!.role).toBe("owner");
  });

  it("records status/health history and suggests health with factors", async () => {
    const t = await setup();
    const id = pid(t, "D4C");
    const ayesha = await t.as("ayesha");
    const p = (await ayesha.get(`/api/projects/${id}`).expect(200)).body;
    expect(p.health_suggestion.suggested).toBe("blocked");
    expect(p.health_suggestion.factors.map((f: { text: string }) => f.text).join(" ")).toMatch(/blocker/);
    await ayesha.patch(`/api/projects/${id}`, { status: "on_hold", status_note: "Waiting for partner" }).expect(200);
    const hist = (await ayesha.get(`/api/projects/${id}/history`).expect(200)).body;
    expect(hist[0]).toMatchObject({ field: "status", from_value: "active", to_value: "on_hold", note: "Waiting for partner" });
  });

  it("supports every progress method with an explanation", async () => {
    const t = await setup();
    const id = pid(t, "Change OS");
    const sipho = await t.as("sipho");
    const get = async () => (await sipho.get(`/api/projects/${id}`)).body.progress;
    expect((await get()).method).toBe("deliverables");
    expect((await get()).explanation).toMatch(/0 of 2 deliverables/);
    await sipho.patch(`/api/projects/${id}`, { progress_method: "manual" });
    expect((await get()).explanation).toMatch(/not yet reported/);
    await sipho.post(`/api/projects/${id}/updates`, { summary: "Half way", progress: 50 }).expect(201);
    expect((await get()).value).toBe(50);
    await sipho.patch(`/api/projects/${id}`, { progress_method: "tasks" });
    expect((await get()).explanation).toMatch(/tasks completed/);
    await sipho.patch(`/api/projects/${id}`, { progress_method: "weighted" });
    expect((await get()).explanation).toMatch(/weight points/);
  });

  it("runs the deliverable submit → review flow with versions", async () => {
    const t = await setup();
    const did = t.db.get<{ id: string }>("SELECT id FROM deliverables WHERE name = 'Participant invitation pack'")!.id;
    const lerato = await t.as("lerato"); // owner
    const sipho = await t.as("sipho"); // reviewer
    const thabo = await t.as("thabo");
    await lerato.post(`/api/deliverables/${did}/submit`, {}).expect(400); // needs link or note
    await thabo.post(`/api/deliverables/${did}/submit`, { note: "x" }).expect(403);
    await lerato.post(`/api/deliverables/${did}/submit`, { submission_url: "https://docs.google.com/document/d/v1" }).expect(200);
    expect(t.db.get("SELECT 1 FROM notifications WHERE user_id = ? AND type = 'deliverable_submitted'", t.userId("sipho"))).toBeTruthy();
    await thabo.post(`/api/deliverables/${did}/review`, { decision: "approve" }).expect(403);
    await sipho.post(`/api/deliverables/${did}/review`, { decision: "changes" }).expect(400); // note required
    await sipho.post(`/api/deliverables/${did}/review`, { decision: "changes", note: "Add the accessibility note" }).expect(200);
    await lerato.post(`/api/deliverables/${did}/submit`, { submission_url: "https://docs.google.com/document/d/v2", note: "Fixed" }).expect(200);
    const r = await sipho.post(`/api/deliverables/${did}/review`, { decision: "approve" }).expect(200);
    expect(r.body.status).toBe("approved");
    const versions = (await lerato.get(`/api/deliverables/${did}/versions`).expect(200)).body;
    expect(versions.map((v: { version: number }) => v.version)).toEqual([2, 1]);
    const detail = (await lerato.get(`/api/deliverables/${did}`).expect(200)).body;
    expect(detail.tasks.some((x: { title: string }) => x.title === "Finalise participant invitation pack")).toBe(true);
    // owner cannot self-approve via PATCH
    await lerato.patch(`/api/deliverables/${did}`, { status: "approved" }).expect(403);
  });

  it("lets members add risks and notifies the owner on high severity", async () => {
    const t = await setup();
    const id = pid(t, "Unmasking");
    const lerato = await t.as("lerato");
    await lerato.post(`/api/projects/${id}/risks`, { title: "Facilitator illness", severity: "high", type: "risk", likelihood: "low" }).expect(201);
    expect(t.db.get("SELECT 1 FROM notifications WHERE user_id = ? AND type = 'risk_identified'", t.userId("sipho"))).toBeTruthy();
    await (await t.as("pieter")).post(`/api/projects/${id}/risks`, { title: "x" }).expect(403); // not a member
  });

  it("restricts decision approval to decision.approve and filters the log", async () => {
    const t = await setup();
    const ayesha = await t.as("ayesha");
    const naledi = await t.as("naledi");
    const pending = (await naledi.get("/api/decisions?requires_management=1").expect(200)).body.items;
    expect(pending.length).toBeGreaterThanOrEqual(2);
    const d = pending.find((x: { title: string }) => /reduced-data/.test(x.title));
    await ayesha.post(`/api/decisions/${d.id}/approve`, {}).expect(403);
    const r = await naledi.post(`/api/decisions/${d.id}/approve`, { note: "Proceed" }).expect(200);
    expect(r.body.status).toBe("approved");
    await naledi.post(`/api/decisions/${d.id}/reject`, {}).expect(400);
    expect(t.db.get("SELECT 1 FROM audit_log WHERE action = 'decision.approve'")).toBeTruthy();
    // Thabo cannot see D4C decisions
    const thaboLog = (await (await t.as("thabo")).get("/api/decisions").expect(200)).body.items;
    expect(thaboLog.some((x: { project_name: string }) => x.project_name === "D4C")).toBe(false);
    // New pending decision notifies approvers
    await ayesha.post("/api/decisions", { title: "Extend pilot", project_id: pid(t, "D4C"), requires_management: true }).expect(201);
    expect(t.db.get("SELECT 1 FROM notifications WHERE user_id = ? AND title LIKE '%Extend pilot%'", t.userId("naledi"))).toBeTruthy();
  });

  it("reports dependencies and affected work, and blocks cycles", async () => {
    const t = await setup();
    const id = pid(t, "D4C");
    const ayesha = await t.as("ayesha");
    const r = (await ayesha.get(`/api/projects/${id}/dependencies`).expect(200)).body;
    expect(r.edges.length).toBe(1);
    expect(r.affected).toHaveLength(1); // workshop 1 waits on overdue data-sharing agreement
    expect(r.affected[0].item.label).toBe("Co-design workshop 1");
    const m1 = t.db.get<{ id: string }>("SELECT id FROM milestones WHERE title = 'Partnership scope agreed'")!.id;
    const m2 = t.db.get<{ id: string }>("SELECT id FROM milestones WHERE title = 'Co-design workshop 1'")!.id;
    const dsa = t.db.get<{ id: string }>("SELECT id FROM deliverables WHERE name = 'Data-sharing agreement draft'")!.id;
    await ayesha.post("/api/dependencies", { from_type: "deliverable", from_id: dsa, to_type: "milestone", to_id: m2 }).expect(400); // cycle
    await ayesha.post("/api/dependencies", { from_type: "milestone", from_id: m2, to_type: "milestone", to_id: m1 }).expect(201);
    await ayesha.post("/api/dependencies", { from_type: "milestone", from_id: m2, to_type: "milestone", to_id: m1 }).expect(409);
    await (await t.as("thabo")).post("/api/dependencies", { from_type: "milestone", from_id: m2, to_type: "milestone", to_id: m1 }).expect(404);
  });

  it("generates a project report draft with sources", async () => {
    const t = await setup();
    const id = pid(t, "Unmasking");
    const lerato = await t.as("lerato");
    const r = await lerato.post(`/api/projects/${id}/report`).expect(201);
    const rep = t.db.get<{ report_type: string; status: string; content: string; source_records: string }>("SELECT * FROM reports WHERE id = ?", r.body.id)!;
    expect(rep.report_type).toBe("project_report");
    expect(rep.status).toBe("draft");
    const content = JSON.parse(rep.content);
    expect(content.sections.map((s: { key: string }) => s.key)).toEqual(["overview", "progress", "milestones", "deliverables", "risks", "decisions", "next_steps"]);
    expect(JSON.parse(rep.source_records).length).toBeGreaterThan(3);
    await (await t.as("zanele")).post(`/api/projects/${id}/report`).expect(403); // viewer
  });

  it("manages programmes with permission checks", async () => {
    const t = await setup();
    await (await t.as("sipho")).post("/api/programmes", { name: "X" }).expect(403);
    const naledi = await t.as("naledi");
    const r = await naledi.post("/api/programmes", { name: "Systems Change" }).expect(201);
    const list = (await naledi.get("/api/programmes").expect(200)).body;
    expect(list.items.some((g: { name: string }) => g.name === "Systems Change")).toBe(true);
    const org = list.items.find((g: { name: string }) => g.name === "Organisational Change");
    const detail = (await (await t.as("thabo")).get(`/api/programmes/${org.id}`).expect(200)).body;
    expect(detail.projects.some((p: { name: string }) => p.name === "D4C")).toBe(false);
    await naledi.patch(`/api/programmes/${r.body.id}`, { status: "paused" }).expect(200);
  });

  it("filters project activity to records the viewer can see", async () => {
    const t = await setup();
    const id = pid(t, "Unmasking");
    const rows = (await (await t.as("lerato")).get(`/api/projects/${id}/activity`).expect(200)).body;
    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0].actor_name).toBeTruthy();
  });
});
