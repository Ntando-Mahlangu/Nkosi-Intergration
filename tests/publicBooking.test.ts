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
import { createPublicBookingRoutes } from "../src/routes/publicBooking.js";
import type { Lead, Tenant } from "../src/types.js";
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

const LEAD: Lead = {
  id: "lead-1",
  tenantId: TENANT.id,
  name: "Jordan",
  phone: "+27821234567",
  source: "website_form",
  createdAt: new Date().toISOString(),
  status: "new",
};

function buildStores(tenants: Tenant[] = [TENANT], leads: Lead[] = [LEAD]): Stores {
  return {
    leadStore: new InMemoryLeadStore(leads),
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
  app.use(createPublicBookingRoutes(stores));
  return app;
}

const PATH = `/public/appointments/${TENANT.id}/${LEAD.id}`;

function futureIso(daysAhead: number): string {
  return new Date(Date.now() + daysAhead * 24 * 60 * 60 * 1000).toISOString();
}

describe("GET /public/appointments/:tenantId/:leadId", () => {
  it("rejects an unknown tenantId", async () => {
    const app = buildApp(buildStores());
    const res = await request(app).get(`/public/appointments/no-such-tenant/${LEAD.id}?formKey=lrf_test-form-key`);
    expect(res.status).toBe(401);
  });

  it("rejects a wrong formKey with the same generic error as an unknown tenant", async () => {
    const app = buildApp(buildStores());
    const res = await request(app).get(`${PATH}?formKey=wrong-key`);
    expect(res.status).toBe(401);
  });

  it("rejects an unknown leadId", async () => {
    const app = buildApp(buildStores());
    const res = await request(app).get(
      `/public/appointments/${TENANT.id}/no-such-lead?formKey=${TENANT.publicFormKey}`
    );
    expect(res.status).toBe(401);
  });

  it("returns the business name and current appointment state for a valid request", async () => {
    const app = buildApp(buildStores());
    const res = await request(app).get(`${PATH}?formKey=${TENANT.publicFormKey}`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ businessName: "Acme Co", appointmentStatus: "none" });
  });

  it("blocks a suspended tenant", async () => {
    const suspended = { ...TENANT, status: "suspended" as const };
    const app = buildApp(buildStores([suspended]));
    const res = await request(app).get(`${PATH}?formKey=${TENANT.publicFormKey}`);
    expect(res.status).toBe(403);
  });
});

describe("POST /public/appointments/:tenantId/:leadId", () => {
  it("rejects a wrong formKey", async () => {
    const app = buildApp(buildStores());
    const res = await request(app)
      .post(PATH)
      .send({ formKey: "wrong-key", appointmentAt: futureIso(1) });
    expect(res.status).toBe(401);
  });

  it("rejects a non-date appointmentAt", async () => {
    const app = buildApp(buildStores());
    const res = await request(app).post(PATH).send({ formKey: TENANT.publicFormKey, appointmentAt: "not a date" });
    expect(res.status).toBe(400);
  });

  it("rejects a past appointmentAt", async () => {
    const app = buildApp(buildStores());
    const res = await request(app)
      .post(PATH)
      .send({ formKey: TENANT.publicFormKey, appointmentAt: futureIso(-1) });
    expect(res.status).toBe(400);
  });

  it("rejects an appointmentAt too far in the future", async () => {
    const app = buildApp(buildStores());
    const res = await request(app)
      .post(PATH)
      .send({ formKey: TENANT.publicFormKey, appointmentAt: futureIso(365) });
    expect(res.status).toBe(400);
  });

  it("books the appointment and sets the fields appointmentReminder.ts reads", async () => {
    const stores = buildStores();
    const app = buildApp(stores);
    const appointmentAt = futureIso(3);
    const res = await request(app).post(PATH).send({ formKey: TENANT.publicFormKey, appointmentAt });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true });

    const lead = await stores.leadStore.getLeadById(TENANT.id, LEAD.id);
    expect(lead?.appointmentStatus).toBe("booked");
    expect(lead?.appointmentAt).toBe(new Date(appointmentAt).toISOString());
  });

  it("blocks a suspended tenant from booking", async () => {
    const suspended = { ...TENANT, status: "suspended" as const };
    const app = buildApp(buildStores([suspended]));
    const res = await request(app)
      .post(PATH)
      .send({ formKey: TENANT.publicFormKey, appointmentAt: futureIso(1) });
    expect(res.status).toBe(403);
  });

  it("sets a permissive Access-Control-Allow-Origin so the public booking page can call it from any origin", async () => {
    const app = buildApp(buildStores());
    const res = await request(app)
      .post(PATH)
      .send({ formKey: TENANT.publicFormKey, appointmentAt: futureIso(1) });
    expect(res.headers["access-control-allow-origin"]).toBe("*");
  });

  it("answers a CORS preflight OPTIONS request without needing formKey", async () => {
    const app = buildApp(buildStores());
    const res = await request(app).options(PATH);
    expect(res.status).toBe(204);
    expect(res.headers["access-control-allow-origin"]).toBe("*");
    expect(res.headers["access-control-allow-methods"]).toContain("POST");
  });
});
