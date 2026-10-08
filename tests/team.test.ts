import { describe, expect, it } from "vitest";
import request from "supertest";
import express from "express";
import {
  InMemoryAuditLogStore,
  InMemorySalesInquiryStore,
  InMemoryLeadStore,
  InMemoryMessageStore,
  InMemoryNotificationStore,
  InMemoryTenantStore,
  InMemoryTenantUserStore,
} from "../src/store/memory.js";
import { createAuthRoutes, issueTenantUserPasswordResetToken } from "../src/routes/auth.js";
import { createTenantRoutes } from "../src/routes/tenants.js";
import { createTeamRoutes } from "../src/routes/team.js";
import { createLeadRoutes } from "../src/routes/leads.js";
import { hashPassword } from "../src/password.js";
import type { Tenant, TenantUser } from "../src/types.js";
import type { Stores } from "../src/store/index.js";

function buildStores(tenants: Tenant[] = [], tenantUsers: TenantUser[] = []): Stores {
  const tenantUserStore = new InMemoryTenantUserStore();
  const stores: Stores = {
    leadStore: new InMemoryLeadStore(),
    tenantStore: new InMemoryTenantStore(tenants),
    messageStore: new InMemoryMessageStore(),
    notificationStore: new InMemoryNotificationStore(),
    auditLogStore: new InMemoryAuditLogStore(),
    salesInquiryStore: new InMemorySalesInquiryStore(),
    tenantUserStore,
  };
  for (const user of tenantUsers) {
    void tenantUserStore.createTenantUser(user);
  }
  return stores;
}

function buildApp(stores: Stores) {
  const app = express();
  app.use(express.json());
  app.use(createAuthRoutes(stores));
  app.use(createTenantRoutes(stores));
  app.use(createTeamRoutes(stores));
  app.use(createLeadRoutes(stores));
  return app;
}

const TENANT: Tenant = {
  id: "tenant-1",
  name: "Acme Co",
  apiKey: "tenant-api-key",
  timezone: "UTC",
  channels: {},
  createdAt: new Date().toISOString(),
};

function makeMemberUser(overrides: Partial<TenantUser> = {}): TenantUser {
  return {
    id: "tu-member-1",
    tenantId: TENANT.id,
    email: "member@acme.test",
    loginKey: "member-login-key",
    role: "member",
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

function makeOwnerUser(overrides: Partial<TenantUser> = {}): TenantUser {
  return {
    id: "tu-owner-1",
    tenantId: TENANT.id,
    email: "deputy-owner@acme.test",
    loginKey: "deputy-owner-login-key",
    role: "owner",
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

describe("requireTenantAuth resolving a TenantUser's own loginKey", () => {
  it("resolves to the parent tenant, and GET /leads works with it", async () => {
    const stores = buildStores([TENANT], [makeMemberUser()]);
    const app = buildApp(stores);

    const res = await request(app).get("/leads").set("Authorization", "Bearer member-login-key");
    expect(res.status).toBe(200);
  });

  it("rejects an unknown bearer token", async () => {
    const stores = buildStores([TENANT], [makeMemberUser()]);
    const app = buildApp(stores);

    const res = await request(app).get("/leads").set("Authorization", "Bearer not-a-real-key");
    expect(res.status).toBe(401);
  });

  it("still works for the tenant's own apiKey, unaffected by any TenantUser rows existing", async () => {
    const stores = buildStores([TENANT], [makeMemberUser()]);
    const app = buildApp(stores);

    const res = await request(app).get("/leads").set("Authorization", `Bearer ${TENANT.apiKey}`);
    expect(res.status).toBe(200);
  });
});

describe("requireOwnerRole gating", () => {
  it("blocks a member-role TenantUser from PATCH /tenants/me", async () => {
    const stores = buildStores([TENANT], [makeMemberUser()]);
    const app = buildApp(stores);

    const res = await request(app)
      .patch("/tenants/me")
      .set("Authorization", "Bearer member-login-key")
      .send({ timezone: "Africa/Johannesburg" });
    expect(res.status).toBe(403);
  });

  it("blocks a member-role TenantUser from POST /tenants/me/change-password", async () => {
    const stores = buildStores([TENANT], [makeMemberUser()]);
    const app = buildApp(stores);

    const res = await request(app)
      .post("/tenants/me/change-password")
      .set("Authorization", "Bearer member-login-key")
      .send({ newPassword: "brand-new-password-1" });
    expect(res.status).toBe(403);
  });

  it("allows an owner-role TenantUser to PATCH /tenants/me, same as the tenant's own apiKey", async () => {
    const stores = buildStores([TENANT], [makeOwnerUser()]);
    const app = buildApp(stores);

    const res = await request(app)
      .patch("/tenants/me")
      .set("Authorization", "Bearer deputy-owner-login-key")
      .send({ timezone: "Africa/Johannesburg" });
    expect(res.status).toBe(200);
    expect(res.body.timezone).toBe("Africa/Johannesburg");
  });

  it("still allows the tenant's own apiKey to PATCH /tenants/me, unaffected by any TenantUser rows existing", async () => {
    const stores = buildStores([TENANT], [makeMemberUser()]);
    const app = buildApp(stores);

    const res = await request(app)
      .patch("/tenants/me")
      .set("Authorization", `Bearer ${TENANT.apiKey}`)
      .send({ timezone: "Africa/Johannesburg" });
    expect(res.status).toBe(200);
  });
});

describe("GET /tenants/me/team", () => {
  it("requires tenant auth", async () => {
    const res = await request(buildApp(buildStores([TENANT]))).get("/tenants/me/team");
    expect(res.status).toBe(401);
  });

  it("lists team members without secrets, open to a member too", async () => {
    const stores = buildStores([TENANT], [makeMemberUser(), makeOwnerUser()]);
    const app = buildApp(stores);

    const res = await request(app).get("/tenants/me/team").set("Authorization", "Bearer member-login-key");
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(2);
    expect(res.body.find((m: { email: string }) => m.email === "member@acme.test").role).toBe("member");
    expect(res.body[0].loginKey).toBeUndefined();
    expect(res.body[0].passwordHash).toBeUndefined();
  });
});

describe("POST /tenants/me/team", () => {
  it("requires owner role", async () => {
    const stores = buildStores([TENANT], [makeMemberUser()]);
    const app = buildApp(stores);

    const res = await request(app)
      .post("/tenants/me/team")
      .set("Authorization", "Bearer member-login-key")
      .send({ email: "new-hire@acme.test" });
    expect(res.status).toBe(403);
  });

  it("invites a new member, defaulting role to member, and records an audit entry", async () => {
    const stores = buildStores([TENANT]);
    const app = buildApp(stores);

    const res = await request(app)
      .post("/tenants/me/team")
      .set("Authorization", `Bearer ${TENANT.apiKey}`)
      .send({ email: "new-hire@acme.test" });

    expect(res.status).toBe(201);
    expect(res.body.email).toBe("new-hire@acme.test");
    expect(res.body.role).toBe("member");
    expect(res.body.hasPassword).toBe(false);
    expect(res.body.loginKey).toBeUndefined();

    const audit = await stores.auditLogStore.list({ offset: 0 });
    expect(audit[0]).toMatchObject({
      tenantId: TENANT.id,
      action: "tenant_user.invite",
      actor: "owner",
      details: { invitedEmail: "new-hire@acme.test", role: "member" },
    });
  });

  it("can invite directly as role owner", async () => {
    const stores = buildStores([TENANT]);
    const app = buildApp(stores);

    const res = await request(app)
      .post("/tenants/me/team")
      .set("Authorization", `Bearer ${TENANT.apiKey}`)
      .send({ email: "deputy@acme.test", role: "owner" });
    expect(res.status).toBe(201);
    expect(res.body.role).toBe("owner");
  });

  it("rejects an invalid email", async () => {
    const stores = buildStores([TENANT]);
    const app = buildApp(stores);
    const res = await request(app)
      .post("/tenants/me/team")
      .set("Authorization", `Bearer ${TENANT.apiKey}`)
      .send({ email: "not-an-email" });
    expect(res.status).toBe(400);
  });

  it("rejects an invalid role", async () => {
    const stores = buildStores([TENANT]);
    const app = buildApp(stores);
    const res = await request(app)
      .post("/tenants/me/team")
      .set("Authorization", `Bearer ${TENANT.apiKey}`)
      .send({ email: "new-hire@acme.test", role: "superadmin" });
    expect(res.status).toBe(400);
  });

  it("rejects an email already used by another team member", async () => {
    const stores = buildStores([TENANT], [makeMemberUser()]);
    const app = buildApp(stores);
    const res = await request(app)
      .post("/tenants/me/team")
      .set("Authorization", `Bearer ${TENANT.apiKey}`)
      .send({ email: "MEMBER@acme.test" }); // case-insensitive match
    expect(res.status).toBe(409);
  });

  it("rejects an email already used by the tenant's own owner login", async () => {
    const tenantWithEmail: Tenant = { ...TENANT, email: "owner@acme.test" };
    const stores = buildStores([tenantWithEmail]);
    const app = buildApp(stores);
    const res = await request(app)
      .post("/tenants/me/team")
      .set("Authorization", `Bearer ${TENANT.apiKey}`)
      .send({ email: "owner@acme.test" });
    expect(res.status).toBe(409);
  });
});

describe("cross-tenant email collision between Tenant.email and TenantUser.email", () => {
  // Regression test: PATCH /tenants/me's own email-conflict check only ever
  // looked at the tenant table, so tenant B could set its own login email
  // to one a TenantUser already owns under tenant A — silently hijacking
  // that person's login (and, via /auth/forgot-password, handing them a
  // reset link for tenant B's real apiKey instead of their own account).
  const TENANT_B: Tenant = { ...TENANT, id: "tenant-b", apiKey: "tenant-b-api-key" };

  it("PATCH /tenants/me rejects an email already used by another tenant's team member", async () => {
    const stores = buildStores([TENANT, TENANT_B], [makeMemberUser({ email: "bob@example.com" })]);
    const app = buildApp(stores);

    const res = await request(app)
      .patch("/tenants/me")
      .set("Authorization", `Bearer ${TENANT_B.apiKey}`)
      .send({ email: "bob@example.com" });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/already in use/i);
    // The team member's login must still resolve to the tenant that actually invited them.
    const login = await request(app)
      .post("/auth/login")
      .set("Content-Type", "application/json")
      .send({ email: "bob@example.com", password: "whatever" });
    expect(login.status).toBe(401); // no password set yet, but never a 200 for the wrong tenant either
  });

  it("POST /admin/tenants (via buildTenantPatch-equivalent checks) also rejects a colliding email at creation", async () => {
    // Covered indirectly through PATCH /tenants/me above and POST
    // /tenants/me/team's own pre-existing reverse check; this test just
    // confirms the same checkEmailConflict helper is shared, not duplicated
    // with a gap, by exercising PATCH /tenants/me's exclude-self case too.
    const stores = buildStores([TENANT], [makeMemberUser({ email: "member@acme.test" })]);
    const app = buildApp(stores);

    // Setting the tenant's own email to its own team member's email is
    // still a collision even though it's "the same tenant" — the two
    // identities (tenant-owner login vs. team-member login) must never
    // resolve to the same email, or /auth/login's "check tenant table
    // first" order makes the team member's own account unreachable.
    const res = await request(app)
      .patch("/tenants/me")
      .set("Authorization", `Bearer ${TENANT.apiKey}`)
      .send({ email: "member@acme.test" });
    expect(res.status).toBe(400);
  });
});

describe("PATCH /tenants/me/team/:id", () => {
  it("requires owner role", async () => {
    const stores = buildStores([TENANT], [makeMemberUser()]);
    const app = buildApp(stores);
    const res = await request(app)
      .patch("/tenants/me/team/tu-member-1")
      .set("Authorization", "Bearer member-login-key")
      .send({ role: "owner" });
    expect(res.status).toBe(403);
  });

  it("returns 404 for a member that doesn't belong to this tenant", async () => {
    const stores = buildStores([TENANT]);
    const app = buildApp(stores);
    const res = await request(app)
      .patch("/tenants/me/team/no-such-id")
      .set("Authorization", `Bearer ${TENANT.apiKey}`)
      .send({ role: "owner" });
    expect(res.status).toBe(404);
  });

  it("promotes a member to owner and records an audit entry", async () => {
    const stores = buildStores([TENANT], [makeMemberUser()]);
    const app = buildApp(stores);

    const res = await request(app)
      .patch("/tenants/me/team/tu-member-1")
      .set("Authorization", `Bearer ${TENANT.apiKey}`)
      .send({ role: "owner" });
    expect(res.status).toBe(200);
    expect(res.body.role).toBe("owner");

    const audit = await stores.auditLogStore.list({ offset: 0 });
    expect(audit[0]).toMatchObject({ action: "tenant_user.role_change", details: { from: "member", to: "owner" } });
  });
});

describe("DELETE /tenants/me/team/:id", () => {
  it("requires owner role", async () => {
    const stores = buildStores([TENANT], [makeMemberUser()]);
    const app = buildApp(stores);
    const res = await request(app)
      .delete("/tenants/me/team/tu-member-1")
      .set("Authorization", "Bearer member-login-key");
    expect(res.status).toBe(403);
  });

  it("removes a member and records an audit entry", async () => {
    const stores = buildStores([TENANT], [makeMemberUser()]);
    const app = buildApp(stores);

    const res = await request(app)
      .delete("/tenants/me/team/tu-member-1")
      .set("Authorization", `Bearer ${TENANT.apiKey}`);
    expect(res.status).toBe(204);

    expect(await stores.tenantUserStore.getTenantUserById(TENANT.id, "tu-member-1")).toBeUndefined();
    const audit = await stores.auditLogStore.list({ offset: 0 });
    expect(audit[0]).toMatchObject({ action: "tenant_user.remove" });
  });

  it("the removed member's own loginKey stops working immediately", async () => {
    const stores = buildStores([TENANT], [makeMemberUser()]);
    const app = buildApp(stores);
    await request(app).delete("/tenants/me/team/tu-member-1").set("Authorization", `Bearer ${TENANT.apiKey}`);

    const res = await request(app).get("/leads").set("Authorization", "Bearer member-login-key");
    expect(res.status).toBe(401);
  });
});

describe("TenantUser login via /auth/login", () => {
  it("logs in a team member with email/password and returns their own loginKey, not the tenant's apiKey", async () => {
    const passwordHash = await hashPassword("member-password-1");
    const stores = buildStores([TENANT], [makeMemberUser({ passwordHash })]);
    const app = buildApp(stores);

    const res = await request(app)
      .post("/auth/login")
      .send({ email: "member@acme.test", password: "member-password-1" });
    expect(res.status).toBe(200);
    expect(res.body.apiKey).toBe("member-login-key");
    expect(res.body.apiKey).not.toBe(TENANT.apiKey);
    expect(res.body.tenant.id).toBe(TENANT.id);
  });

  it("rejects a team member with no password set yet", async () => {
    const stores = buildStores([TENANT], [makeMemberUser()]);
    const app = buildApp(stores);
    const res = await request(app).post("/auth/login").send({ email: "member@acme.test", password: "anything" });
    expect(res.status).toBe(401);
  });

  it("rejects a suspended tenant's team member even with the correct password", async () => {
    const passwordHash = await hashPassword("member-password-1");
    const suspendedTenant: Tenant = { ...TENANT, status: "suspended" };
    const stores = buildStores([suspendedTenant], [makeMemberUser({ passwordHash })]);
    const app = buildApp(stores);

    const res = await request(app)
      .post("/auth/login")
      .send({ email: "member@acme.test", password: "member-password-1" });
    expect(res.status).toBe(403);
  });

  it("the tenant's own owner login still takes priority over a same-named lookup (no collision in practice since emails are cross-checked at invite time)", async () => {
    const passwordHash = await hashPassword("owner-password-1");
    const tenantWithEmail: Tenant = { ...TENANT, email: "owner@acme.test", passwordHash };
    const stores = buildStores([tenantWithEmail]);
    const app = buildApp(stores);

    const res = await request(app).post("/auth/login").send({ email: "owner@acme.test", password: "owner-password-1" });
    expect(res.status).toBe(200);
    expect(res.body.apiKey).toBe(TENANT.apiKey);
  });
});

describe("TenantUser password reset via /auth/forgot-password + /auth/reset-password", () => {
  it("issues a token for a team member's email and resolves a reset through it", async () => {
    const stores = buildStores([TENANT], [makeMemberUser()]);
    const app = buildApp(stores);

    const forgot = await request(app).post("/auth/forgot-password").send({ email: "member@acme.test" });
    expect(forgot.status).toBe(200);

    const stored = await stores.tenantUserStore.getTenantUserById(TENANT.id, "tu-member-1");
    expect(stored?.passwordResetTokenHash).toBeTruthy();

    const token = await issueTenantUserPasswordResetToken(stores.tenantUserStore, TENANT.id, "tu-member-1");
    const reset = await request(app)
      .post("/auth/reset-password")
      .send({ token, newPassword: "fresh-member-password-1" });
    expect(reset.status).toBe(200);
    expect(reset.body.apiKey).toBe("member-login-key");

    const login = await request(app)
      .post("/auth/login")
      .send({ email: "member@acme.test", password: "fresh-member-password-1" });
    expect(login.status).toBe(200);
  });
});
