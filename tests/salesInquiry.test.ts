import { afterEach, beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import express from "express";
import {
  InMemoryAuditLogStore,
  InMemoryLeadStore,
  InMemoryMessageStore,
  InMemoryNotificationStore,
  InMemorySalesInquiryStore,
  InMemoryTenantStore,
  InMemoryTenantUserStore,
} from "../src/store/memory.js";
import { createInquiryRoutes } from "../src/routes/inquiries.js";
import type { Stores } from "../src/store/index.js";

function buildStores(): Stores {
  return {
    leadStore: new InMemoryLeadStore(),
    tenantStore: new InMemoryTenantStore([]),
    tenantUserStore: new InMemoryTenantUserStore(),
    messageStore: new InMemoryMessageStore(),
    notificationStore: new InMemoryNotificationStore(),
    auditLogStore: new InMemoryAuditLogStore(),
    salesInquiryStore: new InMemorySalesInquiryStore(),
  };
}

function buildApp(stores: Stores) {
  const app = express();
  app.use(express.json());
  app.use(createInquiryRoutes(stores));
  return app;
}

describe("sales inquiries (public marketing-page form + admin review)", () => {
  const originalAdminKey = process.env.ADMIN_API_KEY;

  beforeEach(() => {
    process.env.ADMIN_API_KEY = "admin-secret";
  });

  afterEach(() => {
    if (originalAdminKey === undefined) delete process.env.ADMIN_API_KEY;
    else process.env.ADMIN_API_KEY = originalAdminKey;
  });

  describe("POST /inquiries", () => {
    it("rejects a submission with no businessName", async () => {
      const app = buildApp(buildStores());
      const res = await request(app).post("/inquiries").send({ email: "jane@example.com" });
      expect(res.status).toBe(400);
    });

    it("rejects a submission with neither phone nor email", async () => {
      const app = buildApp(buildStores());
      const res = await request(app).post("/inquiries").send({ businessName: "Acme Plumbing" });
      expect(res.status).toBe(400);
    });

    it("accepts a phone-only submission (no email required)", async () => {
      const app = buildApp(buildStores());
      const res = await request(app).post("/inquiries").send({ businessName: "Acme Plumbing", phone: "+27821234567" });
      expect(res.status).toBe(201);
    });

    it("records a valid submission with status=new, not requiring admin auth", async () => {
      const stores = buildStores();
      const app = buildApp(stores);
      const res = await request(app).post("/inquiries").send({
        businessName: "Acme Plumbing",
        contactName: "Jane Smith",
        email: "jane@acmeplumbing.com",
        website: "https://acmeplumbing.com",
        message: "We miss a lot of calls after hours.",
      });
      expect(res.status).toBe(201);
      expect(res.body).toEqual({ ok: true });

      const stored = await stores.salesInquiryStore.list({ offset: 0 });
      expect(stored).toHaveLength(1);
      expect(stored[0]).toMatchObject({
        businessName: "Acme Plumbing",
        contactName: "Jane Smith",
        email: "jane@acmeplumbing.com",
        website: "https://acmeplumbing.com",
        message: "We miss a lot of calls after hours.",
        status: "new",
      });
    });
  });

  describe("GET /admin/inquiries", () => {
    it("requires admin auth", async () => {
      const app = buildApp(buildStores());
      const res = await request(app).get("/admin/inquiries");
      expect(res.status).toBe(401);
    });

    it("lists inquiries newest first, with X-Total-Count", async () => {
      const stores = buildStores();
      await stores.salesInquiryStore.create({ businessName: "Older Co", email: "a@example.com" });
      // A real gap between createdAt timestamps — otherwise both can land in
      // the same millisecond and the sort-by-createdAt below is a no-op tie.
      await new Promise((resolve) => setTimeout(resolve, 5));
      await stores.salesInquiryStore.create({ businessName: "Newer Co", email: "b@example.com" });
      const app = buildApp(stores);

      const res = await request(app).get("/admin/inquiries").set("Authorization", "Bearer admin-secret");
      expect(res.status).toBe(200);
      expect(res.headers["x-total-count"]).toBe("2");
      expect(res.body.map((i: { businessName: string }) => i.businessName)).toEqual(["Newer Co", "Older Co"]);
    });
  });

  describe("PATCH /admin/inquiries/:id", () => {
    it("requires admin auth", async () => {
      const app = buildApp(buildStores());
      const res = await request(app).patch("/admin/inquiries/whatever").send({ status: "contacted" });
      expect(res.status).toBe(401);
    });

    it("rejects an invalid status value", async () => {
      const stores = buildStores();
      const inquiry = await stores.salesInquiryStore.create({ businessName: "Acme", email: "a@example.com" });
      const app = buildApp(stores);
      const res = await request(app)
        .patch(`/admin/inquiries/${inquiry.id}`)
        .set("Authorization", "Bearer admin-secret")
        .send({ status: "archived" });
      expect(res.status).toBe(400);
    });

    it("404s for an unknown inquiry id", async () => {
      const app = buildApp(buildStores());
      const res = await request(app)
        .patch("/admin/inquiries/no-such-id")
        .set("Authorization", "Bearer admin-secret")
        .send({ status: "contacted" });
      expect(res.status).toBe(404);
    });

    it("updates the status and returns the updated inquiry", async () => {
      const stores = buildStores();
      const inquiry = await stores.salesInquiryStore.create({ businessName: "Acme", email: "a@example.com" });
      const app = buildApp(stores);

      const res = await request(app)
        .patch(`/admin/inquiries/${inquiry.id}`)
        .set("Authorization", "Bearer admin-secret")
        .send({ status: "contacted" });
      expect(res.status).toBe(200);
      expect(res.body.status).toBe("contacted");

      const [stored] = await stores.salesInquiryStore.list({ offset: 0 });
      expect(stored.status).toBe("contacted");
    });
  });
});
