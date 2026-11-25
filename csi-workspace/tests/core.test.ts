import { describe, it, expect } from "vitest";
import { setup } from "./helpers";

describe("auth & core", () => {
  it("rejects unauthenticated API access", async () => {
    const t = await setup();
    await t.anon().get("/api/me").expect(401);
  });

  it("rejects bad passwords and audits the failure", async () => {
    const t = await setup();
    await t.anon().post("/auth/login").set("x-csi-request", "1").send({ email: "lerato@demo.csi.example", password: "wrong" }).expect(401);
    expect(t.db.get("SELECT 1 FROM audit_log WHERE action = 'auth.login_failed'")).toBeTruthy();
  });

  it("blocks state-changing requests without the CSRF header", async () => {
    const t = await setup();
    await t.anon().post("/auth/login").send({ email: "lerato@demo.csi.example", password: "x" }).expect(403);
  });

  it("returns the signed-in user with role permissions", async () => {
    const t = await setup();
    const a = await t.as("naledi");
    const r = await a.get("/api/me").expect(200);
    expect(r.body.user.role_key).toBe("management");
    expect(r.body.permissions).toContain("management.view");
    expect(r.body.ai.engine).toBe("rules");
  });

  it("hides restricted projects from lookups for non-members (even management/admin)", async () => {
    const t = await setup();
    const names = async (u: "lerato" | "naledi" | "grace" | "pieter") => ((await (await t.as(u)).get("/api/lookups")).body.projects as { name: string }[]).map((p) => p.name);
    expect(await names("lerato")).not.toContain("Leadership Retreat Planning");
    expect(await names("grace")).not.toContain("Leadership Retreat Planning");
    expect(await names("pieter")).toContain("Leadership Retreat Planning");
    expect(await names("naledi")).toContain("Leadership Retreat Planning"); // owner
    // team-visibility project D4C: management (view_all) sees it, non-member employee outside team does not
    expect(await names("naledi")).toContain("D4C");
    expect(await names("thabo")).not.toContain("D4C");
  });

  it("validates document links and enforces record access", async () => {
    const t = await setup();
    const lerato = await t.as("lerato");
    const retreat = t.db.get<{ id: string }>("SELECT id FROM projects WHERE name = 'Leadership Retreat Planning'")!.id;
    await lerato.get(`/api/attachments?entity_type=project&entity_id=${retreat}`).expect(404);
    const unm = t.db.get<{ id: string }>("SELECT id FROM projects WHERE name = 'Unmasking'")!.id;
    const bad = await lerato.post("/api/attachments", { entity_type: "project", entity_id: unm, title: "x", url: "javascript:alert(1)" }).expect(400);
    expect(bad.body.details.fields.url).toBeTruthy();
    await lerato.post("/api/attachments", { entity_type: "project", entity_id: unm, title: "Brief", url: "https://docs.google.com/document/d/abc" }).expect(201);
    const list = await lerato.get(`/api/attachments?entity_type=project&entity_id=${unm}`).expect(200);
    expect(list.body[0].kind).toBe("google_doc");
  });

  it("project-level knowledge is visible to project members only, not every viewer of the project", async () => {
    const t = await setup();
    const id = t.db.get<{ id: string }>("SELECT id FROM knowledge_items WHERE title = 'Unmasking facilitation guide v1'")!.id;
    await (await t.as("lerato")).get(`/api/knowledge/${id}`).expect(200); // member
    await (await t.as("pieter")).get(`/api/knowledge/${id}`).expect(404); // can see the org-wide project, but not a member
  });
});
