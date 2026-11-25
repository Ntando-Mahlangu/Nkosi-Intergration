import { describe, it, expect } from "vitest";
import { setup } from "./helpers";

const projectId = (t: Awaited<ReturnType<typeof setup>>, name: string) => t.db.get<{ id: string }>("SELECT id FROM projects WHERE name = ?", name)!.id;
const meetingId = (t: Awaited<ReturnType<typeof setup>>, title: string) => t.db.get<{ id: string }>("SELECT id FROM meetings WHERE title = ?", title)!.id;

describe("meetings", () => {
  it("creates a meeting with internal + external participants and validates input", async () => {
    const t = await setup();
    const sipho = await t.as("sipho");
    const bad = await sipho.post("/api/meetings", { title: "", meeting_date: "2026-13-40", meeting_link: "ftp://x" }).expect(400);
    expect(Object.keys(bad.body.details.fields)).toEqual(expect.arrayContaining(["title", "meeting_date", "meeting_link"]));
    const r = await sipho
      .post("/api/meetings", {
        title: "Planning",
        meeting_date: "2099-01-10",
        start_time: "10:00",
        end_time: "11:00",
        project_id: projectId(t, "Unmasking"),
        participants: { user_ids: [t.userId("lerato")], external: [{ name: "Alex Guest", org: "Org Z" }] },
      })
      .expect(201);
    const d = await sipho.get(`/api/meetings/${r.body.id}`).expect(200);
    expect(d.body.participants).toHaveLength(3);
    expect(d.body.permissions.can_manage).toBe(true);
    expect(t.db.get("SELECT 1 FROM notifications WHERE user_id = ? AND type = 'meeting_upcoming' AND entity_id = ?", t.userId("lerato"), r.body.id)).toBeTruthy();
  });

  it("processes notes into pending suggestions without creating any records", async () => {
    const t = await setup();
    const sipho = await t.as("sipho");
    const tasksBefore = t.db.get<{ n: number }>("SELECT COUNT(*) n FROM tasks")!.n;
    const decBefore = t.db.get<{ n: number }>("SELECT COUNT(*) n FROM decisions")!.n;
    const c = await sipho
      .post("/api/meetings", {
        title: "Review",
        meeting_date: "2026-01-05",
        project_id: projectId(t, "Unmasking"),
        participants: { user_ids: [t.userId("lerato")] },
        notes: "Decision: Go with option B\nAction: Lerato to send the invitation by 2026-01-12\nAction: Book a room\nRisk: Venue may be unavailable\nInsight: Short emails work better",
      })
      .expect(201);
    const p = await sipho.post(`/api/meetings/${c.body.id}/process`).expect(200);
    expect(p.body.engine).toBe("rules");
    const s = await sipho.get(`/api/meetings/${c.body.id}/suggestions`).expect(200);
    const kinds = s.body.items.map((x: { kind: string }) => x.kind);
    expect(kinds).toEqual(expect.arrayContaining(["summary", "action", "decision", "risk", "knowledge"]));
    const action = s.body.items.find((x: { kind: string; payload: { title: string } }) => x.kind === "action" && /invitation/.test(x.payload.title));
    expect(action.payload.owner_id).toBe(t.userId("lerato"));
    expect(action.payload.due_date).toBe("2026-01-12");
    const unowned = s.body.items.find((x: { kind: string; payload: { title: string } }) => x.kind === "action" && /room/i.test(x.payload.title));
    expect(unowned.payload.owner_id).toBeNull(); // never invented
    expect(unowned.payload.due_date).toBe("");
    expect(t.db.get<{ n: number }>("SELECT COUNT(*) n FROM tasks")!.n).toBe(tasksBefore);
    expect(t.db.get<{ n: number }>("SELECT COUNT(*) n FROM decisions")!.n).toBe(decBefore);
    // owner notified? sipho is owner and processor → no self-notification
    // accept named action → 'suggested' task for Lerato, who is notified
    await sipho.post(`/api/meetings/${c.body.id}/suggestions/${action.id}/accept`, {}).expect(200);
    const task = t.db.get<{ status: string; assignee_id: string; source: string }>("SELECT status, assignee_id, source FROM tasks WHERE meeting_id = ? AND title LIKE '%invitation%'", c.body.id)!;
    expect(task).toMatchObject({ status: "suggested", assignee_id: t.userId("lerato"), source: "meeting" });
    expect(t.db.get("SELECT 1 FROM notifications WHERE user_id = ? AND type = 'task_suggested'", t.userId("lerato"))).toBeTruthy();
    // cannot accept twice
    await sipho.post(`/api/meetings/${c.body.id}/suggestions/${action.id}/accept`, {}).expect(400);
    // accept unowned action assigning to self → todo
    await sipho.post(`/api/meetings/${c.body.id}/suggestions/${unowned.id}/accept`, { owner_id: t.userId("sipho"), due_date: "2026-02-01" }).expect(200);
    expect(t.db.get<{ status: string }>("SELECT status FROM tasks WHERE meeting_id = ? AND title LIKE '%room%'", c.body.id)!.status).toBe("todo");
    // bulk accept decision + risk
    const rest = s.body.items.filter((x: { kind: string }) => ["decision", "risk"].includes(x.kind)).map((x: { id: string }) => x.id);
    const bulk = await sipho.post(`/api/meetings/${c.body.id}/suggestions/bulk`, { ids: rest, action: "accept" }).expect(200);
    expect(bulk.body.failed).toBe(0);
    expect(t.db.get("SELECT 1 FROM decisions WHERE meeting_id = ?", c.body.id)).toBeTruthy();
    expect(t.db.get("SELECT 1 FROM risks WHERE source_meeting_id = ?", c.body.id)).toBeTruthy();
  });

  it("refuses to accept a risk when the meeting has no project", async () => {
    const t = await setup();
    const sipho = await t.as("sipho");
    const c = await sipho.post("/api/meetings", { title: "Loose", meeting_date: "2026-01-05", notes: "Risk: Budget overrun" }).expect(201);
    await sipho.post(`/api/meetings/${c.body.id}/process`).expect(200);
    const s = await sipho.get(`/api/meetings/${c.body.id}/suggestions`).expect(200);
    const risk = s.body.items.find((x: { kind: string }) => x.kind === "risk");
    const r = await sipho.post(`/api/meetings/${c.body.id}/suggestions/${risk.id}/accept`, {}).expect(400);
    expect(r.body.error).toMatch(/project/i);
  });

  it("only the meeting owner can review suggestions", async () => {
    const t = await setup();
    const lerato = await t.as("lerato");
    const id = meetingId(t, "D4C partner check-in");
    await lerato.get(`/api/meetings/${id}`).expect(200); // participant
    await lerato.get(`/api/meetings/${id}/suggestions`).expect(403);
    await lerato.post(`/api/meetings/${id}/approve`).expect(403);
  });

  it("keeps confidential meetings invisible to non-participants, including management roles and admins", async () => {
    const t = await setup();
    const id = meetingId(t, "Management meeting");
    for (const u of ["lerato", "zanele", "grace"] as const) {
      const a = await t.as(u);
      await a.get(`/api/meetings/${id}`).expect(404);
      const list = await a.get("/api/meetings?view=all").expect(200);
      expect(list.body.items.map((m: { id: string }) => m.id)).not.toContain(id);
    }
    const ayesha = await t.as("ayesha");
    await ayesha.get(`/api/meetings/${id}`).expect(200);
  });

  it("generates call reports only from approved meetings", async () => {
    const t = await setup();
    const ayesha = await t.as("ayesha");
    const id = meetingId(t, "D4C partner check-in");
    const refused = await ayesha.post(`/api/meetings/${id}/call-report`).expect(400);
    expect(refused.body.error).toMatch(/approve/i);
    await ayesha.post(`/api/meetings/${id}/approve`, { summary: "Partner legal still reviewing the agreement." }).expect(200);
    expect(t.db.get("SELECT 1 FROM audit_log WHERE action = 'meeting.approve' AND entity_id = ?", id)).toBeTruthy();
    const rep = await ayesha.post(`/api/meetings/${id}/call-report`).expect(201);
    const r = await ayesha.get(`/api/reports/${rep.body.id}`).expect(200);
    expect(r.body.report_type).toBe("call_report");
    expect(r.body.status).toBe("draft");
    const overview = r.body.content.sections.find((s: { key: string }) => s.key === "overview");
    expect(overview.body).toContain("Partner legal still reviewing");
    // unreviewed suggestions are excluded and flagged
    expect(r.body.quality_flags.join(" ")).toMatch(/not reviewed/);
    expect(t.db.get("SELECT 1 FROM report_versions WHERE report_id = ? AND version = 1", rep.body.id)).toBeTruthy();
  });

  it("lists meetings by view and shows meeting history for the project", async () => {
    const t = await setup();
    const sipho = await t.as("sipho");
    const up = await sipho.get("/api/meetings?view=upcoming").expect(200);
    for (const m of up.body.items) expect(m.meeting_date >= up.body.today).toBe(true);
    const c = await sipho.post("/api/meetings", { title: "Follow-on", meeting_date: "2099-02-01", project_id: projectId(t, "Unmasking") }).expect(201);
    const d = await sipho.get(`/api/meetings/${c.body.id}`).expect(200);
    expect(d.body.history.map((h: { title: string }) => h.title)).toContain("Unmasking pilot planning");
  });
});
