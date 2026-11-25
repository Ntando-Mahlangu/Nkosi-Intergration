import { describe, it, expect } from "vitest";
import { setup } from "./helpers";

const idOf = (t: Awaited<ReturnType<typeof setup>>, title: string) => t.db.get<{ id: string }>("SELECT id FROM knowledge_items WHERE title = ?", title)!.id;

describe("knowledge hub", () => {
  it("lists only items the user may see (management, project, restricted, drafts)", async () => {
    const t = await setup();
    const d4c = t.db.get<{ id: string }>("SELECT id FROM projects WHERE name = 'D4C'")!.id;
    const created = await (await t.as("ayesha")).post("/api/knowledge", { title: "D4C partner map", category: "Partnership knowledge", access_level: "project", project_id: d4c, action: "submit" }).expect(201);
    t.db.run("UPDATE knowledge_items SET status = 'published' WHERE id = ?", created.body.id); // published project-level item
    const titles = async (u: "lerato" | "thabo" | "naledi" | "pieter" | "ayesha") => ((await (await t.as(u)).get("/api/knowledge?limit=100").expect(200)).body.items as { title: string }[]).map((i) => i.title);
    const pieter = await titles("pieter");
    expect(pieter).toContain("How to onboard a supplier");
    expect(pieter).not.toContain("Management: funding scenarios (restricted)"); // management-only
    expect(pieter).not.toContain("D4C partner map"); // project-level on a team project he cannot see
    expect(pieter).not.toContain("Draft: Corporate offer positioning"); // someone else's draft
    expect(await titles("ayesha")).toContain("D4C partner map"); // author / project owner
    expect(await titles("lerato")).toContain("D4C partner map"); // D4C project member
    expect(await titles("thabo")).not.toContain("D4C partner map");
    expect(await titles("naledi")).toContain("Management: funding scenarios (restricted)");
    expect(await titles("ayesha")).toContain("Draft: Corporate offer positioning"); // author
    // in_review item: visible to author and knowledge managers, not other staff
    expect(await titles("ayesha")).toContain("Insight: partners prefer one-page summaries");
    expect(pieter).not.toContain("Insight: partners prefer one-page summaries");
    const zanele = ((await (await t.as("zanele")).get("/api/knowledge?status=in_review").expect(200)).body.items as { title: string }[]).map((i) => i.title);
    expect(zanele).toContain("Insight: partners prefer one-page summaries");
  });

  it("returns 404 (not 403) for items the user cannot see", async () => {
    const t = await setup();
    const pieter = await t.as("pieter");
    await pieter.get(`/api/knowledge/${idOf(t, "Management: funding scenarios (restricted)")}`).expect(404);
  });

  it("restricted items are visible only to explicit grantees", async () => {
    const t = await setup();
    const zanele = await t.as("zanele");
    const pieterId = t.userId("pieter");
    const r = await zanele.post("/api/knowledge", { title: "Board pack notes", category: "Decisions", access_level: "restricted", action: "publish", grant_user_ids: [pieterId] }).expect(201);
    await (await t.as("pieter")).get(`/api/knowledge/${r.body.id}`).expect(200);
    await (await t.as("lerato")).get(`/api/knowledge/${r.body.id}`).expect(404);
    await zanele.del(`/api/knowledge/${r.body.id}/access/${pieterId}`).expect(200);
    await (await t.as("pieter")).get(`/api/knowledge/${r.body.id}`).expect(404);
  });

  it("enforces the review workflow: only knowledge managers publish", async () => {
    const t = await setup();
    const lerato = await t.as("lerato");
    await lerato.post("/api/knowledge", { title: "x", category: "Other", action: "publish" }).expect(403);
    const created = await lerato.post("/api/knowledge", { title: "How we run check-ins", category: "Procedures", item_type: "procedure", action: "submit" }).expect(201);
    expect(created.body.status).toBe("in_review");
    expect(t.db.get("SELECT 1 FROM notifications WHERE type = 'knowledge_review' AND entity_id = ?", created.body.id)).toBeTruthy();
    await lerato.post(`/api/knowledge/${created.body.id}/publish`).expect(403);
    const zanele = await t.as("zanele");
    await zanele.post(`/api/knowledge/${created.body.id}/return`, { note: "" }).expect(400);
    await zanele.post(`/api/knowledge/${created.body.id}/return`, { note: "Add an owner" }).expect(200);
    await lerato.post(`/api/knowledge/${created.body.id}/submit`).expect(200);
    const pub = await zanele.post(`/api/knowledge/${created.body.id}/publish`).expect(200);
    expect(pub.body.status).toBe("published");
    expect(pub.body.published_date).toBeTruthy();
    expect(t.db.get("SELECT 1 FROM audit_log WHERE action = 'knowledge.published' AND entity_id = ?", created.body.id)).toBeTruthy();
  });

  it("creates versions on substantive edits and blocks non-editors", async () => {
    const t = await setup();
    const id = idOf(t, "How to onboard a supplier");
    await (await t.as("lerato")).patch(`/api/knowledge/${id}`, { title: "Hacked" }).expect(403);
    const pieter = await t.as("pieter");
    const r = await pieter.patch(`/api/knowledge/${id}`, { body: "1. New step" }).expect(200);
    expect(r.body.version).toBe(3);
    const v = await pieter.get(`/api/knowledge/${id}/versions/2`).expect(200);
    expect(v.body.body).toContain("banking");
    const tagOnly = await pieter.patch(`/api/knowledge/${id}`, { tags: "ops, finance, ops" }).expect(200);
    expect(tagOnly.body.version).toBe(3);
    expect(tagOnly.body.tags).toBe("ops,finance");
  });

  it("validates input (project access, links, project-level needs project)", async () => {
    const t = await setup();
    const lerato = await t.as("lerato");
    const retreat = t.db.get<{ id: string }>("SELECT id FROM projects WHERE name = 'Leadership Retreat Planning'")!.id;
    const a = await lerato.post("/api/knowledge", { title: "x", category: "Other", project_id: retreat }).expect(400);
    expect(a.body.details.fields.project_id).toBeTruthy();
    const b = await lerato.post("/api/knowledge", { title: "x", category: "Other", document_url: "javascript:alert(1)" }).expect(400);
    expect(b.body.details.fields.document_url).toBeTruthy();
    const c = await lerato.post("/api/knowledge", { title: "x", category: "Other", access_level: "project" }).expect(400);
    expect(c.body.details.fields.project_id).toBeTruthy();
  });

  it("discover returns sections, review-due for owners and awaiting-review for managers", async () => {
    const t = await setup();
    const pieter = (await (await t.as("pieter")).get("/api/knowledge/discover").expect(200)).body;
    expect(pieter.procedures.map((p: { title: string }) => p.title)).toContain("How to onboard a supplier");
    expect(pieter.review_due.map((p: { title: string }) => p.title)).toContain("How to onboard a supplier");
    expect(pieter.awaiting_review).toEqual([]);
    const zanele = (await (await t.as("zanele")).get("/api/knowledge/discover").expect(200)).body;
    expect(zanele.awaiting_review.length).toBeGreaterThan(0);
    const lerato = (await (await t.as("lerato")).get("/api/knowledge/discover").expect(200)).body;
    expect(lerato.my_projects.map((p: { title: string }) => p.title)).toContain("Unmasking facilitation guide v1");
  });

  it("detail returns similar items and increments views; review-complete sets dates", async () => {
    const t = await setup();
    const id = idOf(t, "How to prepare a call report");
    const pieter = await t.as("pieter");
    const d = await pieter.get(`/api/knowledge/${id}`).expect(200);
    expect(d.body.related.map((r: { label: string }) => r.label)).toContain("Meeting notes template");
    expect(t.db.get<{ view_count: number }>("SELECT view_count FROM knowledge_items WHERE id = ?", id)!.view_count).toBe(1);
    const z = await (await t.as("zanele")).post(`/api/knowledge/${id}/review-complete`, {}).expect(200);
    expect(z.body.last_reviewed_date).toBeTruthy();
    expect(z.body.review_date > z.body.last_reviewed_date).toBe(true);
  });
});
