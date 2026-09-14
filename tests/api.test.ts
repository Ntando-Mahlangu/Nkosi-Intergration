import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import request from "supertest";
import express from "express";
import { InMemoryLeadStore, InMemoryMessageStore, InMemoryTenantStore } from "../src/store/memory.js";
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
      .send([{ event: "delivered", leadrecovery_message_id: "msg-1" }, { event: "open", leadrecovery_message_id: "msg-1" }]);

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

describe("notify on interested reply", () => {
  it("POSTs to the tenant's notifyWebhookUrl when a reply classifies as interested", async () => {
    const tenantWithHook: Tenant = { ...TENANT, notifyWebhookUrl: "https://hooks.example.com/notify" };
    const stores: Stores = {
      leadStore: new InMemoryLeadStore([LEAD]),
      tenantStore: new InMemoryTenantStore([tenantWithHook]),
      messageStore: new InMemoryMessageStore(),
    };
    const app = express();
    app.use(createWebhookRoutes(stores));

    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 200 }));

    const res = await request(app)
      .post(`/webhooks/${TENANT.id}/sendgrid/email?token=${TENANT.apiKey}`)
      .field("from", "Jordan <jordan@example.com>")
      .field("text", "yes please, sounds good");

    expect(res.status).toBe(204);
    expect(fetchSpy).toHaveBeenCalledWith(
      "https://hooks.example.com/notify",
      expect.objectContaining({ method: "POST" })
    );
    const body = JSON.parse(String(fetchSpy.mock.calls[0][1]?.body));
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
    app.use(createTenantRoutes(stores.tenantStore));

    const res = await request(app)
      .patch("/tenants/me")
      .set("Authorization", `Bearer ${TENANT.apiKey}`)
      .send({ timezone: "America/New_York", quietHours: { startHour: 21, endHour: 7 }, notifyWebhookUrl: "https://x.example.com/hook" });

    expect(res.status).toBe(200);
    expect(res.body.timezone).toBe("America/New_York");
    expect(res.body.quietHours).toEqual({ startHour: 21, endHour: 7 });
  });

  it("rejects an invalid timezone", async () => {
    const stores = buildStores();
    const app = express();
    app.use(express.json());
    app.use(createTenantRoutes(stores.tenantStore));

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
    app.use(createTenantRoutes(stores.tenantStore));

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
    app.use(createTenantRoutes(stores.tenantStore));

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
    app.use(createTenantRoutes(stores.tenantStore));

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
    app.use(createTenantRoutes(stores.tenantStore));

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
    app.use(createTenantRoutes(stores.tenantStore));

    const res = await request(app)
      .patch("/tenants/me")
      .set("Authorization", `Bearer ${TENANT.apiKey}`)
      .send({ knowledgeBase: "x".repeat(20_001) });

    expect(res.status).toBe(400);
  });
});

describe("admin tenant creation validation", () => {
  it("rejects an invalid timezone", async () => {
    process.env.ADMIN_API_KEY = "admin-secret";
    const stores = buildStores();
    const app = express();
    app.use(express.json());
    app.use(createTenantRoutes(stores.tenantStore));

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
    app.use(createTenantRoutes(stores.tenantStore));

    let lastStatus = 200;
    for (let i = 0; i < 31; i++) {
      const res = await request(app).get("/admin/tenants").set("Authorization", "Bearer admin-secret");
      lastStatus = res.status;
    }
    expect(lastStatus).toBe(429);
    delete process.env.ADMIN_API_KEY;
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

    expect(fetchSpy).toHaveBeenCalledWith("https://hooks.example.com/notify", expect.objectContaining({ method: "POST" }));
    const body = JSON.parse(String(fetchSpy.mock.calls[0][1]?.body));
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
