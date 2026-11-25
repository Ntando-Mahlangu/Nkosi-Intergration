import { describe, it, expect } from "vitest";
import { setup } from "./helpers";

const taskId = (t: Awaited<ReturnType<typeof setup>>, like: string) => t.db.get<{ id: string }>("SELECT id FROM tasks WHERE title LIKE ?", like)!.id;
const projectId = (t: Awaited<ReturnType<typeof setup>>, name: string) => t.db.get<{ id: string }>("SELECT id FROM projects WHERE name = ?", name)!.id;

describe("tasks: listing & privacy", () => {
  it("views filter my tasks correctly", async () => {
    const t = await setup();
    const lerato = await t.as("lerato");
    const all = await lerato.get("/api/tasks").expect(200);
    expect(all.body.total).toBe(7);
    expect((await lerato.get("/api/tasks?view=today")).body.total).toBe(2);
    expect((await lerato.get("/api/tasks?view=overdue")).body.total).toBe(1);
    expect((await lerato.get("/api/tasks?view=completed")).body.total).toBe(1);
    expect((await lerato.get("/api/tasks?view=personal")).body.total).toBe(1);
    expect((await lerato.get("/api/tasks?view=suggested")).body.total).toBe(1);
    const row = all.body.items.find((r: { title: string }) => r.title.startsWith("Finalise participant"));
    expect(row).toMatchObject({ project_name: "Unmasking", can_work: true, review_required: true, reviewer_name: "Sipho Dlamini" });
    const zanele = await t.as("zanele");
    expect((await zanele.get("/api/tasks?view=to_review")).body.total).toBe(1);
  });

  it("personal tasks are private — even from management and admins", async () => {
    const t = await setup();
    const n2 = taskId(t, "Review Q-plan priorities%");
    for (const u of ["grace", "lerato", "sipho"] as const) {
      const a = await t.as(u);
      await a.get(`/api/tasks/${n2}`).expect(404);
      const list = await a.get(`/api/tasks?scope=visible&q=Q-plan`).expect(200);
      expect(list.body.total).toBe(0);
    }
    await (await t.as("naledi")).get(`/api/tasks/${n2}`).expect(200);
  });

  it("restricted project tasks are invisible to non-members", async () => {
    const t = await setup();
    const p3 = taskId(t, "Shortlist retreat venues");
    const retreat = projectId(t, "Leadership Retreat Planning");
    const grace = await t.as("grace");
    await grace.get(`/api/tasks/${p3}`).expect(404);
    expect((await grace.get(`/api/tasks?project_id=${retreat}`)).body.total).toBe(0);
    const pieter = await t.as("pieter");
    await pieter.get(`/api/tasks/${p3}`).expect(200);
  });
});

describe("tasks: creation & assignment", () => {
  it("employee can create own task but cannot assign to others", async () => {
    const t = await setup();
    const lerato = await t.as("lerato");
    const r = await lerato.post("/api/tasks", { title: "My new task", due_date: "2030-01-01", is_personal: true }).expect(201);
    expect(r.body.assignee_id).toBe(t.userId("lerato"));
    expect(r.body.is_personal).toBe(true);
    expect(r.body.ref).toBeGreaterThan(1000);
    await lerato.post("/api/tasks", { title: "For Thabo", assignee_id: t.userId("thabo") }).expect(403);
    await lerato.post("/api/tasks", { title: "" }).expect(400);
    const bad = await lerato.post("/api/tasks", { title: "x", due_date: "2030-13-45" }).expect(400);
    expect(bad.body.details.fields.due_date).toBeTruthy();
  });

  it("project manager assigns within their project, notifying and auditing", async () => {
    const t = await setup();
    const sipho = await t.as("sipho");
    const unm = projectId(t, "Unmasking");
    const r = await sipho.post("/api/tasks", { title: "Print handouts", project_id: unm, assignee_id: t.userId("lerato"), priority: "high" }).expect(201);
    expect(t.db.get("SELECT 1 FROM notifications WHERE user_id = ? AND type = 'task_assigned' AND entity_id = ?", t.userId("lerato"), r.body.id)).toBeTruthy();
    expect(t.db.get("SELECT 1 FROM audit_log WHERE action = 'task.assign' AND entity_id = ?", r.body.id)).toBeTruthy();
    // Sipho can see D4C (same team) but is not a member → cannot add/assign tasks there
    await sipho.post("/api/tasks", { title: "x", project_id: projectId(t, "D4C"), assignee_id: t.userId("lerato") }).expect(403);
  });

  it("cannot add tasks to projects the user can't see", async () => {
    const t = await setup();
    const lerato = await t.as("lerato");
    await lerato.post("/api/tasks", { title: "x", project_id: projectId(t, "Leadership Retreat Planning") }).expect(400);
  });

  it("worker cannot edit manager fields", async () => {
    const t = await setup();
    const lerato = await t.as("lerato");
    const l2 = taskId(t, "Send pilot reminder%");
    await lerato.patch(`/api/tasks/${l2}`, { due_date: "2031-01-01" }).expect(403);
    await lerato.patch(`/api/tasks/${l2}`, { status: "in_progress" }).expect(200);
    await lerato.patch(`/api/tasks/${l2}`, { status: "blocked" }).expect(400);
    const b = await lerato.patch(`/api/tasks/${l2}`, { status: "blocked", blocked_reason: "Waiting on list" }).expect(200);
    expect(b.body.status).toBe("blocked");
    expect(t.db.get("SELECT 1 FROM status_history WHERE entity_id = ? AND to_value = 'blocked'", l2)).toBeTruthy();
  });
});

describe("tasks: workflows", () => {
  it("review workflow: submit → changes requested → resubmit → approve", async () => {
    const t = await setup();
    const lerato = await t.as("lerato");
    const sipho = await t.as("sipho");
    const l1 = taskId(t, "Finalise participant%");
    await lerato.post(`/api/tasks/${l1}/complete`).expect(400); // review required
    await lerato.post(`/api/tasks/${l1}/review`, { decision: "approve" }).expect(400); // not awaiting
    await lerato.post(`/api/tasks/${l1}/submit-review`, { note: "Ready" }).expect(200);
    expect(t.db.get("SELECT 1 FROM notifications WHERE user_id = ? AND type = 'review_requested' AND entity_id = ?", t.userId("sipho"), l1)).toBeTruthy();
    await lerato.post(`/api/tasks/${l1}/review`, { decision: "approve" }).expect(403); // self-review
    await sipho.post(`/api/tasks/${l1}/review`, { decision: "changes" }).expect(400); // feedback needed
    const ch = await sipho.post(`/api/tasks/${l1}/review`, { decision: "changes", feedback: "Add the venue map" }).expect(200);
    expect(ch.body).toMatchObject({ status: "in_progress", review_status: "changes_requested" });
    await lerato.post(`/api/tasks/${l1}/submit-review`).expect(200);
    const ok = await sipho.post(`/api/tasks/${l1}/review`, { decision: "approve", feedback: "Looks good" }).expect(200);
    expect(ok.body).toMatchObject({ status: "completed", review_status: "approved" });
    const detail = await lerato.get(`/api/tasks/${l1}`).expect(200);
    expect(detail.body.reviews.length).toBe(2);
    expect(detail.body.history.some((h: { to_value: string }) => h.to_value === "changes_requested")).toBe(true);
  });

  it("suggested tasks must be accepted or declined by the assignee", async () => {
    const t = await setup();
    const sug = taskId(t, "Shortlist two online%");
    const thabo = await t.as("thabo");
    await thabo.post(`/api/tasks/${sug}/accept`).expect(404); // not visible to thabo (D4C team project)
    const lerato = await t.as("lerato");
    await lerato.post(`/api/tasks/${sug}/complete`).expect(400);
    const a = await lerato.post(`/api/tasks/${sug}/accept`, { due_date: "2030-02-01" }).expect(200);
    expect(a.body).toMatchObject({ status: "todo", due_date: "2030-02-01" });
    await lerato.post(`/api/tasks/${sug}/decline`, { reason: "x" }).expect(400);
  });

  it("declining requires a reason and notifies the creator", async () => {
    const t = await setup();
    const sug = taskId(t, "Shortlist two online%");
    const lerato = await t.as("lerato");
    await lerato.post(`/api/tasks/${sug}/decline`, { reason: "" }).expect(400);
    const d = await lerato.post(`/api/tasks/${sug}/decline`, { reason: "Not my area" }).expect(200);
    expect(d.body.status).toBe("cancelled");
    expect(t.db.get("SELECT 1 FROM notifications WHERE user_id = ? AND entity_id = ? AND title LIKE '%declined%'", t.userId("ayesha"), sug)).toBeTruthy();
  });

  it("complete and reopen", async () => {
    const t = await setup();
    const lerato = await t.as("lerato");
    const l5 = taskId(t, "Collect partner HR%");
    const c = await lerato.post(`/api/tasks/${l5}/complete`).expect(200);
    expect(c.body.completed_at).toBeTruthy();
    const r = await lerato.post(`/api/tasks/${l5}/reopen`).expect(200);
    expect(r.body).toMatchObject({ status: "todo", completed_at: null });
  });

  it("dependencies: rejects self and cycles", async () => {
    const t = await setup();
    const thabo = await t.as("thabo");
    const t5 = taskId(t, "Blocked: obtain source%");
    const t2 = taskId(t, "Write summaries for batch 2%");
    await thabo.post(`/api/tasks/${t5}/dependencies`, { depends_on_task_id: t5 }).expect(400);
    await thabo.post(`/api/tasks/${t2}/dependencies`, { depends_on_task_id: t5 }).expect(201);
    const cyc = await thabo.post(`/api/tasks/${t5}/dependencies`, { depends_on_task_id: t2 }).expect(400);
    expect(cyc.body.error).toMatch(/circular/);
    const d = await thabo.get(`/api/tasks/${t2}`).expect(200);
    expect(d.body.depends_on[0].label).toMatch(/obtain source/);
    expect(d.body.blocked_by_open).toBe(1);
  });

  it("deleting a meeting action cancels instead of erasing", async () => {
    const t = await setup();
    const sipho = await t.as("sipho");
    const l1 = taskId(t, "Finalise participant%");
    const r = await sipho.del(`/api/tasks/${l1}`).expect(200);
    expect(r.body.cancelled).toBe(true);
    const lerato = await t.as("lerato");
    const l7 = taskId(t, "Update my CV%");
    await sipho.del(`/api/tasks/${l7}`).expect(404);
    await lerato.del(`/api/tasks/${l7}`).expect(200);
    expect(t.db.get("SELECT 1 FROM tasks WHERE id = ?", l7)).toBeUndefined();
  });

  it("exports my tasks as CSV and audits it", async () => {
    const t = await setup();
    const lerato = await t.as("lerato");
    const r = await lerato.get("/api/tasks/export.csv?view=all").expect(200);
    expect(r.headers["content-type"]).toMatch(/text\/csv/);
    const lines = r.text.trim().split(/\r\n/);
    expect(lines[0]).toMatch(/^ref,title,status/);
    expect(lines.length).toBe(8);
    expect(t.db.get("SELECT 1 FROM audit_log WHERE action = 'export.tasks'")).toBeTruthy();
  });
});
