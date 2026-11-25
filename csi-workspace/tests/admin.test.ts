import { describe, it, expect } from "vitest";
import { setup } from "./helpers";

const ADMIN_GETS = ["/api/admin/users", "/api/admin/teams", "/api/admin/roles", "/api/admin/settings", "/api/admin/taxonomies", "/api/admin/templates", "/api/admin/integrations", "/api/admin/automations", "/api/admin/audit", "/api/admin/retention", "/api/admin/export/tasks.csv", "/api/admin/overview"];

describe("admin permission gates", () => {
  it("denies every admin endpoint to an employee", async () => {
    const t = await setup();
    const lerato = await t.as("lerato");
    for (const url of ADMIN_GETS) await lerato.get(url).expect(403);
    await lerato.post("/api/admin/users", { name: "X Y", email: "x@y.example", role_key: "employee" }).expect(403);
    await lerato.patch("/api/admin/settings", { "org.name": "Hacked" }).expect(403);
    await lerato.post("/api/admin/import/preview", { entity: "tasks", csv: "title\nA" }).expect(403);
    await lerato.post("/api/admin/purge-demo", { confirm: "DELETE DEMO DATA" }).expect(403);
  });

  it("gates the audit log separately (knowledge manager has knowledge.manage but no admin.audit)", async () => {
    const t = await setup();
    const zanele = await t.as("zanele");
    await zanele.get("/api/admin/audit").expect(403);
    const grace = await t.as("grace");
    const r = await grace.get("/api/admin/audit?action=auth.login").expect(200);
    expect(r.body.items.length).toBeGreaterThan(0);
    expect(r.body.items.every((i: { action: string }) => i.action.startsWith("auth.login"))).toBe(true);
    const csv = await grace.get("/api/admin/audit.csv").expect(200);
    expect(csv.headers["content-type"]).toMatch(/text\/csv/);
  });
});

describe("users", () => {
  it("creates a user with a one-time temporary password that must be changed", async () => {
    const t = await setup();
    const grace = await t.as("grace");
    const r = await grace.post("/api/admin/users", { name: "New Person", email: "New.Person@example.org", role_key: "employee", job_title: "Analyst" }).expect(201);
    const pw = r.body.temporaryPassword as string;
    expect(pw.length).toBeGreaterThanOrEqual(16);
    expect(t.db.get<{ must_change_password: number }>("SELECT must_change_password FROM users WHERE email = 'new.person@example.org'")!.must_change_password).toBe(1);
    await grace.post("/api/admin/users", { name: "Dup", email: "new.person@example.org", role_key: "employee" }).expect(409);
    const bad = await grace.post("/api/admin/users", { name: "A", email: "nope", role_key: "employee" }).expect(400);
    expect(bad.body.details.fields.email).toBeTruthy();
    // sign in with temp password → must change
    const login = await t.anon().post("/auth/login").set("x-csi-request", "1").send({ email: "new.person@example.org", password: pw }).expect(200);
    const cookie = login.headers["set-cookie"];
    const me = await t.anon().get("/api/me").set("Cookie", cookie).expect(200);
    expect(me.body.user.must_change_password).toBe(true);
    expect(t.db.get("SELECT 1 FROM audit_log WHERE action = 'user.create'")).toBeTruthy();
  });

  it("resets passwords and revokes sessions; cannot deactivate self", async () => {
    const t = await setup();
    const grace = await t.as("grace");
    await t.as("lerato");
    const lid = t.userId("lerato");
    expect(t.db.get("SELECT 1 FROM sessions WHERE user_id = ?", lid)).toBeTruthy();
    const r = await grace.post(`/api/admin/users/${lid}/reset-password`).expect(200);
    expect(r.body.temporaryPassword).toBeTruthy();
    expect(t.db.get("SELECT 1 FROM sessions WHERE user_id = ?", lid)).toBeFalsy();
    await grace.post(`/api/admin/users/${t.userId("grace")}/deactivate`).expect(400);
    await grace.post(`/api/admin/users/${lid}/deactivate`).expect(200);
    await t.anon().post("/auth/login").set("x-csi-request", "1").send({ email: "lerato@demo.csi.example", password: r.body.temporaryPassword }).expect(401);
    await grace.post(`/api/admin/users/${lid}/reactivate`).expect(200);
  });

  it("protects the last user able to manage roles", async () => {
    const t = await setup();
    const grace = await t.as("grace");
    // Grace is the only admin. Demoting her (via role change) must fail.
    const r = await grace.patch(`/api/admin/users/${t.userId("grace")}`, { role_key: "employee" }).expect(409);
    expect(r.body.error).toMatch(/no active user/i);
    // Removing admin.roles from the admin role must fail too.
    const roles = (await grace.get("/api/admin/roles").expect(200)).body.roles as { key: string; permissions: string[] }[];
    const adminPerms = roles.find((x) => x.key === "admin")!.permissions.filter((p) => p !== "admin.roles");
    await grace.patch("/api/admin/roles/admin", { permissions: adminPerms }).expect(409);
    // Once another admin exists, demotion works and is audited as permission.change
    await grace.patch(`/api/admin/users/${t.userId("pieter")}`, { role_key: "admin" }).expect(200);
    await grace.patch(`/api/admin/users/${t.userId("grace")}`, { role_key: "employee" }).expect(200);
    expect(t.db.get("SELECT 1 FROM audit_log WHERE action = 'permission.change' AND entity_id = ?", t.userId("grace"))).toBeTruthy();
  });
});

describe("roles", () => {
  it("validates permissions and only deletes unused custom roles", async () => {
    const t = await setup();
    const grace = await t.as("grace");
    await grace.post("/api/admin/roles", { key: "finance", name: "Finance", permissions: ["not.a.permission"] }).expect(400);
    await grace.post("/api/admin/roles", { key: "finance", name: "Finance", permissions: ["meeting.create", "admin.data"] }).expect(201);
    await grace.del("/api/admin/roles/employee").expect(400);
    await grace.patch(`/api/admin/users/${t.userId("pieter")}`, { role_key: "finance" }).expect(200);
    await grace.del("/api/admin/roles/finance").expect(409);
    await grace.patch(`/api/admin/users/${t.userId("pieter")}`, { role_key: "employee" }).expect(200);
    await grace.del("/api/admin/roles/finance").expect(200);
  });
});

describe("settings & templates", () => {
  it("validates timezone and audits changes", async () => {
    const t = await setup();
    const grace = await t.as("grace");
    await grace.patch("/api/admin/settings", { "org.timezone": "Mars/Olympus" }).expect(400);
    const r = await grace.patch("/api/admin/settings", { "org.name": "CSI Test", "ai.enabled": false }).expect(200);
    expect(r.body["org.name"]).toBe("CSI Test");
    expect(t.db.get("SELECT 1 FROM audit_log WHERE action = 'settings.update'")).toBeTruthy();
    const tpl = (await grace.get("/api/admin/templates").expect(200)).body as { id: string; is_default: number }[];
    await grace.del(`/api/admin/templates/${tpl.find((x) => x.is_default)!.id}`).expect(400);
  });

  it("manages taxonomy terms", async () => {
    const t = await setup();
    const grace = await t.as("grace");
    await grace.post("/api/admin/taxonomies/meeting_type", { label: "Board meeting" }).expect(201);
    await grace.post("/api/admin/taxonomies/meeting_type", { label: "Board meeting" }).expect(409);
    await grace.post("/api/admin/taxonomies/bogus", { label: "x" }).expect(404);
  });
});

describe("import / export", () => {
  it("previews CSV with validation and duplicate detection, then commits only valid rows", async () => {
    const t = await setup();
    const grace = await t.as("grace");
    const csv = [
      "Task,Owner Email,Project,Due Date,Priority",
      "Write brief,thabo@demo.csi.example,Unmasking,2026-12-01,high",
      "Bad date,thabo@demo.csi.example,Unmasking,2026-13-45,normal",
      "Unknown person,nobody@example.org,,2026-12-01,low",
      "Write brief,thabo@demo.csi.example,Unmasking,01/12/2026,normal",
      "Secret,thabo@demo.csi.example,Leadership Retreat Planning,,",
    ].join("\n");
    const p = await grace.post("/api/admin/import/preview", { entity: "tasks", csv }).expect(200);
    expect(p.body.suggestedMapping.title).toBe("Task");
    expect(p.body.suggestedMapping.assignee_email).toBe("Owner Email");
    expect(p.body.summary).toMatchObject({ total: 5, valid: 2, invalid: 3, duplicates: 1 });
    const errs = p.body.rows.flatMap((r: { errors: string[] }) => r.errors).join(" ");
    expect(errs).toMatch(/not a valid date/);
    expect(errs).toMatch(/No user with email/);
    expect(errs).toMatch(/not found/); // restricted project invisible to admin
    const before = t.db.get<{ n: number }>("SELECT COUNT(*) n FROM tasks")!.n;
    const c = await grace.post("/api/admin/import/commit", { entity: "tasks", csv, mapping: p.body.mapping, skipInvalid: true }).expect(200);
    expect(c.body).toMatchObject({ created: 1, skippedInvalid: 3, skippedDuplicates: 1 });
    expect(t.db.get<{ n: number }>("SELECT COUNT(*) n FROM tasks")!.n).toBe(before + 1);
    expect(t.db.get("SELECT 1 FROM tasks WHERE title = 'Write brief' AND source = 'import'")).toBeTruthy();
    expect(t.db.get("SELECT 1 FROM audit_log WHERE action = 'data.import'")).toBeTruthy();
    await grace.post("/api/admin/import/commit", { entity: "tasks", csv, skipInvalid: false }).expect(400);
  });

  it("imports projects and flags existing names", async () => {
    const t = await setup();
    const grace = await t.as("grace");
    const csv = "name,owner,status,start date,target date\nNew Initiative,sipho@demo.csi.example,active,2026-01-01,2026-06-01\nD4C,,planning,,\nBackwards,,planning,2026-06-01,2026-01-01";
    const p = await grace.post("/api/admin/import/preview", { entity: "projects", csv }).expect(200);
    expect(p.body.summary).toMatchObject({ total: 3, valid: 2, invalid: 1, duplicates: 1 });
    const c = await grace.post("/api/admin/import/commit", { entity: "projects", csv }).expect(200);
    expect(c.body.created).toBe(1);
    expect(t.db.get("SELECT 1 FROM project_members pm JOIN projects p ON p.id = pm.project_id WHERE p.name = 'New Initiative' AND pm.role = 'owner'")).toBeTruthy();
  });

  it("exports respect visibility — admin does not receive restricted projects, personal tasks or confidential meetings", async () => {
    const t = await setup();
    const grace = await t.as("grace");
    const projects = (await grace.get("/api/admin/export/projects.csv").expect(200)).text;
    expect(projects).toContain("Unmasking");
    expect(projects).not.toContain("Leadership Retreat Planning");
    const tasks = (await grace.get("/api/admin/export/tasks.csv").expect(200)).text;
    expect(tasks).not.toContain("Update my CV");
    expect(tasks).not.toContain("Shortlist retreat venues");
    const meetings = (await grace.get("/api/admin/export/meetings.csv").expect(200)).text;
    expect(meetings).not.toContain("Management meeting");
    expect(t.db.get("SELECT 1 FROM audit_log WHERE action = 'data.export'")).toBeTruthy();
    await grace.get("/api/admin/export/users.csv").expect(404);
  });

  it("purges demo data only with typed confirmation and a non-demo admin", async () => {
    const t = await setup();
    const grace = await t.as("grace");
    await grace.post("/api/admin/purge-demo", { confirm: "yes" }).expect(400);
    await grace.post("/api/admin/purge-demo", { confirm: "DELETE DEMO DATA" }).expect(400); // grace is a demo account
    // create a real admin and use it
    const r = await grace.post("/api/admin/users", { name: "Real Admin", email: "real.admin@example.org", role_key: "admin" }).expect(201);
    t.db.run("UPDATE users SET must_change_password = 0 WHERE email = 'real.admin@example.org'");
    const request = (await import("supertest")).default;
    const agent = request.agent(t.app);
    await agent.post("/auth/login").set("x-csi-request", "1").send({ email: "real.admin@example.org", password: r.body.temporaryPassword }).expect(200);
    const res = await agent.post("/api/admin/purge-demo").set("x-csi-request", "1").send({ confirm: "DELETE DEMO DATA" }).expect(200);
    expect(res.body.deleted.projects).toBeGreaterThan(0);
    expect(t.db.get<{ n: number }>("SELECT COUNT(*) n FROM users WHERE is_demo = 1")!.n).toBe(0);
    expect(t.db.get<{ n: number }>("SELECT COUNT(*) n FROM tasks")!.n).toBe(0);
    expect(t.db.get<{ n: number }>("SELECT COUNT(*) n FROM users")!.n).toBe(1);
    expect(t.db.get("SELECT 1 FROM audit_log WHERE action = 'data.purge_demo'")).toBeTruthy();
  });
});
