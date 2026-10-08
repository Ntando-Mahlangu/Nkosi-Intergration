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
import { createAuthRoutes } from "../src/routes/auth.js";
import { createTenantRoutes } from "../src/routes/tenants.js";
import { hashPassword } from "../src/password.js";
import type { Tenant } from "../src/types.js";
import type { Stores } from "../src/store/index.js";

function buildStores(tenants: Tenant[] = []): Stores {
  return {
    leadStore: new InMemoryLeadStore(),
    tenantStore: new InMemoryTenantStore(tenants),
    messageStore: new InMemoryMessageStore(),
    notificationStore: new InMemoryNotificationStore(),
    auditLogStore: new InMemoryAuditLogStore(),
    salesInquiryStore: new InMemorySalesInquiryStore(),
    tenantUserStore: new InMemoryTenantUserStore(),
  };
}

function buildApp(stores: Stores) {
  const app = express();
  app.use(express.json());
  app.use(createAuthRoutes(stores));
  app.use(createTenantRoutes(stores));
  return app;
}

async function makeTenantWithPassword(password: string): Promise<Tenant> {
  return {
    id: "tenant-1",
    name: "Acme Co",
    apiKey: "test-api-key",
    timezone: "UTC",
    devMode: true,
    channels: {},
    email: "owner@acme.test",
    passwordHash: await hashPassword(password),
    createdAt: new Date().toISOString(),
  };
}

describe("POST /auth/login", () => {
  it("rejects a missing email or password with 400", async () => {
    const app = buildApp(buildStores());
    const res = await request(app).post("/auth/login").send({ email: "x@example.com" });
    expect(res.status).toBe(400);
  });

  it("rejects an unknown email with a generic 401 (never reveals the email doesn't exist)", async () => {
    const app = buildApp(buildStores());
    const res = await request(app).post("/auth/login").send({ email: "nobody@example.com", password: "whatever1" });
    expect(res.status).toBe(401);
    expect(res.body.error).toBe("invalid email or password");
  });

  it("rejects the wrong password with the exact same generic message as an unknown email", async () => {
    const tenant = await makeTenantWithPassword("correct-password-1");
    const app = buildApp(buildStores([tenant]));
    const res = await request(app).post("/auth/login").send({ email: tenant.email, password: "wrong-password" });
    expect(res.status).toBe(401);
    expect(res.body.error).toBe("invalid email or password");
  });

  it("rejects a tenant that has an email but never set a password", async () => {
    const stores = buildStores([
      {
        id: "tenant-2",
        name: "No Password Co",
        apiKey: "key-2",
        timezone: "UTC",
        channels: {},
        email: "nopass@example.com",
        createdAt: new Date().toISOString(),
      },
    ]);
    const app = buildApp(stores);
    const res = await request(app).post("/auth/login").send({ email: "nopass@example.com", password: "anything1" });
    expect(res.status).toBe(401);
  });

  it("logs in with the correct email/password and returns the tenant's real API key", async () => {
    const tenant = await makeTenantWithPassword("correct-password-1");
    const app = buildApp(buildStores([tenant]));
    const res = await request(app).post("/auth/login").send({ email: tenant.email, password: "correct-password-1" });
    expect(res.status).toBe(200);
    expect(res.body.apiKey).toBe(tenant.apiKey);
    expect(res.body.tenant.name).toBe("Acme Co");
    // Never leaks the hash back out.
    expect(res.body.tenant.passwordHash).toBeUndefined();
  });

  it("is case-insensitive on email", async () => {
    const tenant = await makeTenantWithPassword("correct-password-1");
    const app = buildApp(buildStores([tenant]));
    const res = await request(app)
      .post("/auth/login")
      .send({ email: "OWNER@ACME.TEST", password: "correct-password-1" });
    expect(res.status).toBe(200);
  });

  it("blocks a suspended tenant even with the correct password", async () => {
    const tenant = await makeTenantWithPassword("correct-password-1");
    tenant.status = "suspended";
    const app = buildApp(buildStores([tenant]));
    const res = await request(app).post("/auth/login").send({ email: tenant.email, password: "correct-password-1" });
    expect(res.status).toBe(403);
  });
});

describe("POST /auth/forgot-password + POST /auth/reset-password", () => {
  it("forgot-password always returns the same generic success response, known email or not", async () => {
    const tenant = await makeTenantWithPassword("old-password-1");
    const app = buildApp(buildStores([tenant]));

    const known = await request(app).post("/auth/forgot-password").send({ email: tenant.email });
    const unknown = await request(app).post("/auth/forgot-password").send({ email: "nobody@example.com" });
    expect(known.status).toBe(200);
    expect(unknown.status).toBe(200);
    expect(known.body).toEqual(unknown.body);
  });

  it("forgot-password for a known email issues a token (stored only as a hash) and rejects an unrelated made-up token", async () => {
    const tenant = await makeTenantWithPassword("old-password-1");
    const stores = buildStores([tenant]);
    const app = buildApp(stores);

    await request(app).post("/auth/forgot-password").send({ email: tenant.email });
    const stored = await stores.tenantStore.getTenant(tenant.id);
    expect(stored?.passwordResetTokenHash).toBeTruthy();

    // The raw token is only ever delivered by email (src/authEmail.ts), so
    // an API caller who doesn't have it — trying a guess — must be
    // rejected. (The actual valid-token path is exercised in the tests
    // below via issuePasswordResetToken directly.)
    const badReset = await request(app)
      .post("/auth/reset-password")
      .send({ token: "not-the-real-token", newPassword: "new-password-1" });
    expect(badReset.status).toBe(400);
  });

  it("reset-password rejects a newPassword shorter than the minimum", async () => {
    const tenant = await makeTenantWithPassword("old-password-1");
    const app = buildApp(buildStores([tenant]));
    const res = await request(app).post("/auth/reset-password").send({ token: "whatever", newPassword: "short" });
    expect(res.status).toBe(400);
  });

  it("reset-password rejects an expired token", async () => {
    const tenant = await makeTenantWithPassword("old-password-1");
    const stores = buildStores([tenant]);
    const app = buildApp(stores);

    // Issue a real token through the real path, then manually expire it —
    // proves expiry is actually enforced, not just token-hash matching.
    const { issuePasswordResetToken } = await import("../src/routes/auth.js");
    const token = await issuePasswordResetToken(stores.tenantStore, tenant.id);
    await stores.tenantStore.updateTenant(tenant.id, {
      passwordResetExpiresAt: new Date(Date.now() - 1000).toISOString(),
    });

    const res = await request(app).post("/auth/reset-password").send({ token, newPassword: "new-password-1" });
    expect(res.status).toBe(400);
  });

  it("a valid, unexpired token sets the new password and the old password stops working", async () => {
    const tenant = await makeTenantWithPassword("old-password-1");
    const stores = buildStores([tenant]);
    const app = buildApp(stores);

    const { issuePasswordResetToken } = await import("../src/routes/auth.js");
    const token = await issuePasswordResetToken(stores.tenantStore, tenant.id);

    const reset = await request(app).post("/auth/reset-password").send({ token, newPassword: "brand-new-password-1" });
    expect(reset.status).toBe(200);
    expect(reset.body.apiKey).toBe(tenant.apiKey);

    const oldLogin = await request(app).post("/auth/login").send({ email: tenant.email, password: "old-password-1" });
    expect(oldLogin.status).toBe(401);

    const newLogin = await request(app)
      .post("/auth/login")
      .send({ email: tenant.email, password: "brand-new-password-1" });
    expect(newLogin.status).toBe(200);
  });

  it("a used token can't be replayed to reset the password again", async () => {
    const tenant = await makeTenantWithPassword("old-password-1");
    const stores = buildStores([tenant]);
    const app = buildApp(stores);

    const { issuePasswordResetToken } = await import("../src/routes/auth.js");
    const token = await issuePasswordResetToken(stores.tenantStore, tenant.id);
    await request(app).post("/auth/reset-password").send({ token, newPassword: "first-new-password-1" });

    const replay = await request(app)
      .post("/auth/reset-password")
      .send({ token, newPassword: "second-new-password-1" });
    expect(replay.status).toBe(400);
  });
});

describe("POST /tenants/me/change-password", () => {
  it("requires the correct current password when one is already set", async () => {
    const tenant = await makeTenantWithPassword("old-password-1");
    const app = buildApp(buildStores([tenant]));
    const res = await request(app)
      .post("/tenants/me/change-password")
      .set("Authorization", `Bearer ${tenant.apiKey}`)
      .send({ currentPassword: "wrong", newPassword: "new-password-1" });
    expect(res.status).toBe(401);
  });

  it("changes the password with the correct current password", async () => {
    const tenant = await makeTenantWithPassword("old-password-1");
    const app = buildApp(buildStores([tenant]));
    const res = await request(app)
      .post("/tenants/me/change-password")
      .set("Authorization", `Bearer ${tenant.apiKey}`)
      .send({ currentPassword: "old-password-1", newPassword: "new-password-1" });
    expect(res.status).toBe(200);

    const login = await request(app).post("/auth/login").send({ email: tenant.email, password: "new-password-1" });
    expect(login.status).toBe(200);
  });

  it("sets an initial password with no currentPassword when the tenant never had one", async () => {
    const stores = buildStores([
      {
        id: "tenant-3",
        name: "First Timer Co",
        apiKey: "key-3",
        timezone: "UTC",
        channels: {},
        email: "first@example.com",
        createdAt: new Date().toISOString(),
      },
    ]);
    const app = buildApp(stores);
    const res = await request(app)
      .post("/tenants/me/change-password")
      .set("Authorization", "Bearer key-3")
      .send({ newPassword: "first-password-1" });
    expect(res.status).toBe(200);

    const login = await request(app)
      .post("/auth/login")
      .send({ email: "first@example.com", password: "first-password-1" });
    expect(login.status).toBe(200);
  });
});
