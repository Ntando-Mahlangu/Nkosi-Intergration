import { describe, expect, it } from "vitest";
import request from "supertest";
import express from "express";
import {
  InMemoryAuditLogStore,
  InMemoryLeadStore,
  InMemoryMessageStore,
  InMemoryNotificationStore,
  InMemoryTenantStore,
} from "../src/store/memory.js";
import { createPublicCaptureRoutes } from "../src/routes/publicCapture.js";
import type { Tenant } from "../src/types.js";
import type { Stores } from "../src/store/index.js";

const TENANT: Tenant = {
  id: "tenant-1",
  name: "Acme Co",
  apiKey: "test-api-key",
  timezone: "UTC",
  channels: {},
  publicFormKey: "lrf_test-form-key",
  createdAt: new Date().toISOString(),
};

function buildStores(tenants: Tenant[] = [TENANT]): Stores {
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
  app.use(createPublicCaptureRoutes(stores));
  return app;
}

describe("POST /public/leads/:tenantId", () => {
  it("rejects an unknown tenantId", async () => {
    const app = buildApp(buildStores());
    const res = await request(app)
      .post("/public/leads/no-such-tenant")
      .send({ formKey: "lrf_test-form-key", phone: "+27821234567" });
    expect(res.status).toBe(401);
  });

  it("rejects a wrong formKey with the same generic error as an unknown tenant", async () => {
    const app = buildApp(buildStores());
    const res = await request(app)
      .post(`/public/leads/${TENANT.id}`)
      .send({ formKey: "wrong-key", phone: "+27821234567" });
    expect(res.status).toBe(401);
  });

  it("rejects a submission with neither phone nor email", async () => {
    const app = buildApp(buildStores());
    const res = await request(app)
      .post(`/public/leads/${TENANT.id}`)
      .send({ formKey: TENANT.publicFormKey, name: "Jordan" });
    expect(res.status).toBe(400);
  });

  it("creates a lead with source website_form from a valid submission", async () => {
    const stores = buildStores();
    const app = buildApp(stores);
    const res = await request(app).post(`/public/leads/${TENANT.id}`).send({
      formKey: TENANT.publicFormKey,
      name: "Jordan",
      phone: "+27821234567",
      requestedService: "Bathroom renovation",
    });
    expect(res.status).toBe(201);

    const leads = await stores.leadStore.getAllLeads(TENANT.id);
    expect(leads).toHaveLength(1);
    expect(leads[0]).toMatchObject({
      name: "Jordan",
      phone: "+27821234567",
      requestedService: "Bathroom renovation",
      source: "website_form",
      status: "new",
    });
  });

  it("accepts an email-only submission (no phone required)", async () => {
    const stores = buildStores();
    const app = buildApp(stores);
    const res = await request(app)
      .post(`/public/leads/${TENANT.id}`)
      .send({ formKey: TENANT.publicFormKey, email: "jordan@example.com" });
    expect(res.status).toBe(201);
  });

  it("blocks a suspended tenant from receiving new leads", async () => {
    const suspended = { ...TENANT, status: "suspended" as const };
    const stores = buildStores([suspended]);
    const app = buildApp(stores);
    const res = await request(app)
      .post(`/public/leads/${TENANT.id}`)
      .send({ formKey: TENANT.publicFormKey, phone: "+27821234567" });
    expect(res.status).toBe(403);
  });

  it("sets a permissive Access-Control-Allow-Origin so any client website can call it", async () => {
    const app = buildApp(buildStores());
    const res = await request(app)
      .post(`/public/leads/${TENANT.id}`)
      .send({ formKey: TENANT.publicFormKey, phone: "+27821234567" });
    expect(res.headers["access-control-allow-origin"]).toBe("*");
  });

  it("answers a CORS preflight OPTIONS request without needing formKey", async () => {
    const app = buildApp(buildStores());
    const res = await request(app).options(`/public/leads/${TENANT.id}`);
    expect(res.status).toBe(204);
    expect(res.headers["access-control-allow-origin"]).toBe("*");
    expect(res.headers["access-control-allow-methods"]).toContain("POST");
  });
});
