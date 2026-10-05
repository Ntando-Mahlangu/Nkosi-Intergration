import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import express from "express";

const addressCreateMock = vi.fn();
const orderCreateMock = vi.fn();
const orderFetchMock = vi.fn();
const orderContextMock = vi.fn(() => ({ fetch: orderFetchMock }));
const twilioFactoryMock = vi.fn(() => ({
  addresses: { create: addressCreateMock },
  numbers: { v2: { hostedNumberOrders: Object.assign(orderContextMock, { create: orderCreateMock }) } },
}));

vi.mock("twilio", () => ({ default: twilioFactoryMock }));

const {
  InMemoryAuditLogStore,
  InMemoryLeadStore,
  InMemoryMessageStore,
  InMemoryNotificationStore,
  InMemoryTenantStore,
  InMemoryTenantUserStore,
} = await import("../src/store/memory.js");
const { createTenantRoutes } = await import("../src/routes/tenants.js");
type TenantType = import("../src/types.js").Tenant;
type Stores = import("../src/store/index.js").Stores;

const TENANT: TenantType = {
  id: "tenant-1",
  name: "Acme Plumbing",
  apiKey: "test-api-key",
  timezone: "UTC",
  channels: {},
  createdAt: new Date().toISOString(),
};

const ADDRESS = {
  customerName: "Acme Plumbing",
  street: "1 Main St",
  city: "Springfield",
  region: "IL",
  postalCode: "62704",
  isoCountry: "US",
};

function buildStores(tenant: TenantType = TENANT): Stores {
  return {
    leadStore: new InMemoryLeadStore([]),
    tenantStore: new InMemoryTenantStore([tenant]),
    messageStore: new InMemoryMessageStore(),
    notificationStore: new InMemoryNotificationStore(),
    auditLogStore: new InMemoryAuditLogStore(),
    tenantUserStore: new InMemoryTenantUserStore(),
  };
}

function buildApp(stores: Stores) {
  const app = express();
  app.use(express.json());
  app.use(createTenantRoutes(stores));
  return app;
}

describe("connect a client's existing number", () => {
  const originalEnv = {
    adminKey: process.env.ADMIN_API_KEY,
    sid: process.env.DEFAULT_TWILIO_ACCOUNT_SID,
    token: process.env.DEFAULT_TWILIO_AUTH_TOKEN,
  };

  beforeEach(() => {
    process.env.ADMIN_API_KEY = "admin-secret";
    process.env.DEFAULT_TWILIO_ACCOUNT_SID = "AC_shared";
    process.env.DEFAULT_TWILIO_AUTH_TOKEN = "shared-token";
    addressCreateMock.mockReset();
    orderCreateMock.mockReset();
    orderFetchMock.mockReset();
    orderContextMock.mockClear();
    twilioFactoryMock.mockClear();
  });

  afterEach(() => {
    for (const [key, value] of Object.entries({
      ADMIN_API_KEY: originalEnv.adminKey,
      DEFAULT_TWILIO_ACCOUNT_SID: originalEnv.sid,
      DEFAULT_TWILIO_AUTH_TOKEN: originalEnv.token,
    })) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  describe("POST /admin/tenants/:id/connect-number", () => {
    it("starts a hosted number order and stores it on the tenant", async () => {
      addressCreateMock.mockResolvedValueOnce({ sid: "AD123" });
      orderCreateMock.mockResolvedValueOnce({
        sid: "HU123",
        phoneNumber: "+15551234567",
        status: "received",
        nextStep: "Wait for a verification call.",
        failureReason: null,
      });

      const stores = buildStores();
      const app = buildApp(stores);
      const res = await request(app)
        .post(`/admin/tenants/${TENANT.id}/connect-number`)
        .set("Authorization", "Bearer admin-secret")
        .send({ phoneNumber: "+15551234567", contactEmail: "owner@acme.com", address: ADDRESS });

      expect(res.status).toBe(201);
      expect(res.body.numberHostingOrder).toMatchObject({
        orderSid: "HU123",
        phoneNumber: "+15551234567",
        status: "received",
      });

      const auditEntries = await stores.auditLogStore.list({ offset: 0 });
      expect(auditEntries).toHaveLength(1);
      expect(auditEntries[0].action).toBe("tenant.connect_number");
    });

    it("rejects a phone number that isn't E.164", async () => {
      const app = buildApp(buildStores());
      const res = await request(app)
        .post(`/admin/tenants/${TENANT.id}/connect-number`)
        .set("Authorization", "Bearer admin-secret")
        .send({ phoneNumber: "555-1234", contactEmail: "owner@acme.com", address: ADDRESS });

      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/E\.164/);
      expect(addressCreateMock).not.toHaveBeenCalled();
    });

    it("rejects a request missing the business address", async () => {
      const app = buildApp(buildStores());
      const res = await request(app)
        .post(`/admin/tenants/${TENANT.id}/connect-number`)
        .set("Authorization", "Bearer admin-secret")
        .send({ phoneNumber: "+15551234567", contactEmail: "owner@acme.com" });

      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/address\./);
    });

    it("404s for an unknown tenant", async () => {
      const app = buildApp(buildStores());
      const res = await request(app)
        .post("/admin/tenants/no-such-tenant/connect-number")
        .set("Authorization", "Bearer admin-secret")
        .send({ phoneNumber: "+15551234567", contactEmail: "owner@acme.com", address: ADDRESS });

      expect(res.status).toBe(404);
    });

    it("surfaces a Twilio-side failure as a 502 instead of silently losing it", async () => {
      addressCreateMock.mockRejectedValueOnce(new Error("Twilio: invalid address"));

      const app = buildApp(buildStores());
      const res = await request(app)
        .post(`/admin/tenants/${TENANT.id}/connect-number`)
        .set("Authorization", "Bearer admin-secret")
        .send({ phoneNumber: "+15551234567", contactEmail: "owner@acme.com", address: ADDRESS });

      expect(res.status).toBe(502);
      expect(res.body.error).toMatch(/invalid address/);
    });

    it("requires admin auth", async () => {
      const app = buildApp(buildStores());
      const res = await request(app)
        .post(`/admin/tenants/${TENANT.id}/connect-number`)
        .send({ phoneNumber: "+15551234567", contactEmail: "owner@acme.com", address: ADDRESS });
      expect(res.status).toBe(401);
    });
  });

  describe("POST /admin/tenants/:id/connect-number/refresh", () => {
    it("400s when no order is in progress", async () => {
      const app = buildApp(buildStores());
      const res = await request(app)
        .post(`/admin/tenants/${TENANT.id}/connect-number/refresh`)
        .set("Authorization", "Bearer admin-secret");
      expect(res.status).toBe(400);
    });

    it("updates the stored status from Twilio", async () => {
      const tenantWithOrder: TenantType = {
        ...TENANT,
        numberHostingOrder: {
          orderSid: "HU123",
          phoneNumber: "+15551234567",
          status: "received",
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
      };
      orderFetchMock.mockResolvedValueOnce({
        sid: "HU123",
        phoneNumber: "+15551234567",
        status: "pending-verification",
        nextStep: "",
        failureReason: "",
      });

      const stores = buildStores(tenantWithOrder);
      const app = buildApp(stores);
      const res = await request(app)
        .post(`/admin/tenants/${TENANT.id}/connect-number/refresh`)
        .set("Authorization", "Bearer admin-secret");

      expect(res.status).toBe(200);
      expect(res.body.numberHostingOrder.status).toBe("pending-verification");
      expect(res.body.channels.sms).toBe(false);
    });

    it("turns on the sms channel with the client's own number once the order completes", async () => {
      const tenantWithOrder: TenantType = {
        ...TENANT,
        numberHostingOrder: {
          orderSid: "HU123",
          phoneNumber: "+15551234567",
          status: "carrier-processing",
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
      };
      orderFetchMock.mockResolvedValueOnce({
        sid: "HU123",
        phoneNumber: "+15551234567",
        status: "completed",
        nextStep: "",
        failureReason: "",
      });

      const stores = buildStores(tenantWithOrder);
      const app = buildApp(stores);
      const res = await request(app)
        .post(`/admin/tenants/${TENANT.id}/connect-number/refresh`)
        .set("Authorization", "Bearer admin-secret");

      expect(res.status).toBe(200);
      expect(res.body.numberHostingOrder.status).toBe("completed");
      expect(res.body.channels.sms).toBe(true);

      const updated = await stores.tenantStore.getTenant(TENANT.id);
      expect(updated?.channels.sms).toEqual({
        fromNumber: "+15551234567",
        accountSid: "AC_shared",
        authToken: "shared-token",
      });
    });
  });
});
