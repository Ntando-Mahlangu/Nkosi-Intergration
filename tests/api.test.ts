import { describe, expect, it, beforeEach, afterEach } from "vitest";
import request from "supertest";
import express from "express";
import { InMemoryLeadStore, InMemoryMessageStore, InMemoryTenantStore } from "../src/store/memory.js";
import { requireAdminAuth, requireTenantAuth } from "../src/middleware/auth.js";
import { createTenantRoutes } from "../src/routes/tenants.js";
import { createWebhookRoutes } from "../src/webhooks/index.js";
import type { Lead, Tenant } from "../src/types.js";
import type { Stores } from "../src/store/index.js";

const TENANT: Tenant = {
  id: "tenant-1",
  name: "Acme Co",
  apiKey: "test-api-key",
  timezone: "UTC",
  devMode: true,
  channels: {},
  createdAt: new Date().toISOString(),
};

const LEAD: Lead = {
  id: "lead-1",
  tenantId: TENANT.id,
  name: "Jordan",
  phone: "+27821234567",
  email: "jordan@example.com",
  source: "crm",
  createdAt: new Date().toISOString(),
  status: "contacted_no_response",
  firstOutreachSentAt: new Date().toISOString(),
  lastContactedAt: new Date().toISOString(),
};

function buildStores(): Stores {
  return {
    leadStore: new InMemoryLeadStore([LEAD]),
    tenantStore: new InMemoryTenantStore([TENANT]),
    messageStore: new InMemoryMessageStore(),
  };
}

describe("tenant auth middleware", () => {
  const stores = buildStores();
  const app = express();
  app.get("/whoami", requireTenantAuth(stores.tenantStore), (req, res) => res.json({ tenantId: req.tenant!.id }));

  it("rejects requests with no Authorization header", async () => {
    const res = await request(app).get("/whoami");
    expect(res.status).toBe(401);
  });

  it("rejects an unknown API key", async () => {
    const res = await request(app).get("/whoami").set("Authorization", "Bearer nope");
    expect(res.status).toBe(401);
  });

  it("accepts a valid tenant API key", async () => {
    const res = await request(app).get("/whoami").set("Authorization", `Bearer ${TENANT.apiKey}`);
    expect(res.status).toBe(200);
    expect(res.body.tenantId).toBe(TENANT.id);
  });
});

describe("admin auth middleware", () => {
  const originalAdminKey = process.env.ADMIN_API_KEY;

  afterEach(() => {
    if (originalAdminKey === undefined) delete process.env.ADMIN_API_KEY;
    else process.env.ADMIN_API_KEY = originalAdminKey;
  });

  it("returns 503 when ADMIN_API_KEY isn't configured", async () => {
    delete process.env.ADMIN_API_KEY;
    const app = express();
    app.get("/admin-only", requireAdminAuth(), (_req, res) => res.json({ ok: true }));
    const res = await request(app).get("/admin-only").set("Authorization", "Bearer whatever");
    expect(res.status).toBe(503);
  });

  it("rejects the wrong admin key and accepts the right one", async () => {
    process.env.ADMIN_API_KEY = "super-secret";
    const app = express();
    app.get("/admin-only", requireAdminAuth(), (_req, res) => res.json({ ok: true }));

    const wrong = await request(app).get("/admin-only").set("Authorization", "Bearer nope");
    expect(wrong.status).toBe(401);

    const right = await request(app).get("/admin-only").set("Authorization", "Bearer super-secret");
    expect(right.status).toBe(200);
  });
});

describe("tenant management routes", () => {
  it("creates a tenant and returns its API key exactly once", async () => {
    process.env.ADMIN_API_KEY = "admin-secret";
    const stores = buildStores();
    const app = express();
    app.use(express.json());
    app.use(createTenantRoutes(stores.tenantStore));

    const created = await request(app)
      .post("/admin/tenants")
      .set("Authorization", "Bearer admin-secret")
      .send({ name: "New Biz", timezone: "Africa/Johannesburg" });

    expect(created.status).toBe(201);
    expect(created.body.apiKey).toBeTruthy();
    expect(created.body.name).toBe("New Biz");

    const me = await request(app).get("/tenants/me").set("Authorization", `Bearer ${created.body.apiKey}`);
    expect(me.status).toBe(200);
    expect(me.body.name).toBe("New Biz");
    expect(me.body.apiKey).toBeUndefined(); // public shape never re-exposes the key
    delete process.env.ADMIN_API_KEY;
  });
});

describe("webhook: generic lead intake", () => {
  it("requires tenant auth and creates a lead scoped to that tenant", async () => {
    const stores = buildStores();
    const app = express();
    app.use(createWebhookRoutes(stores));

    const unauthed = await request(app).post("/webhooks/lead").send({ phone: "+27820000000" });
    expect(unauthed.status).toBe(401);

    const res = await request(app)
      .post("/webhooks/lead")
      .set("Authorization", `Bearer ${TENANT.apiKey}`)
      .send({ name: "New Lead", phone: "+27820000000", source: "website_form", requestedService: "quote" });

    expect(res.status).toBe(201);
    expect(res.body.tenantId).toBe(TENANT.id);
    expect(res.body.status).toBe("new");

    const all = await stores.leadStore.getAllLeads(TENANT.id);
    expect(all.some((l) => l.phone === "+27820000000")).toBe(true);
  });

  it("rejects a lead with neither phone nor email", async () => {
    const stores = buildStores();
    const app = express();
    app.use(createWebhookRoutes(stores));

    const res = await request(app)
      .post("/webhooks/lead")
      .set("Authorization", `Bearer ${TENANT.apiKey}`)
      .send({ name: "No Contact Info" });

    expect(res.status).toBe(400);
  });
});

describe("webhook: SendGrid inbound parse", () => {
  it("classifies a STOP reply and opts the lead out", async () => {
    const stores = buildStores();
    const app = express();
    app.use(createWebhookRoutes(stores));

    const res = await request(app)
      .post(`/webhooks/${TENANT.id}/sendgrid/email?token=${TENANT.apiKey}`)
      .field("from", "Jordan <jordan@example.com>")
      .field("text", "please STOP emailing me");

    expect(res.status).toBe(204);
    const lead = await stores.leadStore.getLeadById(TENANT.id, LEAD.id);
    expect(lead?.status).toBe("opted_out");

    const history = await stores.messageStore.getMessagesForLead(TENANT.id, LEAD.id);
    expect(history).toHaveLength(1);
    expect(history[0].classification).toBe("stop");
  });

  it("rejects requests with a missing/wrong token", async () => {
    const stores = buildStores();
    const app = express();
    app.use(createWebhookRoutes(stores));

    const res = await request(app)
      .post(`/webhooks/${TENANT.id}/sendgrid/email?token=wrong`)
      .field("from", "jordan@example.com")
      .field("text", "hello");

    expect(res.status).toBe(403);
  });
});
