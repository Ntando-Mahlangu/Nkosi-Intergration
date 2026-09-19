import { createHmac, createSign, generateKeyPairSync } from "node:crypto";
import { EventEmitter } from "node:events";
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

// deliverNotification (src/notify.ts) goes through src/ssrf.ts's
// postToUntrustedUrl, which resolves notifyWebhookUrl's hostname itself
// (node:dns/promises) and issues the request via node:http/node:https
// directly (not fetch) so it can pin the connection to the address it
// validated — mock all three so the tests below that use
// "hooks.example.com" as a notifyWebhookUrl don't depend on real
// DNS/networking.
const lookupMock = vi.fn();
vi.mock("node:dns/promises", () => ({
  lookup: (...args: unknown[]) => lookupMock(...args),
}));

interface FakeRequestOptions {
  hostname: string;
  port: number;
  path: string;
  method: string;
  headers: Record<string, unknown>;
}
let notifyRequestStatusCode = 200;
let lastNotifyRequestOptions: FakeRequestOptions | undefined;
let lastNotifyRequestBody = "";
function fakeNotifyRequest(options: FakeRequestOptions, callback: (res: unknown) => void) {
  lastNotifyRequestOptions = options;
  const req = new EventEmitter() as EventEmitter & { end: (body?: Buffer | string) => void; destroy: () => void };
  req.end = (body?: Buffer | string) => {
    if (body) lastNotifyRequestBody = body.toString();
    const res = new EventEmitter() as EventEmitter & { statusCode: number; resume: () => void };
    res.statusCode = notifyRequestStatusCode;
    res.resume = () => {};
    queueMicrotask(() => {
      callback(res);
      res.emit("end");
    });
  };
  req.destroy = () => {};
  return req;
}
const httpRequestMock = vi.fn(fakeNotifyRequest);
const httpsRequestMock = vi.fn(fakeNotifyRequest);
vi.mock("node:http", () => ({
  default: { request: (...args: [FakeRequestOptions, (res: unknown) => void]) => httpRequestMock(...args) },
}));
vi.mock("node:https", () => ({
  default: { request: (...args: [FakeRequestOptions, (res: unknown) => void]) => httpsRequestMock(...args) },
}));

beforeEach(() => {
  lookupMock.mockReset().mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
  httpRequestMock.mockClear();
  httpsRequestMock.mockClear();
  notifyRequestStatusCode = 200;
  lastNotifyRequestOptions = undefined;
  lastNotifyRequestBody = "";
});

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

describe("admin auth middleware: multiple named keys (ADMIN_API_KEYS)", () => {
  const originalAdminKey = process.env.ADMIN_API_KEY;
  const originalAdminKeys = process.env.ADMIN_API_KEYS;

  afterEach(() => {
    if (originalAdminKey === undefined) delete process.env.ADMIN_API_KEY;
    else process.env.ADMIN_API_KEY = originalAdminKey;
    if (originalAdminKeys === undefined) delete process.env.ADMIN_API_KEYS;
    else process.env.ADMIN_API_KEYS = originalAdminKeys;
  });

  function buildApp() {
    const app = express();
    app.get("/admin-only", requireAdminAuth(), (req, res) => res.json({ adminActor: req.adminActor }));
    return app;
  }

  it("authenticates each named key and records the matching actor", async () => {
    delete process.env.ADMIN_API_KEY;
    process.env.ADMIN_API_KEYS = "alice:alice-key,bob:bob-key";
    const app = buildApp();

    const asAlice = await request(app).get("/admin-only").set("Authorization", "Bearer alice-key");
    expect(asAlice.status).toBe(200);
    expect(asAlice.body.adminActor).toBe("alice");

    const asBob = await request(app).get("/admin-only").set("Authorization", "Bearer bob-key");
    expect(asBob.status).toBe(200);
    expect(asBob.body.adminActor).toBe("bob");
  });

  it("still accepts the legacy ADMIN_API_KEY alongside named keys, recording actor 'admin'", async () => {
    process.env.ADMIN_API_KEY = "legacy-key";
    process.env.ADMIN_API_KEYS = "alice:alice-key";
    const app = buildApp();

    const legacy = await request(app).get("/admin-only").set("Authorization", "Bearer legacy-key");
    expect(legacy.status).toBe(200);
    expect(legacy.body.adminActor).toBe("admin");

    const named = await request(app).get("/admin-only").set("Authorization", "Bearer alice-key");
    expect(named.status).toBe(200);
    expect(named.body.adminActor).toBe("alice");
  });

  it("rejects a key that isn't any configured admin key", async () => {
    delete process.env.ADMIN_API_KEY;
    process.env.ADMIN_API_KEYS = "alice:alice-key";
    const app = buildApp();

    const res = await request(app).get("/admin-only").set("Authorization", "Bearer someone-elses-key");
    expect(res.status).toBe(401);
  });

  it("skips a malformed ADMIN_API_KEYS entry instead of rejecting every configured key", async () => {
    delete process.env.ADMIN_API_KEY;
    process.env.ADMIN_API_KEYS = "not-a-valid-entry,alice:alice-key";
    const app = buildApp();

    const res = await request(app).get("/admin-only").set("Authorization", "Bearer alice-key");
    expect(res.status).toBe(200);
    expect(res.body.adminActor).toBe("alice");
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

  it("lets an admin set and update a tenant's paddleSubscriptionId, for /webhooks/paddle's fallback lookup", async () => {
    process.env.ADMIN_API_KEY = "admin-secret";
    const stores = buildStores();
    const app = express();
    app.use(express.json());
    app.use(createTenantRoutes(stores));

    const created = await request(app)
      .post("/admin/tenants")
      .set("Authorization", "Bearer admin-secret")
      .send({ name: "New Biz", timezone: "Africa/Johannesburg", paddleSubscriptionId: "sub_created" });
    expect(created.status).toBe(201);
    expect(created.body.paddleSubscriptionId).toBe("sub_created");

    const patched = await request(app)
      .patch(`/admin/tenants/${created.body.id}`)
      .set("Authorization", "Bearer admin-secret")
      .send({ paddleSubscriptionId: "sub_corrected" });
    expect(patched.status).toBe(200);
    expect(patched.body.paddleSubscriptionId).toBe("sub_corrected");

    delete process.env.ADMIN_API_KEY;
  });

  it("rejects assigning a paddleSubscriptionId that's already assigned to a different tenant", async () => {
    process.env.ADMIN_API_KEY = "admin-secret";
    const stores = buildStores();
    await stores.tenantStore.updateTenant(TENANT.id, { paddleSubscriptionId: "sub_taken" });
    const app = express();
    app.use(express.json());
    app.use(createTenantRoutes(stores));

    const created = await request(app)
      .post("/admin/tenants")
      .set("Authorization", "Bearer admin-secret")
      .send({ name: "New Biz", timezone: "Africa/Johannesburg", paddleSubscriptionId: "sub_taken" });
    expect(created.status).toBe(400);
    expect(created.body.error).toMatch(/already assigned/);

    // Creating a second tenant with its own subscription, then trying to
    // PATCH it onto the one already used by TENANT, must also be rejected.
    const other = await request(app)
      .post("/admin/tenants")
      .set("Authorization", "Bearer admin-secret")
      .send({ name: "Other Biz", timezone: "UTC" });
    const patched = await request(app)
      .patch(`/admin/tenants/${other.body.id}`)
      .set("Authorization", "Bearer admin-secret")
      .send({ paddleSubscriptionId: "sub_taken" });
    expect(patched.status).toBe(400);
    expect(patched.body.error).toMatch(/already assigned/);

    delete process.env.ADMIN_API_KEY;
  });

  it("trims paddleSubscriptionId before storing and matching, so incidental whitespace can't break exact-match lookups", async () => {
    process.env.ADMIN_API_KEY = "admin-secret";
    const stores = buildStores();
    const app = express();
    app.use(express.json());
    app.use(createTenantRoutes(stores));

    const created = await request(app)
      .post("/admin/tenants")
      .set("Authorization", "Bearer admin-secret")
      .send({ name: "New Biz", timezone: "Africa/Johannesburg", paddleSubscriptionId: "  sub_padded  " });
    expect(created.status).toBe(201);
    expect(created.body.paddleSubscriptionId).toBe("sub_padded");

    // Assigning the same id with different surrounding whitespace to another
    // tenant must still be caught as a conflict against the trimmed value.
    const conflict = await request(app)
      .post("/admin/tenants")
      .set("Authorization", "Bearer admin-secret")
      .send({ name: "Other Biz", timezone: "UTC", paddleSubscriptionId: "sub_padded" });
    expect(conflict.status).toBe(400);
    expect(conflict.body.error).toMatch(/already assigned/);

    delete process.env.ADMIN_API_KEY;
  });

  it("allows an admin to clear a tenant's paddleSubscriptionId by sending null", async () => {
    process.env.ADMIN_API_KEY = "admin-secret";
    const stores = buildStores();
    await stores.tenantStore.updateTenant(TENANT.id, { paddleSubscriptionId: "sub_existing" });
    const app = express();
    app.use(express.json());
    app.use(createTenantRoutes(stores));

    const patched = await request(app)
      .patch(`/admin/tenants/${TENANT.id}`)
      .set("Authorization", "Bearer admin-secret")
      .send({ paddleSubscriptionId: null });
    expect(patched.status).toBe(200);
    expect(patched.body.paddleSubscriptionId).toBeUndefined();

    const tenant = await stores.tenantStore.getTenant(TENANT.id);
    expect(tenant?.paddleSubscriptionId).toBeUndefined();

    delete process.env.ADMIN_API_KEY;
  });
});

describe("GET /tenants/me/report", () => {
  function buildApp(stores: Stores) {
    const app = express();
    app.use(express.json());
    app.use(createTenantRoutes(stores));
    return app;
  }

  it("summarizes lead status counts and message activity", async () => {
    const stores = buildStores();
    await stores.leadStore.createLead({ ...LEAD, id: "lead-2", status: "opted_out" });
    await stores.messageStore.logMessage({
      id: "msg-out-1",
      tenantId: TENANT.id,
      leadId: LEAD.id,
      channel: "sms",
      direction: "outbound",
      body: "hi",
      at: new Date().toISOString(),
    });
    await stores.messageStore.logMessage({
      id: "msg-out-2",
      tenantId: TENANT.id,
      leadId: LEAD.id,
      channel: "email",
      direction: "outbound",
      body: "answering a question",
      at: new Date().toISOString(),
      kind: "auto_reply",
    });
    await stores.messageStore.logMessage({
      id: "msg-in-1",
      tenantId: TENANT.id,
      leadId: LEAD.id,
      channel: "sms",
      direction: "inbound",
      body: "yes please",
      at: new Date().toISOString(),
      classification: "interested",
    });
    const app = buildApp(stores);

    const res = await request(app).get("/tenants/me/report").set("Authorization", `Bearer ${TENANT.apiKey}`);

    expect(res.status).toBe(200);
    expect(res.body.leads.total).toBe(2);
    expect(res.body.leads.byStatus).toEqual({ contacted_no_response: 1, opted_out: 1 });
    expect(res.body.messages.outboundSent).toBe(2);
    expect(res.body.messages.outboundByKind).toEqual({ campaign: 1, auto_reply: 1 });
    expect(res.body.messages.inboundReceived).toBe(1);
    expect(res.body.messages.inboundByClassification).toEqual({ interested: 1 });
  });

  it("scopes message activity to the given since/until window, without affecting the lead snapshot", async () => {
    const stores = buildStores();
    await stores.messageStore.logMessage({
      id: "msg-old",
      tenantId: TENANT.id,
      leadId: LEAD.id,
      channel: "sms",
      direction: "outbound",
      body: "old",
      at: "2020-01-01T00:00:00.000Z",
    });
    await stores.messageStore.logMessage({
      id: "msg-recent",
      tenantId: TENANT.id,
      leadId: LEAD.id,
      channel: "sms",
      direction: "outbound",
      body: "recent",
      at: new Date().toISOString(),
    });
    const app = buildApp(stores);

    const res = await request(app)
      .get("/tenants/me/report")
      .query({ since: "2025-01-01T00:00:00.000Z" })
      .set("Authorization", `Bearer ${TENANT.apiKey}`);

    expect(res.status).toBe(200);
    expect(res.body.messages.outboundSent).toBe(1); // only "recent" is inside the window
    expect(res.body.leads.total).toBe(1); // unaffected by the date filter
  });

  it("rejects an invalid since/until value", async () => {
    const app = buildApp(buildStores());
    const res = await request(app)
      .get("/tenants/me/report")
      .query({ since: "not-a-date" })
      .set("Authorization", `Bearer ${TENANT.apiKey}`);
    expect(res.status).toBe(400);
  });

  it("requires tenant auth", async () => {
    const app = buildApp(buildStores());
    const res = await request(app).get("/tenants/me/report");
    expect(res.status).toBe(401);
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
    // In an afterEach (not just at the end of the one test that sets it) so
    // ADMIN_API_KEYS is cleaned up even if an assertion earlier in that test
    // throws — otherwise it leaks into every later test in this file.
    delete process.env.ADMIN_API_KEY;
    delete process.env.ADMIN_API_KEYS;
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

  it("records which named admin key (ADMIN_API_KEYS) performed an action, not just a generic 'admin'", async () => {
    delete process.env.ADMIN_API_KEY;
    process.env.ADMIN_API_KEYS = "alice:alice-key";
    const stores = buildStores();
    const app = express();
    app.use(express.json());
    app.use(createTenantRoutes(stores));

    const created = await request(app)
      .post("/admin/tenants")
      .set("Authorization", "Bearer alice-key")
      .send({ name: "New Biz", timezone: "Africa/Johannesburg" });
    expect(created.status).toBe(201);

    const log = await request(app).get("/admin/audit-log").set("Authorization", "Bearer alice-key");
    expect(log.body[0].actor).toBe("alice");
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

  it("reuses the existing lead for a repeat delivery with the same phone, instead of creating a duplicate row", async () => {
    // Regression test: a CRM/Zapier/Make automation retrying a delivery (or
    // two automations both notifying LeadRecovery about the same person)
    // used to always create a brand-new Lead row. Two separate rows sharing
    // one phone number is a compliance problem, not just clutter: a STOP
    // reply only ever updates the row Twilio's inbound webhook looked up by
    // phone, leaving the other row's status stuck at "new" and fully
    // contactable by the recovery workflow — see compliance.ts's
    // SUPPRESSED_STATUSES, which is tracked per lead row.
    const stores = buildStores();
    const app = express();
    app.use(createWebhookRoutes(stores));

    const first = await request(app)
      .post("/webhooks/lead")
      .set("Authorization", `Bearer ${TENANT.apiKey}`)
      .send({ name: "Repeat Lead", phone: "+27820000099", requestedService: "quote" });
    expect(first.status).toBe(201);

    const second = await request(app)
      .post("/webhooks/lead")
      .set("Authorization", `Bearer ${TENANT.apiKey}`)
      .send({ name: "Repeat Lead", phone: "+27820000099", requestedService: "updated quote", notes: "called back" });
    expect(second.status).toBe(200);
    expect(second.body.id).toBe(first.body.id);
    expect(second.body.requestedService).toBe("updated quote");
    expect(second.body.notes).toBe("called back");

    const all = await stores.leadStore.getAllLeads(TENANT.id);
    expect(all.filter((l) => l.phone === "+27820000099")).toHaveLength(1);
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

describe("webhook: Paddle billing", () => {
  const PADDLE_SECRET = "pdl_ntfset_test_secret";
  const originalPaddleSecret = process.env.PADDLE_WEBHOOK_SECRET;

  function signPaddle(rawBody: string): { header: string; timestamp: string } {
    const timestamp = String(Math.floor(Date.now() / 1000));
    const hash = createHmac("sha256", PADDLE_SECRET).update(`${timestamp}:${rawBody}`).digest("hex");
    return { header: `ts=${timestamp};h1=${hash}`, timestamp };
  }

  beforeEach(() => {
    process.env.PADDLE_WEBHOOK_SECRET = PADDLE_SECRET;
  });

  afterEach(() => {
    if (originalPaddleSecret === undefined) delete process.env.PADDLE_WEBHOOK_SECRET;
    else process.env.PADDLE_WEBHOOK_SECRET = originalPaddleSecret;
  });

  it("returns 503 when PADDLE_WEBHOOK_SECRET isn't configured", async () => {
    delete process.env.PADDLE_WEBHOOK_SECRET;
    const stores = buildStores();
    const app = express();
    app.use(createWebhookRoutes(stores));

    const res = await request(app).post("/webhooks/paddle").send({});
    expect(res.status).toBe(503);
  });

  it("rejects a missing or invalid signature", async () => {
    const stores = buildStores();
    const app = express();
    app.use(createWebhookRoutes(stores));

    const rawBody = JSON.stringify({ event_type: "subscription.canceled", data: { id: "sub_1" } });
    const noSig = await request(app).post("/webhooks/paddle").set("Content-Type", "application/json").send(rawBody);
    expect(noSig.status).toBe(403);

    const badSig = await request(app)
      .post("/webhooks/paddle")
      .set("Content-Type", "application/json")
      .set("Paddle-Signature", "ts=123;h1=deadbeef")
      .send(rawBody);
    expect(badSig.status).toBe(403);
  });

  it("suspends the tenant matched by custom_data.tenantId on subscription.canceled, and records an audit entry", async () => {
    const stores = buildStores();
    const app = express();
    app.use(createWebhookRoutes(stores));

    const rawBody = JSON.stringify({
      event_type: "subscription.canceled",
      data: { id: "sub_abc123", custom_data: { tenantId: TENANT.id } },
    });
    const { header } = signPaddle(rawBody);

    const res = await request(app)
      .post("/webhooks/paddle")
      .set("Content-Type", "application/json")
      .set("Paddle-Signature", header)
      .send(rawBody);

    expect(res.status).toBe(204);
    const tenant = await stores.tenantStore.getTenant(TENANT.id);
    expect(tenant?.status).toBe("suspended");
    // Self-heals the fallback mapping for future events that lack custom_data.
    expect(tenant?.paddleSubscriptionId).toBe("sub_abc123");

    const entries = await stores.auditLogStore.list({ limit: 10, offset: 0 });
    const entry = entries.find((e) => e.action === "tenant.paddle_status_change");
    expect(entry?.actor).toBe("paddle");
    expect(entry?.tenantId).toBe(TENANT.id);
  });

  it("reactivates a suspended tenant on subscription.activated", async () => {
    const stores = buildStores();
    await stores.tenantStore.updateTenant(TENANT.id, { status: "suspended" });
    const app = express();
    app.use(createWebhookRoutes(stores));

    const rawBody = JSON.stringify({
      event_type: "subscription.activated",
      data: { id: "sub_abc123", custom_data: { tenantId: TENANT.id } },
    });
    const { header } = signPaddle(rawBody);

    const res = await request(app)
      .post("/webhooks/paddle")
      .set("Content-Type", "application/json")
      .set("Paddle-Signature", header)
      .send(rawBody);

    expect(res.status).toBe(204);
    const tenant = await stores.tenantStore.getTenant(TENANT.id);
    expect(tenant?.status).toBe("active");
  });

  it("suspends via a transaction event's data.subscription_id, matched against the tenant's stored paddleSubscriptionId (no custom_data needed)", async () => {
    const stores = buildStores();
    await stores.tenantStore.updateTenant(TENANT.id, { paddleSubscriptionId: "sub_xyz789" });
    const app = express();
    app.use(createWebhookRoutes(stores));

    // transaction.* events carry the subscription id as `subscription_id`,
    // not `id` (which is the transaction's own id) — and, unlike the tests
    // above, this payload has no custom_data at all, exercising the
    // paddleSubscriptionId fallback lookup.
    const rawBody = JSON.stringify({
      event_type: "transaction.payment_failed",
      data: { id: "txn_1", subscription_id: "sub_xyz789" },
    });
    const { header } = signPaddle(rawBody);

    const res = await request(app)
      .post("/webhooks/paddle")
      .set("Content-Type", "application/json")
      .set("Paddle-Signature", header)
      .send(rawBody);

    expect(res.status).toBe(204);
    const tenant = await stores.tenantStore.getTenant(TENANT.id);
    expect(tenant?.status).toBe("suspended");
  });

  it("ignores an event type it doesn't act on, without changing tenant status", async () => {
    const stores = buildStores();
    const app = express();
    app.use(createWebhookRoutes(stores));

    const rawBody = JSON.stringify({
      event_type: "subscription.created",
      data: { id: "sub_abc123", custom_data: { tenantId: TENANT.id } },
    });
    const { header } = signPaddle(rawBody);

    const res = await request(app)
      .post("/webhooks/paddle")
      .set("Content-Type", "application/json")
      .set("Paddle-Signature", header)
      .send(rawBody);

    expect(res.status).toBe(204);
    const tenant = await stores.tenantStore.getTenant(TENANT.id);
    expect(tenant?.status).not.toBe("suspended"); // unchanged — never suspended in the first place
  });

  it("safely no-ops when no tenant matches (no custom_data, no stored paddleSubscriptionId anywhere)", async () => {
    const stores = buildStores();
    const app = express();
    app.use(createWebhookRoutes(stores));

    const rawBody = JSON.stringify({
      event_type: "subscription.canceled",
      data: { id: "sub_unrelated" },
    });
    const { header } = signPaddle(rawBody);

    const res = await request(app)
      .post("/webhooks/paddle")
      .set("Content-Type", "application/json")
      .set("Paddle-Signature", header)
      .send(rawBody);

    expect(res.status).toBe(204);
    const tenant = await stores.tenantStore.getTenant(TENANT.id);
    expect(tenant?.status).not.toBe("suspended"); // the one real tenant is untouched
  });

  it("ignores a delayed/out-of-order event instead of undoing a newer status change", async () => {
    // Regression test for exactly the hazard Paddle's own docs warn about:
    // webhook delivery can arrive out of order. A newer subscription.activated
    // (occurred_at t2) is processed first; a slower subscription.past_due
    // (occurred_at t1, earlier) for the same subscription arrives after —
    // without checking occurred_at, this would incorrectly re-suspend an
    // otherwise-current tenant.
    const stores = buildStores();
    const app = express();
    app.use(createWebhookRoutes(stores));

    const t1 = new Date(Date.now() - 60_000).toISOString();
    const t2 = new Date().toISOString();

    const newerBody = JSON.stringify({
      event_type: "subscription.activated",
      occurred_at: t2,
      data: { id: "sub_abc123", custom_data: { tenantId: TENANT.id } },
    });
    const { header: newerHeader } = signPaddle(newerBody);
    const newerRes = await request(app)
      .post("/webhooks/paddle")
      .set("Content-Type", "application/json")
      .set("Paddle-Signature", newerHeader)
      .send(newerBody);
    expect(newerRes.status).toBe(204);
    expect((await stores.tenantStore.getTenant(TENANT.id))?.status).not.toBe("suspended");

    const staleBody = JSON.stringify({
      event_type: "subscription.past_due",
      occurred_at: t1,
      data: { id: "sub_abc123", custom_data: { tenantId: TENANT.id } },
    });
    const { header: staleHeader } = signPaddle(staleBody);
    const staleRes = await request(app)
      .post("/webhooks/paddle")
      .set("Content-Type", "application/json")
      .set("Paddle-Signature", staleHeader)
      .send(staleBody);

    expect(staleRes.status).toBe(204); // still acknowledged — just not acted on
    const tenant = await stores.tenantStore.getTenant(TENANT.id);
    expect(tenant?.status).not.toBe("suspended"); // the stale event must not win
  });

  it("orders occurred_at via compareIsoTimestamps, not raw string comparison or Date.parse, so a later microsecond-precision event isn't misclassified as stale", async () => {
    // Regression test: a stored paddleLastEventAt of "...972Z" (millisecond
    // precision) and a fresh incoming occurred_at of "...972196Z" (six
    // microseconds later, same millisecond) sort as occurredAt < lastEventAt
    // under plain string comparison (the digit '1' sorts below 'Z' once the
    // strings differ in length), which would wrongly drop this genuinely
    // newer event as "stale". Date.parse() gets this wrong too — it only has
    // millisecond resolution, so it truncates both timestamps to the same
    // instant. compareIsoTimestamps (src/paddleVerify.ts) is what actually
    // gets this right, by padding the fractional-second digits to equal
    // length before comparing as strings.
    const stores = buildStores();
    await stores.tenantStore.updateTenant(TENANT.id, {
      paddleSubscriptionId: "sub_abc123",
      paddleLastEventAt: "2023-06-01T13:47:47.972Z",
    });
    const app = express();
    app.use(createWebhookRoutes(stores));

    const rawBody = JSON.stringify({
      event_type: "subscription.canceled",
      occurred_at: "2023-06-01T13:47:47.972196Z",
      data: { id: "sub_abc123", custom_data: { tenantId: TENANT.id } },
    });
    const { header } = signPaddle(rawBody);

    const res = await request(app)
      .post("/webhooks/paddle")
      .set("Content-Type", "application/json")
      .set("Paddle-Signature", header)
      .send(rawBody);

    expect(res.status).toBe(204);
    const tenant = await stores.tenantStore.getTenant(TENANT.id);
    expect(tenant?.status).toBe("suspended"); // must be applied, not dropped as stale
  });

  it("still applies a subscription rebind (a different subscription id for the same tenant) rather than rejecting it", async () => {
    // A tenant legitimately getting a new subscription (upgrade, cancel and
    // resubscribe) looks identical to an operator mistake at the data layer
    // — this codebase accepts the rebind (and only warns), since rejecting
    // it would break the legitimate case.
    const stores = buildStores();
    await stores.tenantStore.updateTenant(TENANT.id, { paddleSubscriptionId: "sub_original" });
    const app = express();
    app.use(createWebhookRoutes(stores));

    const rawBody = JSON.stringify({
      event_type: "subscription.canceled",
      data: { id: "sub_replacement", custom_data: { tenantId: TENANT.id } },
    });
    const { header } = signPaddle(rawBody);

    const res = await request(app)
      .post("/webhooks/paddle")
      .set("Content-Type", "application/json")
      .set("Paddle-Signature", header)
      .send(rawBody);

    expect(res.status).toBe(204);
    const tenant = await stores.tenantStore.getTenant(TENANT.id);
    expect(tenant?.status).toBe("suspended");
    expect(tenant?.paddleSubscriptionId).toBe("sub_replacement");
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

  it("validates a WhatsApp reply's signature against the whatsapp token when it differs from the sms token", async () => {
    // Regression test: a tenant can configure independent Twilio credentials
    // per channel (e.g. a separate (sub)account for WhatsApp), but this
    // route is shared by both channels. It used to pick whichever of
    // channels.sms/channels.whatsapp came first (sms, when both are set) and
    // validate every request's signature against only that one token — so a
    // genuine WhatsApp request, signed with the whatsapp token, would fail
    // signature verification and get 403'd whenever the two tokens differ.
    vi.spyOn(twilio, "validateRequest").mockImplementation((token) => token === "whatsapp-token");
    const tenant: Tenant = {
      ...TENANT,
      channels: {
        sms: { accountSid: "AC1", authToken: "sms-token", fromNumber: "+15550000" },
        whatsapp: { accountSid: "AC1", authToken: "whatsapp-token", fromNumber: "+15550000" },
      },
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
    const updated = await stores.leadStore.getLeadById(tenant.id, LEAD.id);
    expect(updated?.status).toBe("opted_out");
  });

  it("still 403s when neither configured token validates the signature", async () => {
    vi.spyOn(twilio, "validateRequest").mockReturnValue(false);
    const tenant: Tenant = {
      ...TENANT,
      channels: {
        sms: { accountSid: "AC1", authToken: "sms-token", fromNumber: "+15550000" },
        whatsapp: { accountSid: "AC1", authToken: "whatsapp-token", fromNumber: "+15550000" },
      },
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
      .send({ From: LEAD.phone, Body: "STOP" });

    expect(res.status).toBe(403);
  });
});

describe("webhook: a suspended tenant is fully paused, not just blocked from the tenant API", () => {
  // Regression tests: PATCH /admin/tenants/:id {"status":"suspended"} (see
  // ONBOARDING.md "Pausing or offboarding a client") is documented as
  // blocking "all of that tenant's API/webhook auth — including inbound
  // replies" — but none of these five routes ever checked tenant.status at
  // all, so a suspended tenant's inbound Twilio/SendGrid traffic kept being
  // classified, auto-replied to, and notified on exactly as if nothing had
  // changed.
  afterEach(() => {
    vi.restoreAllMocks();
  });

  function suspendedTenant(overrides: Partial<Tenant> = {}): Tenant {
    return { ...TENANT, status: "suspended", ...overrides };
  }

  it("twilio/sms: does not classify, reply to, or opt out a lead", async () => {
    vi.spyOn(twilio, "validateRequest").mockReturnValue(true);
    const tenant = suspendedTenant({ channels: { sms: { accountSid: "AC1", authToken: "tok", fromNumber: "+1" } } });
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
      .send({ From: LEAD.phone, Body: "STOP" });

    expect(res.status).toBe(200); // still a clean TwiML response — never surfaces suspension to Twilio
    const updated = await stores.leadStore.getLeadById(tenant.id, LEAD.id);
    expect(updated?.status).toBe(LEAD.status); // untouched
    expect(await stores.messageStore.getMessagesForLead(tenant.id, LEAD.id)).toHaveLength(0);
  });

  it("twilio/voice-status: does not create or update a lead for a missed call", async () => {
    vi.spyOn(twilio, "validateRequest").mockReturnValue(true);
    const tenant = suspendedTenant({ channels: { sms: { accountSid: "AC1", authToken: "tok", fromNumber: "+1" } } });
    const stores: Stores = {
      leadStore: new InMemoryLeadStore([]),
      tenantStore: new InMemoryTenantStore([tenant]),
      messageStore: new InMemoryMessageStore(),
      notificationStore: new InMemoryNotificationStore(),
      auditLogStore: new InMemoryAuditLogStore(),
    };
    const app = express();
    app.use(createWebhookRoutes(stores));

    const res = await request(app)
      .post(`/webhooks/${tenant.id}/twilio/voice-status`)
      .type("form")
      .send({ From: "+27820000099", CallStatus: "no-answer" });

    expect(res.status).toBe(204);
    expect(await stores.leadStore.getAllLeads(tenant.id)).toHaveLength(0);
  });

  it("twilio/status: does not update delivery status", async () => {
    vi.spyOn(twilio, "validateRequest").mockReturnValue(true);
    const tenant = suspendedTenant({ channels: { sms: { accountSid: "AC1", authToken: "tok", fromNumber: "+1" } } });
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
      channel: "sms",
      direction: "outbound",
      body: "hi",
      at: new Date().toISOString(),
    });
    const app = express();
    app.use(createWebhookRoutes(stores));

    const res = await request(app)
      .post(`/webhooks/${tenant.id}/twilio/status?messageId=msg-1`)
      .type("form")
      .send({ MessageStatus: "delivered" });

    expect(res.status).toBe(204);
    const [message] = await stores.messageStore.getMessagesForLead(tenant.id, LEAD.id);
    expect(message.deliveryStatus).toBeUndefined();
  });

  it("sendgrid/email: does not classify or auto-reply", async () => {
    const tenant = suspendedTenant();
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
      .post(`/webhooks/${tenant.id}/sendgrid/email?token=${tenant.apiKey}`)
      .field("from", "Jordan <jordan@example.com>")
      .field("text", "please STOP emailing me");

    expect(res.status).toBe(204);
    const updated = await stores.leadStore.getLeadById(tenant.id, LEAD.id);
    expect(updated?.status).toBe(LEAD.status);
    expect(await stores.messageStore.getMessagesForLead(tenant.id, LEAD.id)).toHaveLength(0);
  });

  it("sendgrid/events: does not update delivery status", async () => {
    const tenant = suspendedTenant();
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

    const res = await request(app)
      .post(`/webhooks/${tenant.id}/sendgrid/events?token=${tenant.apiKey}`)
      .send([{ event: "delivered", leadrecovery_message_id: "msg-1" }]);

    expect(res.status).toBe(204);
    const [message] = await stores.messageStore.getMessagesForLead(tenant.id, LEAD.id);
    expect(message.deliveryStatus).toBeUndefined();
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

    const res = await request(app)
      .post(`/webhooks/${TENANT.id}/sendgrid/email?token=${TENANT.apiKey}`)
      .field("from", "Jordan <jordan@example.com>")
      .field("text", "yes please, sounds good");

    expect(res.status).toBe(204);
    // The webhook route fires this notification via `void notifyHumanAttention(...)`
    // (see src/webhooks/index.ts) — deliberately not awaited, so the response
    // isn't held up by a slow/unreachable notification target. Wait for the
    // mock rather than asserting immediately: nothing guarantees the request
    // inside it has actually run by the time the HTTP response resolves.
    await vi.waitFor(() => expect(httpsRequestMock).toHaveBeenCalled());
    expect(lastNotifyRequestOptions?.hostname).toBe("hooks.example.com");
    expect(lastNotifyRequestOptions?.method).toBe("POST");
    const body = JSON.parse(lastNotifyRequestBody);
    expect(body.event).toBe("lead_interested");
    expect(body.lead.id).toBe(LEAD.id);
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

    lookupMock.mockReset().mockRejectedValue(new Error("network down"));

    const res = await request(app)
      .post(`/webhooks/${TENANT.id}/sendgrid/email?token=${TENANT.apiKey}`)
      .field("from", "Jordan <jordan@example.com>")
      .field("text", "yes please");

    expect(res.status).toBe(204);
    const lead = await stores.leadStore.getLeadById(TENANT.id, LEAD.id);
    expect(lead?.status).toBe("responded");
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

  it("rejects a notifyWebhookUrl pointing at localhost or an internal/reserved IP (SSRF)", async () => {
    // Regression test: notifyWebhookUrl is entirely tenant-controlled and
    // this server later makes a real outbound POST to it — without this,
    // a tenant (or anyone holding a leaked tenant API key) could point it
    // at a cloud metadata endpoint or an internal service. See src/ssrf.ts.
    const stores = buildStores();
    const app = express();
    app.use(express.json());
    app.use(createTenantRoutes(stores));

    for (const url of [
      "http://localhost/hook",
      "http://127.0.0.1/hook",
      "http://169.254.169.254/latest/meta-data/",
      "http://10.0.0.5/hook",
      "http://192.168.1.1/hook",
      "http://[::1]/hook",
    ]) {
      const res = await request(app)
        .patch("/tenants/me")
        .set("Authorization", `Bearer ${TENANT.apiKey}`)
        .send({ notifyWebhookUrl: url });
      expect(res.status, `expected ${url} to be rejected`).toBe(400);
    }
  });

  it("rejects an empty-string template override instead of silently sending a blank message", async () => {
    // Regression test: messaging.ts's own `tenant.templates?.x ?? DEFAULT`
    // fallback only kicks in for null/undefined, never for an explicitly-set
    // "" — an unvalidated empty template would silently send a blank
    // SMS/WhatsApp/email with no message body and, critically, no "Reply
    // STOP" opt-out line.
    const stores = buildStores();
    const app = express();
    app.use(express.json());
    app.use(createTenantRoutes(stores));

    const res = await request(app)
      .patch("/tenants/me")
      .set("Authorization", `Bearer ${TENANT.apiKey}`)
      .send({ templates: { initialGrounded: "" } });

    expect(res.status).toBe(400);
  });

  it("rejects a non-string template override", async () => {
    const stores = buildStores();
    const app = express();
    app.use(express.json());
    app.use(createTenantRoutes(stores));

    const res = await request(app)
      .patch("/tenants/me")
      .set("Authorization", `Bearer ${TENANT.apiKey}`)
      .send({ templates: { notInterestedCloser: 12345 } });

    expect(res.status).toBe(400);
  });

  it("rejects a followUps entry that isn't a non-empty string", async () => {
    const stores = buildStores();
    const app = express();
    app.use(express.json());
    app.use(createTenantRoutes(stores));

    const res = await request(app)
      .patch("/tenants/me")
      .set("Authorization", `Bearer ${TENANT.apiKey}`)
      .send({ templates: { followUps: ["a real follow-up", ""] } });

    expect(res.status).toBe(400);
  });

  it("accepts a valid template override", async () => {
    const stores = buildStores();
    const app = express();
    app.use(express.json());
    app.use(createTenantRoutes(stores));

    const res = await request(app)
      .patch("/tenants/me")
      .set("Authorization", `Bearer ${TENANT.apiKey}`)
      .send({ templates: { initialGrounded: "Hi {name}, {reason}. Reply STOP to opt out." } });

    expect(res.status).toBe(200);
    expect(res.body.templates.initialGrounded).toBe("Hi {name}, {reason}. Reply STOP to opt out.");
  });

  it("accepts templates: null as clearing overrides back to defaults, not an invalid value", async () => {
    // Regression test: null is already treated the same as undefined by
    // every actual read of tenant.templates (they all use `?.`), so
    // {"templates": null} worked as a way to reset overrides before
    // isValidTemplates existed. Rejecting it would be a new restriction
    // this validation-only change introduced, not an intentional one.
    const stores = buildStores();
    const app = express();
    app.use(express.json());
    app.use(createTenantRoutes(stores));

    await request(app)
      .patch("/tenants/me")
      .set("Authorization", `Bearer ${TENANT.apiKey}`)
      .send({ templates: { initialGrounded: "custom" } });

    const res = await request(app)
      .patch("/tenants/me")
      .set("Authorization", `Bearer ${TENANT.apiKey}`)
      .send({ templates: null });

    expect(res.status).toBe(200);
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

  it("refuses to let a tenant set its own paddleSubscriptionId", async () => {
    // Same reasoning as status above: a tenant setting this itself could
    // let it get matched (and have its status flipped) by a *different*
    // tenant's Paddle events whenever those happen to omit
    // custom_data.tenantId — see /webhooks/paddle's fallback lookup.
    const stores = buildStores();
    const app = express();
    app.use(express.json());
    app.use(createTenantRoutes(stores));

    const res = await request(app)
      .patch("/tenants/me")
      .set("Authorization", `Bearer ${TENANT.apiKey}`)
      .send({ paddleSubscriptionId: "sub_hijack" });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/admin API/);
    const tenant = await stores.tenantStore.getTenant(TENANT.id);
    expect(tenant?.paddleSubscriptionId).toBeUndefined();
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

    const res = await request(app)
      .post(`/webhooks/${tenant.id}/sendgrid/email?token=${tenant.apiKey}`)
      .field("from", "Jordan <jordan@example.com>")
      .field("text", "can you do it for R200 instead?");

    expect(res.status).toBe(204);
    const history = await stores.messageStore.getMessagesForLead(tenant.id, LEAD.id);
    expect(history.some((m) => m.direction === "outbound")).toBe(false); // no auto-reply sent

    // Fired via `void notifyHumanAttention(...)`, not awaited by the route —
    // wait for the mock instead of asserting immediately (see the identical
    // comment in the "notify on interested reply" describe block above).
    await vi.waitFor(() => expect(httpsRequestMock).toHaveBeenCalled());
    expect(lastNotifyRequestOptions?.hostname).toBe("hooks.example.com");
    expect(lastNotifyRequestOptions?.method).toBe("POST");
    const body = JSON.parse(lastNotifyRequestBody);
    expect(body.event).toBe("needs_human_reply");
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
