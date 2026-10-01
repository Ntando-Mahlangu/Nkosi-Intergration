import { beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import express from "express";
import {
  InMemoryAuditLogStore,
  InMemoryLeadStore,
  InMemoryMessageStore,
  InMemoryNotificationStore,
  InMemoryTenantStore,
} from "../src/store/memory.js";
import type { Tenant } from "../src/types.js";
import type { Stores } from "../src/store/index.js";

const sendAccountSmsMock = vi.fn();
vi.mock("../src/authSms.js", () => ({
  sendAccountSms: (...args: unknown[]) => sendAccountSmsMock(...args),
}));

const { createAuthRoutes } = await import("../src/routes/auth.js");

function buildStores(tenants: Tenant[] = []): Stores {
  return {
    leadStore: new InMemoryLeadStore(),
    tenantStore: new InMemoryTenantStore(tenants),
    messageStore: new InMemoryMessageStore(),
    notificationStore: new InMemoryNotificationStore(),
    auditLogStore: new InMemoryAuditLogStore(),
  };
}

function buildApp(stores: Stores) {
  const app = express();
  app.use(express.json());
  app.use(createAuthRoutes(stores));
  return app;
}

function makeTenantWithPhone(overrides: Partial<Tenant> = {}): Tenant {
  return {
    id: "tenant-1",
    name: "Acme Plumbing",
    apiKey: "test-api-key",
    timezone: "UTC",
    channels: {},
    loginPhone: "+15551234567",
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

/** Pulls the 6-digit code out of the SMS body sendAccountSms was called with — the code is never returned over the API itself. */
function extractCode(): string {
  const body = sendAccountSmsMock.mock.calls.at(-1)?.[1] as string;
  const match = body.match(/code is (\d{6})/);
  if (!match) throw new Error(`no code found in SMS body: ${body}`);
  return match[1];
}

describe("POST /auth/request-code + POST /auth/verify-code", () => {
  beforeEach(() => {
    sendAccountSmsMock.mockReset();
  });

  it("rejects a missing phone with 400", async () => {
    const app = buildApp(buildStores());
    const res = await request(app).post("/auth/request-code").send({});
    expect(res.status).toBe(400);
  });

  it("always returns the same generic response, known phone or not, and texts a code only for a known one", async () => {
    const tenant = makeTenantWithPhone();
    const app = buildApp(buildStores([tenant]));

    const known = await request(app).post("/auth/request-code").send({ phone: tenant.loginPhone });
    const unknown = await request(app).post("/auth/request-code").send({ phone: "+15559999999" });
    expect(known.status).toBe(200);
    expect(unknown.status).toBe(200);
    expect(known.body).toEqual(unknown.body);
    expect(sendAccountSmsMock).toHaveBeenCalledTimes(1);
    expect(sendAccountSmsMock).toHaveBeenCalledWith(tenant.loginPhone, expect.stringContaining("sign-in code"));
  });

  it("verifies the correct code and returns the tenant's real API key", async () => {
    const tenant = makeTenantWithPhone();
    const stores = buildStores([tenant]);
    const app = buildApp(stores);

    await request(app).post("/auth/request-code").send({ phone: tenant.loginPhone });
    const code = extractCode();

    const res = await request(app).post("/auth/verify-code").send({ phone: tenant.loginPhone, code });
    expect(res.status).toBe(200);
    expect(res.body.apiKey).toBe(tenant.apiKey);
    expect(res.body.tenant.name).toBe("Acme Plumbing");
  });

  it("rejects an unknown phone with a generic 401", async () => {
    const app = buildApp(buildStores());
    const res = await request(app).post("/auth/verify-code").send({ phone: "+15559999999", code: "123456" });
    expect(res.status).toBe(401);
    expect(res.body.error).toBe("invalid or expired code");
  });

  it("rejects the wrong code with the exact same generic message", async () => {
    const tenant = makeTenantWithPhone();
    const app = buildApp(buildStores([tenant]));
    await request(app).post("/auth/request-code").send({ phone: tenant.loginPhone });

    const res = await request(app).post("/auth/verify-code").send({ phone: tenant.loginPhone, code: "000000" });
    expect(res.status).toBe(401);
    expect(res.body.error).toBe("invalid or expired code");
  });

  it("rejects an expired code", async () => {
    const tenant = makeTenantWithPhone();
    const stores = buildStores([tenant]);
    const app = buildApp(stores);

    await request(app).post("/auth/request-code").send({ phone: tenant.loginPhone });
    const code = extractCode();
    await stores.tenantStore.updateTenant(tenant.id, { otpExpiresAt: new Date(Date.now() - 1000).toISOString() });

    const res = await request(app).post("/auth/verify-code").send({ phone: tenant.loginPhone, code });
    expect(res.status).toBe(401);
  });

  it("a verified code can't be replayed", async () => {
    const tenant = makeTenantWithPhone();
    const app = buildApp(buildStores([tenant]));
    await request(app).post("/auth/request-code").send({ phone: tenant.loginPhone });
    const code = extractCode();

    const first = await request(app).post("/auth/verify-code").send({ phone: tenant.loginPhone, code });
    expect(first.status).toBe(200);

    const replay = await request(app).post("/auth/verify-code").send({ phone: tenant.loginPhone, code });
    expect(replay.status).toBe(401);
  });

  it("locks out after too many wrong attempts, even with the correct code", async () => {
    const tenant = makeTenantWithPhone();
    const app = buildApp(buildStores([tenant]));
    await request(app).post("/auth/request-code").send({ phone: tenant.loginPhone });
    const code = extractCode();

    for (let i = 0; i < 5; i++) {
      const res = await request(app).post("/auth/verify-code").send({ phone: tenant.loginPhone, code: "000000" });
      expect(res.status).toBe(401);
    }

    const res = await request(app).post("/auth/verify-code").send({ phone: tenant.loginPhone, code });
    expect(res.status).toBe(401);
  });

  it("requesting a fresh code resets the attempt lockout", async () => {
    const tenant = makeTenantWithPhone();
    const app = buildApp(buildStores([tenant]));
    await request(app).post("/auth/request-code").send({ phone: tenant.loginPhone });

    for (let i = 0; i < 5; i++) {
      await request(app).post("/auth/verify-code").send({ phone: tenant.loginPhone, code: "000000" });
    }

    await request(app).post("/auth/request-code").send({ phone: tenant.loginPhone });
    const freshCode = extractCode();
    const res = await request(app).post("/auth/verify-code").send({ phone: tenant.loginPhone, code: freshCode });
    expect(res.status).toBe(200);
  });

  it("blocks a suspended tenant even with the correct code", async () => {
    const tenant = makeTenantWithPhone({ status: "suspended" });
    const app = buildApp(buildStores([tenant]));
    await request(app).post("/auth/request-code").send({ phone: tenant.loginPhone });
    const code = extractCode();

    const res = await request(app).post("/auth/verify-code").send({ phone: tenant.loginPhone, code });
    expect(res.status).toBe(403);
  });

  it("still consumes the code on a suspended tenant's correct attempt — it can't be replayed once unsuspended", async () => {
    const tenant = makeTenantWithPhone({ status: "suspended" });
    const stores = buildStores([tenant]);
    const app = buildApp(stores);
    await request(app).post("/auth/request-code").send({ phone: tenant.loginPhone });
    const code = extractCode();

    const blocked = await request(app).post("/auth/verify-code").send({ phone: tenant.loginPhone, code });
    expect(blocked.status).toBe(403);

    await stores.tenantStore.updateTenant(tenant.id, { status: "active" });
    const replay = await request(app).post("/auth/verify-code").send({ phone: tenant.loginPhone, code });
    expect(replay.status).toBe(401);
  });
});
