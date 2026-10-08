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
import { createLeadRoutes } from "../src/routes/leads.js";
import type { Lead, Tenant } from "../src/types.js";
import type { Stores } from "../src/store/index.js";

// Regression tests for a legal-compliance gap: POST /leads/:id/reply (the
// needs-attention inbox's "send a real reply" endpoint, src/routes/leads.ts)
// originally skipped every safeguard every other outbound send path in this
// app already enforces — Terms-of-Service acceptance, STOP/do-not-contact
// suppression, and quiet hours. All three are asserted here directly
// against the route, independent of the demo tenant's grandfathered/
// zero-width-quiet-hours defaults (which would hide a regression).

const TENANT: Tenant = {
  id: "tenant-1",
  name: "Acme Co",
  apiKey: "test-api-key",
  timezone: "UTC",
  devMode: true,
  channels: {},
  // Zero-width window explicitly disables quiet hours (see quietHours.ts) —
  // without this, a tenant with no quietHours set falls back to
  // DEFAULT_QUIET_HOURS (8pm-8am), making every test below that doesn't
  // itself test quiet hours flaky depending on what time it happens to run.
  quietHours: { startHour: 0, endHour: 0 },
  termsAcceptedAt: new Date().toISOString(),
  termsVersion: "grandfathered",
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
  status: "responded",
};

function buildStores(tenant: Tenant, leads: Lead[] = [LEAD]): Stores {
  return {
    leadStore: new InMemoryLeadStore(leads),
    tenantStore: new InMemoryTenantStore([tenant]),
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
  app.use(createLeadRoutes(stores));
  return app;
}

describe("POST /leads/:id/reply compliance gates", () => {
  it("refuses to send for a tenant that hasn't accepted the Terms of Service", async () => {
    const tenant: Tenant = { ...TENANT, termsAcceptedAt: undefined, termsVersion: undefined };
    const app = buildApp(buildStores(tenant));

    const res = await request(app)
      .post(`/leads/${LEAD.id}/reply`)
      .set("Authorization", `Bearer ${tenant.apiKey}`)
      .send({ message: "hi there" });
    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/Terms of Service/i);
  });

  it.each(["opted_out", "do_not_contact", "fraudulent"] as const)(
    "refuses to send to a lead with status=%s",
    async (status) => {
      const lead: Lead = { ...LEAD, status };
      const app = buildApp(buildStores(TENANT, [lead]));

      const res = await request(app)
        .post(`/leads/${lead.id}/reply`)
        .set("Authorization", `Bearer ${TENANT.apiKey}`)
        .send({ message: "hi there" });
      expect(res.status).toBe(403);
      expect(res.body.error).toMatch(/cannot message this lead/i);
    }
  );

  it.each(["converted", "booked", "active_conversation"] as const)(
    "still allows a manual reply to a lead with status=%s (not a STOP-style suppression)",
    async (status) => {
      const lead: Lead = { ...LEAD, status, email: "jordan@example.com", phone: undefined };
      const app = buildApp(buildStores(TENANT, [lead]));

      const res = await request(app)
        .post(`/leads/${lead.id}/reply`)
        .set("Authorization", `Bearer ${TENANT.apiKey}`)
        .send({ message: "hi there", channel: "email" });
      expect(res.status).toBe(200);
    }
  );

  it("refuses to send during the tenant's quiet hours", async () => {
    // A 1-hour window starting at the current UTC hour always contains
    // "now" — guaranteed to be active regardless of when the test runs,
    // without needing to fake the clock.
    const currentUtcHour = new Date().getUTCHours();
    const tenant: Tenant = {
      ...TENANT,
      timezone: "UTC",
      quietHours: { startHour: currentUtcHour, endHour: (currentUtcHour + 1) % 24 },
    };
    const app = buildApp(buildStores(tenant));

    const res = await request(app)
      .post(`/leads/${LEAD.id}/reply`)
      .set("Authorization", `Bearer ${tenant.apiKey}`)
      .send({ message: "hi there" });
    expect(res.status).toBe(422);
    expect(res.body.error).toMatch(/quiet hours/i);
  });

  it("sends normally outside quiet hours, with terms accepted and a contactable lead", async () => {
    // Zero-width window disables quiet hours entirely (see
    // isWithinQuietHours) — the same convention DEMO_TENANT and other
    // fixtures in this codebase use when quiet hours aren't under test.
    const tenant: Tenant = { ...TENANT, timezone: "UTC", quietHours: { startHour: 0, endHour: 0 } };
    const app = buildApp(buildStores(tenant));

    const res = await request(app)
      .post(`/leads/${LEAD.id}/reply`)
      .set("Authorization", `Bearer ${tenant.apiKey}`)
      .send({ message: "hi there", channel: "email" });
    expect(res.status).toBe(200);
  });
});
