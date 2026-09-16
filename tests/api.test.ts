import { createSign, generateKeyPairSync } from "node:crypto";
import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import request from "supertest";
import express from "express";
import twilio from "twilio";
import {
  InMemoryAuditLogStore,
  InMemoryLeadStore,
  InMemoryMessageStore,
  InMemoryNotificationStore,
  InMemoryTenantStore,
} from "../src/store/memory.js";
import { requireAdminAuth, requireTenantAuth } from "../src/middleware/auth.js";
import { createTenantRoutes } from "../src/routes/tenants.js";
import { createWebhookRoutes } from "../src/webhooks/index.js";
import type { Lead, Tenant } from "../src/types.js";
import type { Stores } from "../src/store/index.js";

// Chatbot auto-replies (src/chatbot.ts) call the Anthropic SDK directly whenever a
// tenant has autoReplyEnabled + knowledgeBase set, independent of the reply-
// classification LLM flag — mock it so those tests never hit the network.
const anthropicCreateMock = vi.fn();
vi.mock("@anthropic-ai/sdk", () => ({
  default: class MockAnthropic {
    messages = { create: anthropicCreateMock };
  },
}));

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
    notificationStore: new InMemoryNotificationStore(),
    auditLogStore: new InMemoryAuditLogStore(),
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

  it("responds with an error instead of hanging forever when the tenant store throws", async () => {
    // Regression test: requireTenantAuth is async middleware, not a route
    // handler — Express 4 doesn't forward a rejection from either kind to
    // error-handling middleware on its own. Before this was asyncHandler-
    // wrapped, getTenantByApiKey throwing left the request with no response
    // ever sent, on every tenant-authenticated route in the app.
    vi.spyOn(stores.tenantStore, "getTenantByApiKey").mockRejectedValueOnce(new Error("db exploded"));
    const res = await request(app).get("/whoami").set("Authorization", `Bearer ${TENANT.apiKey}`);
    expect(res.status).toBe(500);
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
    app.use(createTenantRoutes(stores));

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

describe("tenant lifecycle: suspend and delete", () => {
  beforeEach(() => {
    process.env.ADMIN_API_KEY = "admin-secret";
  });
  afterEach(() => {
    delete process.env.ADMIN_API_KEY;
  });

  function buildApp(stores: Stores) {
    const app = express();
    app.use(express.json());
    app.use(createTenantRoutes(stores));
    const auth = requireTenantAuth(stores.tenantStore);
    app.get("/whoami", auth, (req, res) => res.json({ tenantId: req.tenant!.id }));
    return app;
  }

  it("blocks tenant-authed requests once suspended by the admin API, and restores access on reactivation", async () => {
    const stores = buildStores();
    const app = buildApp(stores);

    const before = await request(app).get("/whoami").set("Authorization", `Bearer ${TENANT.apiKey}`);
    expect(before.status).toBe(200);

    const suspend = await request(app)
      .patch(`/admin/tenants/${TENANT.id}`)
      .set("Authorization", "Bearer admin-secret")
      .send({ status: "suspended" });
    expect(suspend.status).toBe(200);
    expect(suspend.body.status).toBe("suspended");

    const whileSuspended = await request(app).get("/whoami").set("Authorization", `Bearer ${TENANT.apiKey}`);
    expect(whileSuspended.status).toBe(403);
    expect(whileSuspended.body.error).toMatch(/suspended/);

    const reactivate = await request(app)
      .patch(`/admin/tenants/${TENANT.id}`)
      .set("Authorization", "Bearer admin-secret")
      .send({ status: "active" });
    expect(reactivate.status).toBe(200);

    const after = await request(app).get("/whoami").set("Authorization", `Bearer ${TENANT.apiKey}`);
    expect(after.status).toBe(200);
  });

  it("404s an admin status change for an unknown tenant id", async () => {
    const stores = buildStores();
    const app = buildApp(stores);

    const res = await request(app)
      .patch("/admin/tenants/no-such-tenant")
      .set("Authorization", "Bearer admin-secret")
      .send({ status: "suspended" });
    expect(res.status).toBe(404);
  });

  it("permanently deletes a tenant, after which its API key no longer authenticates", async () => {
    const stores = buildStores();
    const app = buildApp(stores);

    const del = await request(app).delete(`/admin/tenants/${TENANT.id}`).set("Authorization", "Bearer admin-secret");
    expect(del.status).toBe(204);

    const whoami = await request(app).get("/whoami").set("Authorization", `Bearer ${TENANT.apiKey}`);
    expect(whoami.status).toBe(401);

    const list = await request(app).get("/admin/tenants").set("Authorization", "Bearer admin-secret");
    expect(list.body.find((t: { id: string }) => t.id === TENANT.id)).toBeUndefined();
  });

  it("404s deleting a tenant that doesn't exist (including a second delete of the same tenant)", async () => {
    const stores = buildStores();
    const app = buildApp(stores);

    const first = await request(app).delete(`/admin/tenants/${TENANT.id}`).set("Authorization", "Bearer admin-secret");
    expect(first.status).toBe(204);

    const second = await request(app).delete(`/admin/tenants/${TENANT.id}`).set("Authorization", "Bearer admin-secret");
    expect(second.status).toBe(404);
  });
});

describe("admin audit log", () => {
  beforeEach(() => {
    process.env.ADMIN_API_KEY = "admin-secret";
  });
  afterEach(() => {
    delete process.env.ADMIN_API_KEY;
  });

  it("records tenant create/admin_update/key_rotate/delete and lists them newest first", async () => {
    const stores = buildStores();
    const app = express();
    app.use(express.json());
    app.use(createTenantRoutes(stores));

    const created = await request(app)
      .post("/admin/tenants")
      .set("Authorization", "Bearer admin-secret")
      .send({ name: "New Biz", timezone: "Africa/Johannesburg" });
    const tenantId = created.body.id;

    await request(app)
      .patch(`/admin/tenants/${tenantId}`)
      .set("Authorization", "Bearer admin-secret")
      .send({ status: "suspended" });

    await request(app).post(`/admin/tenants/${tenantId}/rotate-key`).set("Authorization", "Bearer admin-secret");

    await request(app).delete(`/admin/tenants/${tenantId}`).set("Authorization", "Bearer admin-secret");

    const log = await request(app).get("/admin/audit-log").set("Authorization", "Bearer admin-secret");
    expect(log.status).toBe(200);
    expect(log.headers["x-total-count"]).toBe("4");
    expect(log.body.map((e: { action: string }) => e.action)).toEqual([
      "tenant.delete",
      "tenant.key_rotate",
      "tenant.admin_update",
      "tenant.create",
    ]);
    expect(log.body.every((e: { tenantId: string }) => e.tenantId === tenantId)).toBe(true);
    // admin_update logs which fields changed, never the values (no credentials duplicated into a second store)
    const updateEntry = log.body.find((e: { action: string }) => e.action === "tenant.admin_update");
    expect(updateEntry.details).toEqual({ fieldsChanged: ["status"] });
  });

  it("still completes the tenant mutation and responds, even if the audit write itself fails", async () => {
    // Regression test: a raw `await auditLogStore.record(...)` with no
    // try/catch in the route handler would leave the request hanging
    // forever on failure (the tenant was already created/mutated, but
    // Express 4 doesn't catch a rejection thrown after that point, and
    // nothing else would ever send a response).
    const stores = buildStores();
    stores.auditLogStore.record = async () => {
      throw new Error("audit DB unreachable");
    };
    const app = express();
    app.use(express.json());
    app.use(createTenantRoutes(stores));

    const created = await request(app)
      .post("/admin/tenants")
      .set("Authorization", "Bearer admin-secret")
      .send({ name: "New Biz", timezone: "Africa/Johannesburg" });
    expect(created.status).toBe(201);
    expect(created.body.apiKey).toBeTruthy();
  });

  it("requires admin auth", async () => {
    const stores = buildStores();
    const app = express();
    app.use(express.json());
    app.use(createTenantRoutes(stores));

    const res = await request(app).get("/admin/audit-log");
    expect(res.status).toBe(401);
  });
});

describe("admin failed-notifications visibility", () => {
  beforeEach(() => {
    process.env.ADMIN_API_KEY = "admin-secret";
  });
  afterEach(() => {
    delete process.env.ADMIN_API_KEY;
  });

  it("lists a persisted failed notification for an admin to see", async () => {
    const stores = buildStores();
    await stores.notificationStore.recordFailure({
      tenantId: TENANT.id,
      leadId: LEAD.id,
      reason: "interested",
      webhookUrl: "https://hooks.example.com/notify",
      payload: { text: "hi" },
      error: "network down",
    });

    const app = express();
    app.use(express.json());
    app.use(createTenantRoutes(stores));

    const res = await request(app).get("/admin/notifications/failed").set("Authorization", "Bearer admin-secret");
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0]).toMatchObject({ tenantId: TENANT.id, status: "pending", reason: "interested" });
  });

  it("requires admin auth", async () => {
    const stores = buildStores();
    const app = express();
    app.use(express.json());
    app.use(createTenantRoutes(stores));

    const res = await request(app).get("/admin/notifications/failed");
    expect(res.status).toBe(401);
  });
});

describe("tenant lifecycle: API key rotation", () => {
  beforeEach(() => {
    process.env.ADMIN_API_KEY = "admin-secret";
  });
  afterEach(() => {
    delete process.env.ADMIN_API_KEY;
  });

  function buildApp(stores: Stores) {
    const app = express();
    app.use(express.json());
    app.use(createTenantRoutes(stores));
    return app;
  }

  it("issues a new API key and invalidates the old one immediately", async () => {
    const stores = buildStores();
    const app = buildApp(stores);

    const before = await request(app).get("/tenants/me").set("Authorization", `Bearer ${TENANT.apiKey}`);
    expect(before.status).toBe(200);

    const rotated = await request(app)
      .post(`/admin/tenants/${TENANT.id}/rotate-key`)
      .set("Authorization", "Bearer admin-secret");
    expect(rotated.status).toBe(200);
    expect(rotated.body.apiKey).toBeTruthy();
    expect(rotated.body.apiKey).not.toBe(TENANT.apiKey);

    const withOldKey = await request(app).get("/tenants/me").set("Authorization", `Bearer ${TENANT.apiKey}`);
    expect(withOldKey.status).toBe(401);

    const withNewKey = await request(app).get("/tenants/me").set("Authorization", `Bearer ${rotated.body.apiKey}`);
    expect(withNewKey.status).toBe(200);
    expect(withNewKey.body.id).toBe(TENANT.id);
  });

  it("404s rotating the key for an unknown tenant", async () => {
    const stores = buildStores();
    const app = buildApp(stores);

    const res = await request(app)
      .post("/admin/tenants/no-such-tenant/rotate-key")
      .set("Authorization", "Bearer admin-secret");
    expect(res.status).toBe(404);
  });
});

describe("admin tenant listing pagination", () => {
  beforeEach(() => {
    process.env.ADMIN_API_KEY = "admin-secret";
  });
  afterEach(() => {
    delete process.env.ADMIN_API_KEY;
  });

  it("supports ?limit=&offset= and always reports X-Total-Count", async () => {
    const stores: Stores = {
      leadStore: new InMemoryLeadStore([LEAD]),
      tenantStore: new InMemoryTenantStore([
        TENANT,
        { ...TENANT, id: "tenant-2", apiKey: "key-2", name: "B Co" },
        { ...TENANT, id: "tenant-3", apiKey: "key-3", name: "C Co" },
      ]),
      messageStore: new InMemoryMessageStore(),
      notificationStore: new InMemoryNotificationStore(),
      auditLogStore: new InMemoryAuditLogStore(),
    };
    const app = express();
    app.use(express.json());
    app.use(createTenantRoutes(stores));

    const all = await request(app).get("/admin/tenants").set("Authorization", "Bearer admin-secret");
    expect(all.status).toBe(200);
    expect(all.body).toHaveLength(3);
    expect(all.headers["x-total-count"]).toBe("3");

    const page = await request(app).get("/admin/tenants?limit=1&offset=1").set("Authorization", "Bearer admin-secret");
    expect(page.body).toHaveLength(1);
    expect(page.body[0].id).toBe("tenant-2");
    expect(page.headers["x-total-count"]).toBe("3");
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

  it("survives the underlying store throwing instead of crashing the process (asyncHandler)", async () => {
    // Regression test: every route handler here is async, and Express 4
    // does not forward a rejected promise from one to error middleware on
    // its own — it becomes an unhandled rejection, which (in production,
    // with installFatalErrorHandlers wired up) crashes the whole server.
    // This simulates exactly that: a store call throwing mid-request.
    const stores = buildStores();
    vi.spyOn(stores.leadStore, "createLead").mockRejectedValue(new Error("db exploded"));
    const app = express();
    app.use(createWebhookRoutes(stores));

    let unhandled: unknown;
    process.once("unhandledRejection", (reason) => {
      unhandled = reason;
    });

    const res = await request(app)
      .post("/webhooks/lead")
      .set("Authorization", `Bearer ${TENANT.apiKey}`)
      .send({ phone: "+27820000000" });

    expect(res.status).toBe(500);
    expect(unhandled).toBeUndefined();
    process.removeAllListeners("unhandledRejection");
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

describe("webhook: SendGrid delivery events", () => {
  it("updates message delivery status by the correlated message id", async () => {
    const stores = buildStores();
    await stores.messageStore.logMessage({
      id: "msg-1",
      tenantId: TENANT.id,
      leadId: LEAD.id,
      channel: "email",
      direction: "outbound",
      body: "hi",
      at: new Date().toISOString(),
    });
    const app = express();
    app.use(createWebhookRoutes(stores));

    const res = await request(app)
      .post(`/webhooks/${TENANT.id}/sendgrid/events?token=${TENANT.apiKey}`)
      .send([
        { event: "delivered", leadrecovery_message_id: "msg-1" },
        { event: "open", leadrecovery_message_id: "msg-1" },
      ]);

    expect(res.status).toBe(204);
    const [message] = await stores.messageStore.getMessagesForLead(TENANT.id, LEAD.id);
    expect(message.deliveryStatus).toBe("open"); // last event in the batch wins
  });

  it("rejects a missing/wrong token", async () => {
    const stores = buildStores();
    const app = express();
    app.use(createWebhookRoutes(stores));

    const res = await request(app).post(`/webhooks/${TENANT.id}/sendgrid/events?token=wrong`).send([]);
    expect(res.status).toBe(403);
  });

  it("verifies a real ECDSA signature instead of the token when eventWebhookPublicKey is configured", async () => {
    const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
    const publicKeyBase64 = publicKey.export({ type: "spki", format: "der" }).toString("base64");
    const tenant: Tenant = {
      ...TENANT,
      channels: { email: { apiKey: "sg", fromEmail: "a@b.com", eventWebhookPublicKey: publicKeyBase64 } },
    };

    const stores: Stores = {
      leadStore: new InMemoryLeadStore([LEAD]),
      tenantStore: new InMemoryTenantStore([tenant]),
      messageStore: new InMemoryMessageStore(),
      notificationStore: new InMemoryNotificationStore(),
      auditLogStore: new InMemoryAuditLogStore(),
    };
    await stores.messageStore.logMessage({
      id: "msg-1",
      tenantId: tenant.id,
      leadId: LEAD.id,
      channel: "email",
      direction: "outbound",
      body: "hi",
      at: new Date().toISOString(),
    });
    const app = express();
    app.use(createWebhookRoutes(stores));

    const payload = JSON.stringify([{ event: "delivered", leadrecovery_message_id: "msg-1" }]);
    const timestamp = String(Math.floor(Date.now() / 1000));
    const signer = createSign("sha256");
    signer.update(timestamp + payload);
    signer.end();
    const signature = signer.sign(privateKey).toString("base64");

    // No ?token= at all — signature verification is what must let this through.
    const res = await request(app)
      .post(`/webhooks/${tenant.id}/sendgrid/events`)
      .set("Content-Type", "application/json")
      .set("X-Twilio-Email-Event-Webhook-Signature", signature)
      .set("X-Twilio-Email-Event-Webhook-Timestamp", timestamp)
      .send(payload);

    expect(res.status).toBe(204);
    const [message] = await stores.messageStore.getMessagesForLead(tenant.id, LEAD.id);
    expect(message.deliveryStatus).toBe("delivered");
  });

  it("rejects a bad signature when eventWebhookPublicKey is configured, even with no token check to fall back on", async () => {
    const { publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
    const publicKeyBase64 = publicKey.export({ type: "spki", format: "der" }).toString("base64");
    const tenant: Tenant = {
      ...TENANT,
      channels: { email: { apiKey: "sg", fromEmail: "a@b.com", eventWebhookPublicKey: publicKeyBase64 } },
    };
    const stores = buildStores();
    stores.tenantStore = new InMemoryTenantStore([tenant]);
    const app = express();
    app.use(createWebhookRoutes(stores));

    const res = await request(app)
      .post(`/webhooks/${tenant.id}/sendgrid/events?token=${tenant.apiKey}`) // even a correct token must not matter here
      .set("Content-Type", "application/json")
      .set("X-Twilio-Email-Event-Webhook-Signature", "bm90LWEtcmVhbC1zaWduYXR1cmU=")
      .set("X-Twilio-Email-Event-Webhook-Timestamp", String(Math.floor(Date.now() / 1000)))
      .send(JSON.stringify([{ event: "delivered", leadrecovery_message_id: "msg-1" }]));

    expect(res.status).toBe(403);
  });
});

describe("webhook: generic lead intake source validation", () => {
  it("normalizes an unrecognized source to 'other' instead of trusting client input", async () => {
    const stores = buildStores();
    const app = express();
    app.use(createWebhookRoutes(stores));

    const res = await request(app)
      .post("/webhooks/lead")
      .set("Authorization", `Bearer ${TENANT.apiKey}`)
      .send({ phone: "+27821110000", source: "some-made-up-source" });

    expect(res.status).toBe(201);
    expect(res.body.source).toBe("other");
  });
});

describe("Twilio SMS/WhatsApp inbound webhook", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  // Signature verification (twilio.validateRequest) is a separate concern
  // from the routing/lookup logic under test here, and generating a real
  // signature would require predicting supertest's ephemeral host — stub it
  // out rather than fighting that.
  function stubValidSignature() {
    vi.spyOn(twilio, "validateRequest").mockReturnValue(true);
  }

  it("matches a WhatsApp reply to its lead despite the whatsapp: From prefix", async () => {
    stubValidSignature();
    const tenant: Tenant = {
      ...TENANT,
      channels: { whatsapp: { accountSid: "AC1", authToken: "tok", fromNumber: "+15550000" } },
    };
    const stores: Stores = {
      leadStore: new InMemoryLeadStore([LEAD]),
      tenantStore: new InMemoryTenantStore([tenant]),
      messageStore: new InMemoryMessageStore(),
      notificationStore: new InMemoryNotificationStore(),
      auditLogStore: new InMemoryAuditLogStore(),
    };
    const app = express();
    app.use(createWebhookRoutes(stores));

    const res = await request(app)
      .post(`/webhooks/${tenant.id}/twilio/sms`)
      .type("form")
      .send({ From: `whatsapp:${LEAD.phone}`, Body: "STOP" });

    expect(res.status).toBe(200);
    // A STOP reply must actually reach the lead: opted_out only happens if
    // findLeadByContact matched it in the first place (see recordInboundAndClassify).
    const updated = await stores.leadStore.getLeadById(tenant.id, LEAD.id);
    expect(updated?.status).toBe("opted_out");

    const history = await stores.messageStore.getMessagesForLead(tenant.id, LEAD.id);
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({ direction: "inbound", channel: "whatsapp", classification: "stop" });
  });

  it("still matches a plain SMS reply (no whatsapp: prefix)", async () => {
    stubValidSignature();
    const tenant: Tenant = {
      ...TENANT,
      channels: { sms: { accountSid: "AC1", authToken: "tok", fromNumber: "+15550000" } },
    };
    const stores: Stores = {
      leadStore: new InMemoryLeadStore([LEAD]),
      tenantStore: new InMemoryTenantStore([tenant]),
      messageStore: new InMemoryMessageStore(),
      notificationStore: new InMemoryNotificationStore(),
      auditLogStore: new InMemoryAuditLogStore(),
    };
    const app = express();
    app.use(createWebhookRoutes(stores));

    const res = await request(app).post(`/webhooks/${tenant.id}/twilio/sms`).type("form").send({
      From: LEAD.phone,
      Body: "STOP",
    });

    expect(res.status).toBe(200);
    const updated = await stores.leadStore.getLeadById(tenant.id, LEAD.id);
    expect(updated?.status).toBe("opted_out");
  });
});

describe("notify on interested reply", () => {
  it("POSTs to the tenant's notifyWebhookUrl when a reply classifies as interested", async () => {
    const tenantWithHook: Tenant = { ...TENANT, notifyWebhookUrl: "https://hooks.example.com/notify" };
    const stores: Stores = {
      leadStore: new InMemoryLeadStore([LEAD]),
      tenantStore: new InMemoryTenantStore([tenantWithHook]),
      messageStore: new InMemoryMessageStore(),
      notificationStore: new InMemoryNotificationStore(),
      auditLogStore: new InMemoryAuditLogStore(),
    };
    const app = express();
    app.use(createWebhookRoutes(stores));

    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 200 }));

    const res = await request(app)
      .post(`/webhooks/${TENANT.id}/sendgrid/email?token=${TENANT.apiKey}`)
      .field("from", "Jordan <jordan@example.com>")
      .field("text", "yes please, sounds good");

    expect(res.status).toBe(204);
    // The webhook route fires this notification via `void notifyHumanAttention(...)`
    // (see src/webhooks/index.ts) — deliberately not awaited, so the response
    // isn't held up by a slow/unreachable notification target. Wait for the
    // spy rather than asserting immediately: nothing guarantees the fetch
    // inside it has actually run by the time the HTTP response resolves.
    await vi.waitFor(() => expect(fetchSpy).toHaveBeenCalled());
    expect(fetchSpy).toHaveBeenCalledWith(
      "https://hooks.example.com/notify",
      expect.objectContaining({ method: "POST" })
    );
    // The real code always passes a JSON string as the body; cast rather than
    // String(...) it, since RequestInit["body"]'s wider type (e.g. a
    // ReadableStream) wouldn't stringify to anything meaningful.
    const body = JSON.parse(fetchSpy.mock.calls[0][1]?.body as string);
    expect(body.event).toBe("lead_interested");
    expect(body.lead.id).toBe(LEAD.id);

    fetchSpy.mockRestore();
  });

  it("never fails the webhook if the notification target is unreachable", async () => {
    const tenantWithHook: Tenant = { ...TENANT, notifyWebhookUrl: "https://hooks.example.com/notify" };
    const stores: Stores = {
      leadStore: new InMemoryLeadStore([LEAD]),
      tenantStore: new InMemoryTenantStore([tenantWithHook]),
      messageStore: new InMemoryMessageStore(),
      notificationStore: new InMemoryNotificationStore(),
      auditLogStore: new InMemoryAuditLogStore(),
    };
    const app = express();
    app.use(createWebhookRoutes(stores));

    const fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network down"));

    const res = await request(app)
      .post(`/webhooks/${TENANT.id}/sendgrid/email?token=${TENANT.apiKey}`)
      .field("from", "Jordan <jordan@example.com>")
      .field("text", "yes please");

    expect(res.status).toBe(204);
    const lead = await stores.leadStore.getLeadById(TENANT.id, LEAD.id);
    expect(lead?.status).toBe("responded");

    fetchSpy.mockRestore();
  });
});

describe("tenant self-service settings", () => {
  it("lets a tenant update its own timezone/quietHours/notifyWebhookUrl", async () => {
    const stores = buildStores();
    const app = express();
    app.use(express.json());
    app.use(createTenantRoutes(stores));

    const res = await request(app)
      .patch("/tenants/me")
      .set("Authorization", `Bearer ${TENANT.apiKey}`)
      .send({
        timezone: "America/New_York",
        quietHours: { startHour: 21, endHour: 7 },
        notifyWebhookUrl: "https://x.example.com/hook",
      });

    expect(res.status).toBe(200);
    expect(res.body.timezone).toBe("America/New_York");
    expect(res.body.quietHours).toEqual({ startHour: 21, endHour: 7 });
  });

  it("rejects an invalid timezone", async () => {
    const stores = buildStores();
    const app = express();
    app.use(express.json());
    app.use(createTenantRoutes(stores));

    const res = await request(app)
      .patch("/tenants/me")
      .set("Authorization", `Bearer ${TENANT.apiKey}`)
      .send({ timezone: "Not/A_Real_Zone" });

    expect(res.status).toBe(400);
  });

  it("rejects out-of-range quiet hours", async () => {
    const stores = buildStores();
    const app = express();
    app.use(express.json());
    app.use(createTenantRoutes(stores));

    const res = await request(app)
      .patch("/tenants/me")
      .set("Authorization", `Bearer ${TENANT.apiKey}`)
      .send({ quietHours: { startHour: 25, endHour: 8 } });

    expect(res.status).toBe(400);
  });

  it("rejects an invalid notifyWebhookUrl", async () => {
    const stores = buildStores();
    const app = express();
    app.use(express.json());
    app.use(createTenantRoutes(stores));

    const res = await request(app)
      .patch("/tenants/me")
      .set("Authorization", `Bearer ${TENANT.apiKey}`)
      .send({ notifyWebhookUrl: "not-a-url" });

    expect(res.status).toBe(400);
  });

  it("lets a tenant set a knowledge base and enable auto-reply together", async () => {
    const stores = buildStores();
    const app = express();
    app.use(express.json());
    app.use(createTenantRoutes(stores));

    const res = await request(app)
      .patch("/tenants/me")
      .set("Authorization", `Bearer ${TENANT.apiKey}`)
      .send({ knowledgeBase: "We're open 9-5 Mon-Fri.", autoReplyEnabled: true });

    expect(res.status).toBe(200);
  });

  it("rejects enabling auto-reply with no knowledge base set (on this or a prior request)", async () => {
    const stores = buildStores();
    const app = express();
    app.use(express.json());
    app.use(createTenantRoutes(stores));

    const res = await request(app)
      .patch("/tenants/me")
      .set("Authorization", `Bearer ${TENANT.apiKey}`)
      .send({ autoReplyEnabled: true });

    expect(res.status).toBe(400);
  });

  it("rejects an oversized knowledge base", async () => {
    const stores = buildStores();
    const app = express();
    app.use(express.json());
    app.use(createTenantRoutes(stores));

    const res = await request(app)
      .patch("/tenants/me")
      .set("Authorization", `Bearer ${TENANT.apiKey}`)
      .send({ knowledgeBase: "x".repeat(20_001) });

    expect(res.status).toBe(400);
  });

  it("refuses to let a tenant change its own status — a tenant can't un-suspend itself", async () => {
    const stores = buildStores();
    const app = express();
    app.use(express.json());
    app.use(createTenantRoutes(stores));

    const res = await request(app)
      .patch("/tenants/me")
      .set("Authorization", `Bearer ${TENANT.apiKey}`)
      .send({ status: "suspended" });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/admin API/);
  });
});

describe("admin tenant creation validation", () => {
  it("rejects an invalid timezone", async () => {
    process.env.ADMIN_API_KEY = "admin-secret";
    const stores = buildStores();
    const app = express();
    app.use(express.json());
    app.use(createTenantRoutes(stores));

    const res = await request(app)
      .post("/admin/tenants")
      .set("Authorization", "Bearer admin-secret")
      .send({ name: "Bad TZ Co", timezone: "Not/A_Zone" });

    expect(res.status).toBe(400);
    delete process.env.ADMIN_API_KEY;
  });
});

describe("rate limiting", () => {
  it("returns 429 once the admin limiter's threshold is exceeded", async () => {
    process.env.ADMIN_API_KEY = "admin-secret";
    const stores = buildStores();
    const app = express();
    app.use(express.json());
    app.use(createTenantRoutes(stores));

    let lastStatus = 200;
    for (let i = 0; i < 31; i++) {
      const res = await request(app).get("/admin/tenants").set("Authorization", "Bearer admin-secret");
      lastStatus = res.status;
    }
    expect(lastStatus).toBe(429);
    delete process.env.ADMIN_API_KEY;
  });

  it("honors LEADRECOVERY_ADMIN_RATE_LIMIT to raise the admin limiter's threshold", async () => {
    process.env.ADMIN_API_KEY = "admin-secret";
    process.env.LEADRECOVERY_ADMIN_RATE_LIMIT = "35";
    const stores = buildStores();
    const app = express();
    app.use(express.json());
    app.use(createTenantRoutes(stores));

    let lastStatus = 200;
    for (let i = 0; i < 31; i++) {
      const res = await request(app).get("/admin/tenants").set("Authorization", "Bearer admin-secret");
      lastStatus = res.status;
    }
    expect(lastStatus).toBe(200); // still under the raised limit of 35, unlike the default-30 test above
    delete process.env.ADMIN_API_KEY;
    delete process.env.LEADRECOVERY_ADMIN_RATE_LIMIT;
  });

  it("scopes the webhook limiter to /webhooks/* — it never throttles unrelated routes", async () => {
    // Regression test: createWebhookRoutes used to mount its rate limiter
    // with `router.use(createWebhookLimiter())` (no path), and since this
    // router is mounted at the app root with no prefix (see server.ts),
    // that limiter ran for every request the whole app received — health
    // checks, the dashboards, /admin/*, /leads — not just /webhooks/*,
    // sharing one 120/min-per-IP budget across all of it.
    const stores = buildStores();
    const app = express();
    app.use(createWebhookRoutes(stores));
    app.get("/health", (_req, res) => res.json({ ok: true }));

    for (let i = 0; i < 130; i++) {
      const res = await request(app).get("/health");
      expect(res.status).toBe(200);
    }

    // The webhook limiter itself is still active on its own paths.
    let lastWebhookStatus = 200;
    for (let i = 0; i < 121; i++) {
      const res = await request(app).post("/webhooks/lead").set("Authorization", `Bearer ${TENANT.apiKey}`).send({});
      lastWebhookStatus = res.status;
    }
    expect(lastWebhookStatus).toBe(429);
  });
});

describe("chatbot auto-reply on inbound messages", () => {
  const CHATBOT_TENANT: Tenant = {
    ...TENANT,
    autoReplyEnabled: true,
    knowledgeBase: "We offer callouts starting at R500. Open Mon-Fri 8am-5pm.",
  };

  function buildChatbotStores(tenant: Tenant = CHATBOT_TENANT): Stores {
    return {
      leadStore: new InMemoryLeadStore([LEAD]),
      tenantStore: new InMemoryTenantStore([tenant]),
      messageStore: new InMemoryMessageStore(),
      notificationStore: new InMemoryNotificationStore(),
      auditLogStore: new InMemoryAuditLogStore(),
    };
  }

  beforeEach(() => {
    anthropicCreateMock.mockReset();
  });

  it("sends a knowledge-base-grounded reply for a question and logs it as kind=auto_reply", async () => {
    anthropicCreateMock.mockResolvedValueOnce({
      content: [{ type: "text", text: "We're open Mon-Fri 8am-5pm!" }],
    });
    const stores = buildChatbotStores();
    const app = express();
    app.use(createWebhookRoutes(stores));

    const res = await request(app)
      .post(`/webhooks/${CHATBOT_TENANT.id}/sendgrid/email?token=${CHATBOT_TENANT.apiKey}`)
      .field("from", "Jordan <jordan@example.com>")
      .field("text", "what are your hours?");

    expect(res.status).toBe(204);
    const history = await stores.messageStore.getMessagesForLead(CHATBOT_TENANT.id, LEAD.id);
    const autoReply = history.find((m) => m.direction === "outbound");
    expect(autoReply?.kind).toBe("auto_reply");
    expect(autoReply?.body).toBe("We're open Mon-Fri 8am-5pm!");

    const lead = await stores.leadStore.getLeadById(CHATBOT_TENANT.id, LEAD.id);
    expect(lead?.status).toBe("responded");
  });

  it("survives the channel adapter throwing while sending the auto-reply instead of failing the whole webhook request", async () => {
    // Regression test: sendAndLog's adapter.send() call had no try/catch,
    // so a real provider-level error (not just {ok: false}) used to
    // propagate out of the whole inbound-webhook request.
    anthropicCreateMock.mockResolvedValueOnce({
      content: [{ type: "text", text: "We're open Mon-Fri 8am-5pm!" }],
    });
    const stores = buildChatbotStores();
    const app = express();
    app.use(createWebhookRoutes(stores));

    const { emailAdapter } = await import("../src/channels/email.js");
    const sendSpy = vi.spyOn(emailAdapter, "send").mockRejectedValueOnce(new Error("SendGrid: 401 unauthorized"));

    const res = await request(app)
      .post(`/webhooks/${CHATBOT_TENANT.id}/sendgrid/email?token=${CHATBOT_TENANT.apiKey}`)
      .field("from", "Jordan <jordan@example.com>")
      .field("text", "what are your hours?");

    expect(res.status).toBe(204);
    // Classification/status still completed even though the reply couldn't be sent.
    const lead = await stores.leadStore.getLeadById(CHATBOT_TENANT.id, LEAD.id);
    expect(lead?.status).toBe("responded");
    const history = await stores.messageStore.getMessagesForLead(CHATBOT_TENANT.id, LEAD.id);
    expect(history.some((m) => m.direction === "outbound")).toBe(false); // the failed send was never logged

    sendSpy.mockRestore();
  });

  it("notifies for a human instead of replying when the model escalates", async () => {
    anthropicCreateMock.mockResolvedValueOnce({ content: [{ type: "text", text: "ESCALATE" }] });
    const tenant: Tenant = { ...CHATBOT_TENANT, notifyWebhookUrl: "https://hooks.example.com/notify" };
    const stores = buildChatbotStores(tenant);
    const app = express();
    app.use(createWebhookRoutes(stores));
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 200 }));

    const res = await request(app)
      .post(`/webhooks/${tenant.id}/sendgrid/email?token=${tenant.apiKey}`)
      .field("from", "Jordan <jordan@example.com>")
      .field("text", "can you do it for R200 instead?");

    expect(res.status).toBe(204);
    const history = await stores.messageStore.getMessagesForLead(tenant.id, LEAD.id);
    expect(history.some((m) => m.direction === "outbound")).toBe(false); // no auto-reply sent

    // Fired via `void notifyHumanAttention(...)`, not awaited by the route —
    // wait for the spy instead of asserting immediately (see the identical
    // comment in the "notify on interested reply" describe block above).
    await vi.waitFor(() => expect(fetchSpy).toHaveBeenCalled());
    expect(fetchSpy).toHaveBeenCalledWith(
      "https://hooks.example.com/notify",
      expect.objectContaining({ method: "POST" })
    );
    // The real code always passes a JSON string as the body; cast rather than
    // String(...) it, since RequestInit["body"]'s wider type (e.g. a
    // ReadableStream) wouldn't stringify to anything meaningful.
    const body = JSON.parse(fetchSpy.mock.calls[0][1]?.body as string);
    expect(body.event).toBe("needs_human_reply");

    fetchSpy.mockRestore();
  });

  it("never calls the LLM for a not_interested reply — sends a fixed closer instead", async () => {
    const stores = buildChatbotStores();
    const app = express();
    app.use(createWebhookRoutes(stores));

    const res = await request(app)
      .post(`/webhooks/${CHATBOT_TENANT.id}/sendgrid/email?token=${CHATBOT_TENANT.apiKey}`)
      .field("from", "Jordan <jordan@example.com>")
      .field("text", "no thanks, not interested");

    expect(res.status).toBe(204);
    expect(anthropicCreateMock).not.toHaveBeenCalled();

    const history = await stores.messageStore.getMessagesForLead(CHATBOT_TENANT.id, LEAD.id);
    const closer = history.find((m) => m.direction === "outbound");
    expect(closer?.kind).toBe("closer");
    expect(closer?.body).toContain("Jordan");

    // SYSTEM_PROMPT.md STEP 4: a negative signal must suppress the lead
    // (do_not_contact is in compliance.ts's SUPPRESSED_STATUSES), not just
    // leave it at the generic "responded" every other classification gets.
    const updated = await stores.leadStore.getLeadById(CHATBOT_TENANT.id, LEAD.id);
    expect(updated?.status).toBe("do_not_contact");
  });

  it("still auto-replies with the tenant's own template when a custom notInterestedCloser is set", async () => {
    const tenant: Tenant = {
      ...CHATBOT_TENANT,
      templates: { notInterestedCloser: "All good {name}, {businessName} is here whenever you need us." },
    };
    const stores = buildChatbotStores(tenant);
    const app = express();
    app.use(createWebhookRoutes(stores));

    await request(app)
      .post(`/webhooks/${tenant.id}/sendgrid/email?token=${tenant.apiKey}`)
      .field("from", "Jordan <jordan@example.com>")
      .field("text", "not interested");

    const history = await stores.messageStore.getMessagesForLead(tenant.id, LEAD.id);
    const closer = history.find((m) => m.direction === "outbound");
    expect(closer?.body).toBe("All good Jordan, Acme Co is here whenever you need us.");
  });

  it("does not attempt an auto-reply when the tenant hasn't enabled it, even for a question", async () => {
    const stores: Stores = {
      leadStore: new InMemoryLeadStore([LEAD]),
      tenantStore: new InMemoryTenantStore([TENANT]), // autoReplyEnabled unset
      messageStore: new InMemoryMessageStore(),
      notificationStore: new InMemoryNotificationStore(),
      auditLogStore: new InMemoryAuditLogStore(),
    };
    const app = express();
    app.use(createWebhookRoutes(stores));

    const res = await request(app)
      .post(`/webhooks/${TENANT.id}/sendgrid/email?token=${TENANT.apiKey}`)
      .field("from", "Jordan <jordan@example.com>")
      .field("text", "what are your hours?");

    expect(res.status).toBe(204);
    expect(anthropicCreateMock).not.toHaveBeenCalled();
    const history = await stores.messageStore.getMessagesForLead(TENANT.id, LEAD.id);
    expect(history.some((m) => m.direction === "outbound")).toBe(false);
  });
});
