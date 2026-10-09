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
import { createPublicChatRoutes } from "../src/routes/publicChat.js";
import { CURRENT_TERMS_VERSION } from "../src/terms.js";
import type { Tenant } from "../src/types.js";
import type { Stores } from "../src/store/index.js";

const TENANT: Tenant = {
  id: "tenant-1",
  name: "Acme Co",
  apiKey: "test-api-key",
  timezone: "UTC",
  devMode: true,
  channels: {},
  publicFormKey: "lrf_test_form_key",
  termsAcceptedAt: new Date().toISOString(),
  termsVersion: CURRENT_TERMS_VERSION,
  createdAt: new Date().toISOString(),
};

function buildStores(tenant: Tenant = TENANT): Stores {
  return {
    leadStore: new InMemoryLeadStore([]),
    tenantStore: new InMemoryTenantStore([tenant]),
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
  app.use(createPublicChatRoutes(stores));
  return app;
}

async function startChat(app: ReturnType<typeof buildApp>, overrides: Record<string, unknown> = {}) {
  const res = await request(app)
    .post(`/public/chat/${TENANT.id}/start`)
    .send({ formKey: TENANT.publicFormKey, name: "Jordan", ...overrides });
  return res;
}

describe("POST /public/chat/:tenantId/start", () => {
  it("creates a lead and returns a leadId + chatToken", async () => {
    const stores = buildStores();
    const app = buildApp(stores);

    const res = await startChat(app);
    expect(res.status).toBe(201);
    expect(res.body.leadId).toBeTruthy();
    expect(res.body.chatToken).toBeTruthy();

    const lead = await stores.leadStore.getLeadById(TENANT.id, res.body.leadId);
    expect(lead?.source).toBe("chat");
    expect(lead?.status).toBe("new");
    expect(lead?.name).toBe("Jordan");
    expect(lead?.chatTokenHash).toBeTruthy();
    expect(lead?.chatTokenHash).not.toBe(res.body.chatToken); // never stores the raw token
  });

  it("rejects a wrong or missing formKey", async () => {
    const stores = buildStores();
    const app = buildApp(stores);

    const res = await request(app).post(`/public/chat/${TENANT.id}/start`).send({ formKey: "wrong" });
    expect(res.status).toBe(401);
  });

  it("rejects a suspended tenant", async () => {
    const stores = buildStores({ ...TENANT, status: "suspended" });
    const app = buildApp(stores);

    const res = await startChat(app);
    expect(res.status).toBe(403);
  });

  it("works with no contact info at all — an anonymous visitor can still chat", async () => {
    const stores = buildStores();
    const app = buildApp(stores);

    const res = await request(app).post(`/public/chat/${TENANT.id}/start`).send({ formKey: TENANT.publicFormKey });
    expect(res.status).toBe(201);
  });
});

describe("POST /public/chat/:tenantId/message", () => {
  it("escalates a question to a human instead of ever auto-answering it", async () => {
    const stores = buildStores();
    const app = buildApp(stores);
    const { body: session } = await startChat(app);

    const res = await request(app).post(`/public/chat/${TENANT.id}/message`).send({
      formKey: TENANT.publicFormKey,
      leadId: session.leadId,
      chatToken: session.chatToken,
      body: "what are your hours?",
    });

    expect(res.status).toBe(200);
    expect(res.body.displayText).toMatch(/follow up/i);
    expect(res.body.classification).toBe("question");

    const history = await stores.messageStore.getMessagesForLead(TENANT.id, session.leadId);
    expect(history).toHaveLength(1); // only the inbound message — no automated reply sent
    expect(history[0]).toMatchObject({ direction: "inbound", channel: "chat" });

    const lead = await stores.leadStore.getLeadById(TENANT.id, session.leadId);
    expect(lead?.status).toBe("responded");
    expect(lead?.needsAttentionAt).toBeTruthy();
    expect(lead?.needsAttentionReason).toBe("needs_human_reply");
  });

  it("rejects a wrong chatToken — one visitor can't post into another's conversation", async () => {
    const stores = buildStores();
    const app = buildApp(stores);
    const { body: session } = await startChat(app);

    const res = await request(app).post(`/public/chat/${TENANT.id}/message`).send({
      formKey: TENANT.publicFormKey,
      leadId: session.leadId,
      chatToken: "not-the-real-token",
      body: "hello",
    });
    expect(res.status).toBe(401);
  });

  it("rejects a message with no body", async () => {
    const stores = buildStores();
    const app = buildApp(stores);
    const { body: session } = await startChat(app);

    const res = await request(app).post(`/public/chat/${TENANT.id}/message`).send({
      formKey: TENANT.publicFormKey,
      leadId: session.leadId,
      chatToken: session.chatToken,
      body: "   ",
    });
    expect(res.status).toBe(400);
  });

  it("stops the conversation and flips the lead opted_out on a STOP reply", async () => {
    const stores = buildStores();
    const app = buildApp(stores);
    const { body: session } = await startChat(app);

    const res = await request(app).post(`/public/chat/${TENANT.id}/message`).send({
      formKey: TENANT.publicFormKey,
      leadId: session.leadId,
      chatToken: session.chatToken,
      body: "STOP",
    });

    expect(res.status).toBe(200);
    expect(res.body.classification).toBe("stop");
    const lead = await stores.leadStore.getLeadById(TENANT.id, session.leadId);
    expect(lead?.status).toBe("opted_out");
  });

  it("notifies the tenant's team and shows a hand-off notice for an interested reply, never fabricating a bot answer", async () => {
    const stores = buildStores();
    const app = buildApp(stores);
    const { body: session } = await startChat(app);

    const res = await request(app).post(`/public/chat/${TENANT.id}/message`).send({
      formKey: TENANT.publicFormKey,
      leadId: session.leadId,
      chatToken: session.chatToken,
      body: "yes I'm interested, sign me up",
    });

    expect(res.status).toBe(200);
    expect(res.body.classification).toBe("interested");
    expect(res.body.displayText).toMatch(/follow up/i);

    const lead = await stores.leadStore.getLeadById(TENANT.id, session.leadId);
    expect(lead?.needsAttentionAt).toBeTruthy();
    expect(lead?.needsAttentionReason).toBe("interested");
  });

  it("refuses to run for a tenant that hasn't accepted the Terms of Service yet", async () => {
    const stores = buildStores({ ...TENANT, termsAcceptedAt: undefined, termsVersion: undefined });
    const app = buildApp(stores);
    const { body: session } = await startChat(app);

    const res = await request(app).post(`/public/chat/${TENANT.id}/message`).send({
      formKey: TENANT.publicFormKey,
      leadId: session.leadId,
      chatToken: session.chatToken,
      body: "hello",
    });
    expect(res.status).toBe(503);
  });
});

describe("GET /public/chat/:tenantId/history", () => {
  it("returns only this lead's chat-channel messages, in order", async () => {
    const stores = buildStores();
    const app = buildApp(stores);
    const { body: session } = await startChat(app);

    await request(app).post(`/public/chat/${TENANT.id}/message`).send({
      formKey: TENANT.publicFormKey,
      leadId: session.leadId,
      chatToken: session.chatToken,
      body: "not interested, thanks",
    });

    const res = await request(app)
      .get(`/public/chat/${TENANT.id}/history`)
      .query({ formKey: TENANT.publicFormKey, leadId: session.leadId, chatToken: session.chatToken });

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(2);
    expect(res.body[0]).toMatchObject({ direction: "inbound", body: "not interested, thanks" });
    expect(res.body[1]).toMatchObject({ direction: "outbound" });
  });

  it("rejects a wrong chatToken", async () => {
    const stores = buildStores();
    const app = buildApp(stores);
    const { body: session } = await startChat(app);

    const res = await request(app)
      .get(`/public/chat/${TENANT.id}/history`)
      .query({ formKey: TENANT.publicFormKey, leadId: session.leadId, chatToken: "wrong" });
    expect(res.status).toBe(401);
  });
});
