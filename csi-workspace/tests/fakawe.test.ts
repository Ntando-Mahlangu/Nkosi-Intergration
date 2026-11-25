import { describe, it, expect } from "vitest";
import { setup } from "./helpers";
import { addDays, newId, nowIso } from "../server/lib/ids";
import { orgToday } from "../server/lib/events";

async function ctx() {
  const t = await setup();
  const period = t.db.get<{ id: string; start_date: string; end_date: string }>("SELECT id, start_date, end_date FROM reporting_periods WHERE status = 'open'")!;
  return { t, period };
}

function contentOf(t: Awaited<ReturnType<typeof setup>>, id: string) {
  const r = t.db.get<{ content: string; status: string; quality_flags: string; source_records: string; generated_by: string }>("SELECT * FROM reports WHERE id = ?", id)!;
  return { ...r, sections: JSON.parse(r.content).sections as { key: string; title: string; body?: string; items?: string[] }[], flags: JSON.parse(r.quality_flags) as string[], sources: JSON.parse(r.source_records) as { type: string; id: string }[] };
}

describe("fakawe reporting", () => {
  it("restricts period management to reporting roles", async () => {
    const { t } = await ctx();
    const lerato = await t.as("lerato");
    await lerato.get("/api/fakawe").expect(403);
    const sipho = await t.as("sipho");
    await sipho.post("/api/fakawe", { frequency: "weekly", start_date: "2030-01-07" }).expect(403);
    const naledi = await t.as("naledi"); // management can view
    await naledi.get("/api/fakawe").expect(200);
  });

  it("creates periods with computed end dates and validates input", async () => {
    const { t } = await ctx();
    const z = await t.as("zanele");
    const w = await z.post("/api/fakawe", { frequency: "weekly", start_date: "2030-01-07" }).expect(201);
    expect(w.body.end_date).toBe("2030-01-13");
    const m = await z.post("/api/fakawe", { frequency: "monthly", start_date: "2030-02-01" }).expect(201);
    expect(m.body.end_date).toBe("2030-02-28");
    const bad = await z.post("/api/fakawe", { frequency: "custom", start_date: "2030-03-10", end_date: "2030-03-01" }).expect(400);
    expect(bad.body.details.fields.end_date).toBeTruthy();
    await z.post("/api/fakawe", { frequency: "custom", start_date: "2030-03-10" }).expect(400);
    await z.post("/api/fakawe", { frequency: "weekly", start_date: "2030-01-07" }).expect(409);
  });

  it("generates a draft only from in-period, in-scope records", async () => {
    const { t, period } = await ctx();
    const db = t.db;
    const zanele = t.userId("zanele");
    const now = nowIso();
    const today = orgToday(db);
    // Give zanele visibility of the restricted project and the confidential meeting, to prove they are excluded anyway.
    const retreat = db.get<{ id: string }>("SELECT id FROM projects WHERE name = 'Leadership Retreat Planning'")!.id;
    db.insert("project_members", { project_id: retreat, user_id: zanele, role: "member", added_at: now });
    db.run("UPDATE tasks SET status = 'completed', completed_at = ? WHERE title = 'Shortlist retreat venues'", now);
    const conf = db.get<{ id: string }>("SELECT id FROM meetings WHERE confidential = 1")!.id;
    db.insert("meeting_participants", { id: newId("mpt"), meeting_id: conf, user_id: zanele, attendance: "attended" });
    db.run("UPDATE meetings SET status = 'approved', meeting_date = ? WHERE id = ?", today, conf);
    // D4C is team-visible; make zanele a member so its pending decision is in her scope.
    const d4c = db.get<{ id: string }>("SELECT id FROM projects WHERE name = 'D4C'")!.id;
    db.insert("project_members", { project_id: d4c, user_id: zanele, role: "viewer", added_at: now });
    // Personal task completed in period
    db.insert("tasks", { id: newId("tsk"), ref: 99001, title: "SECRET personal errand", assignee_id: zanele, creator_id: zanele, is_personal: 1, status: "completed", completed_at: now, created_at: now, updated_at: now });
    // Project task completed BEFORE the period → excluded
    const research = db.get<{ id: string }>("SELECT id FROM projects WHERE name = 'Research & Knowledge Initiative'")!.id;
    db.insert("tasks", { id: newId("tsk"), ref: 99002, title: "OLD completed task", assignee_id: zanele, creator_id: zanele, project_id: research, status: "completed", completed_at: addDays(period.start_date, -3) + "T10:00:00.000Z", created_at: now, updated_at: now });
    // Project task completed IN the period → included
    db.insert("tasks", { id: newId("tsk"), ref: 99003, title: "IN-PERIOD completed task", assignee_id: zanele, creator_id: zanele, project_id: research, status: "completed", completed_at: now, created_at: now, updated_at: now });

    const z = await t.as("zanele");
    const g = await z.post(`/api/fakawe/${period.id}/generate`).expect(201);
    const rep = contentOf(t, g.body.report_id);
    expect(rep.status).toBe("draft");
    expect(rep.generated_by).toBe("rules");
    const all = JSON.stringify(rep.sections);
    expect(all).toContain("IN-PERIOD completed task");
    expect(all).not.toContain("OLD completed task");
    expect(all).not.toContain("SECRET personal errand");
    expect(all).not.toContain("Shortlist retreat venues");
    expect(all).not.toContain("Leadership Retreat");
    expect(all).not.toContain("Management meeting");
    expect(rep.sources.some((s) => s.id === conf || s.id === retreat)).toBe(false);
    // Empty sections are skipped; every present section has content
    for (const s of rep.sections) expect(Boolean(s.body) || (s.items?.length ?? 0) > 0).toBe(true);
    expect(rep.sections[0].key).toBe("executive_overview");
    // Decisions required are kept separate from decisions made
    const req = rep.sections.find((s) => s.key === "decisions_required");
    expect(req?.items?.join(" ")).toContain("reduced-data");
    // Management-only decision (no project) is not visible to zanele → not included
    expect(req?.items?.join(" ")).not.toContain("Adopt CSI Workspace");
    // Quality flags: missing updates for active projects without an update this period
    expect(rep.flags.some((f) => f.startsWith("Missing project updates"))).toBe(true);
    // approver notified
    expect(db.get("SELECT 1 FROM notifications WHERE type = 'fakawe_draft' AND user_id = ?", t.userId("naledi"))).toBeTruthy();
  });

  it("regenerates while draft (keeping human observations) and refuses once in review", async () => {
    const { t, period } = await ctx();
    const z = await t.as("zanele");
    const g = await z.post(`/api/fakawe/${period.id}/generate`).expect(201);
    const id = g.body.report_id;
    const c = JSON.parse(t.db.get<{ content: string }>("SELECT content FROM reports WHERE id = ?", id)!.content);
    c.sections.push({ key: "human_observations", title: "Human observations", body: "Team morale is good." });
    t.db.run("UPDATE reports SET content = ? WHERE id = ?", JSON.stringify(c), id);
    const g2 = await z.post(`/api/fakawe/${period.id}/generate`).expect(200);
    expect(g2.body.version).toBe(2);
    expect(JSON.stringify(contentOf(t, id).sections)).toContain("Team morale is good.");
    expect(t.db.get<{ n: number }>("SELECT COUNT(*) n FROM report_versions WHERE report_id = ?", id)!.n).toBe(2);
    t.db.run("UPDATE reports SET status = 'in_review' WHERE id = ?", id);
    await z.post(`/api/fakawe/${period.id}/generate`).expect(409);
    expect(contentOf(t, id).status).toBe("in_review"); // never auto-approved
  });

  it("dashboard reports missing updates, review items and an explained time estimate", async () => {
    const { t, period } = await ctx();
    const z = await t.as("zanele");
    const d = await z.get(`/api/fakawe/${period.id}/dashboard`).expect(200);
    expect(d.body.period.id).toBe(period.id);
    expect(Array.isArray(d.body.missing_updates)).toBe(true);
    expect(d.body.minutes_saved_basis).toMatch(/Estimate/);
    expect(d.body.source_counts).toHaveProperty("project_updates");
    expect(d.body.report).toBeNull();
    // previous published digest is listed
    expect(d.body.previous.length).toBeGreaterThan(0);
  });
});
