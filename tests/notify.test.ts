import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { deliverNotification, notifyHumanAttention, NOTIFICATION_MAX_ATTEMPTS } from "../src/notify.js";
import { InMemoryNotificationStore } from "../src/store/memory.js";
import type { Lead, Tenant } from "../src/types.js";

const TENANT: Tenant = {
  id: "tenant-1",
  name: "Acme Co",
  apiKey: "key",
  timezone: "UTC",
  channels: {},
  notifyWebhookUrl: "https://hooks.example.com/notify",
  createdAt: new Date().toISOString(),
};

const LEAD: Lead = {
  id: "lead-1",
  tenantId: TENANT.id,
  name: "Jordan",
  phone: "+27821234567",
  source: "crm",
  createdAt: new Date().toISOString(),
  status: "responded",
};

describe("deliverNotification", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns ok on a 2xx response", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 200 }));
    const result = await deliverNotification("https://hooks.example.com/notify", { text: "hi" });
    expect(result.ok).toBe(true);
  });

  it("returns not-ok with the status on a non-2xx response, without throwing", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 500 }));
    const result = await deliverNotification("https://hooks.example.com/notify", { text: "hi" });
    expect(result).toEqual({ ok: false, error: "webhook responded 500" });
  });

  it("returns not-ok with the error message when fetch throws, without throwing", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network down"));
    const result = await deliverNotification("https://hooks.example.com/notify", { text: "hi" });
    expect(result).toEqual({ ok: false, error: "network down" });
  });
});

describe("notifyHumanAttention", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("does nothing when the tenant has no notifyWebhookUrl", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    await notifyHumanAttention(undefined, { ...TENANT, notifyWebhookUrl: undefined }, LEAD, "sms", "yes", "interested");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("succeeds on the first attempt without retrying", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 200 }));
    await notifyHumanAttention(undefined, TENANT, LEAD, "sms", "yes please", "interested");
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("retries once after a short delay, and succeeds if the retry works", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValueOnce(new Error("blip"))
      .mockResolvedValueOnce(new Response(null, { status: 200 }));

    const done = notifyHumanAttention(undefined, TENANT, LEAD, "sms", "yes please", "interested");
    await vi.runAllTimersAsync();
    await done;

    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it("persists a FailedNotification when both attempts fail", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("still down"));
    const notificationStore = new InMemoryNotificationStore();

    const done = notifyHumanAttention(notificationStore, TENANT, LEAD, "email", "please help", "needs_human_reply");
    await vi.runAllTimersAsync();
    await done;

    const pending = await notificationStore.listPending();
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({
      tenantId: TENANT.id,
      leadId: LEAD.id,
      reason: "needs_human_reply",
      webhookUrl: TENANT.notifyWebhookUrl,
      attempts: 1,
      status: "pending",
    });
    expect(pending[0].payload.event).toBe("needs_human_reply");
  });

  it("never throws even with no notificationStore given and both attempts failing", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("still down"));
    const done = notifyHumanAttention(undefined, TENANT, LEAD, "email", "please help", "needs_human_reply");
    await vi.runAllTimersAsync();
    await expect(done).resolves.toBeUndefined();
  });

  it("never throws even if notificationStore.recordFailure itself rejects", async () => {
    // Regression test: both call sites in webhooks/index.ts invoke this as
    // `void notifyHumanAttention(...)` without awaiting or catching, so any
    // rejection here would be an unhandled promise rejection — which
    // crashes the whole process on Node 15+ by default.
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("still down"));
    const failingStore = {
      recordFailure: vi.fn().mockRejectedValue(new Error("DB write failed")),
      listPending: vi.fn(),
      listAll: vi.fn(),
      markDelivered: vi.fn(),
      markAttemptFailed: vi.fn(),
    };

    const done = notifyHumanAttention(failingStore, TENANT, LEAD, "email", "please help", "needs_human_reply");
    await vi.runAllTimersAsync();
    await expect(done).resolves.toBeUndefined();
    expect(failingStore.recordFailure).toHaveBeenCalledTimes(1);
  });
});

describe("InMemoryNotificationStore redelivery bookkeeping", () => {
  it("marks a notification dead once attempts reaches the configured max", async () => {
    const store = new InMemoryNotificationStore();
    const recorded = await store.recordFailure({
      tenantId: TENANT.id,
      leadId: LEAD.id,
      reason: "interested",
      webhookUrl: "https://hooks.example.com/notify",
      payload: { text: "hi" },
      error: "boom",
    });
    expect(recorded.attempts).toBe(1);

    for (let i = recorded.attempts; i < NOTIFICATION_MAX_ATTEMPTS - 1; i++) {
      await store.markAttemptFailed(recorded.id, "still failing", NOTIFICATION_MAX_ATTEMPTS);
    }
    expect(await store.listPending()).toHaveLength(1);

    await store.markAttemptFailed(recorded.id, "final failure", NOTIFICATION_MAX_ATTEMPTS);
    expect(await store.listPending()).toHaveLength(0);
    const [dead] = await store.listAll();
    expect(dead.status).toBe("dead");
    expect(dead.attempts).toBe(NOTIFICATION_MAX_ATTEMPTS);
  });

  it("removes a notification from the store once marked delivered", async () => {
    const store = new InMemoryNotificationStore();
    const recorded = await store.recordFailure({
      tenantId: TENANT.id,
      reason: "interested",
      webhookUrl: "https://hooks.example.com/notify",
      payload: { text: "hi" },
      error: "boom",
    });
    await store.markDelivered(recorded.id);
    expect(await store.listAll()).toHaveLength(0);
  });
});
