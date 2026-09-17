import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { InMemoryNotificationStore } from "../src/store/memory.js";
import type { Lead, Tenant } from "../src/types.js";

// deliverNotification (src/notify.ts) goes through src/ssrf.ts's
// postToUntrustedUrl rather than a plain fetch() — it resolves the webhook
// hostname itself (node:dns/promises) and issues the actual request via
// node:http/node:https directly (so it can pin the connection to the
// address it validated) — mock all three so these tests don't depend on
// real DNS/networking for "hooks.example.com".
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
let nextStatusCode = 200;
let lastRequestOptions: FakeRequestOptions | undefined;
// Consumed one at a time per request; once empty, requests succeed with nextStatusCode.
let pendingErrors: Error[] = [];

function fakeRequest(options: FakeRequestOptions, callback: (res: unknown) => void) {
  lastRequestOptions = options;
  const req = new EventEmitter() as EventEmitter & { end: (body?: unknown) => void; destroy: () => void };
  req.end = () => {
    const nextError = pendingErrors.shift();
    if (nextError) {
      queueMicrotask(() => req.emit("error", nextError));
      return;
    }
    const res = new EventEmitter() as EventEmitter & { statusCode: number; resume: () => void };
    res.statusCode = nextStatusCode;
    res.resume = () => {};
    queueMicrotask(() => {
      callback(res);
      res.emit("end");
    });
  };
  req.destroy = () => {};
  return req;
}

const httpRequestMock = vi.fn(fakeRequest);
const httpsRequestMock = vi.fn(fakeRequest);
vi.mock("node:http", () => ({
  default: { request: (...args: [FakeRequestOptions, (res: unknown) => void]) => httpRequestMock(...args) },
}));
vi.mock("node:https", () => ({
  default: { request: (...args: [FakeRequestOptions, (res: unknown) => void]) => httpsRequestMock(...args) },
}));

const { deliverNotification, notifyHumanAttention, NOTIFICATION_MAX_ATTEMPTS } = await import("../src/notify.js");

// Reset before every test (not just once at module load).
beforeEach(() => {
  lookupMock.mockReset().mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
  httpRequestMock.mockClear();
  httpsRequestMock.mockClear();
  nextStatusCode = 200;
  lastRequestOptions = undefined;
  pendingErrors = [];
});

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
  it("returns ok on a 2xx response", async () => {
    const result = await deliverNotification("https://hooks.example.com/notify", { text: "hi" });
    expect(result.ok).toBe(true);
  });

  it("returns not-ok with the status on a non-2xx response, without throwing", async () => {
    nextStatusCode = 500;
    const result = await deliverNotification("https://hooks.example.com/notify", { text: "hi" });
    expect(result).toEqual({ ok: false, error: "webhook responded 500" });
  });

  it("returns not-ok with the error message when the request errors, without throwing", async () => {
    pendingErrors.push(new Error("network down"));
    const result = await deliverNotification("https://hooks.example.com/notify", { text: "hi" });
    expect(result).toEqual({ ok: false, error: "network down" });
  });

  it("refuses to request a webhook URL that resolves to a private/internal address (SSRF)", async () => {
    lookupMock.mockReset().mockResolvedValueOnce([{ address: "169.254.169.254", family: 4 }]);
    const result = await deliverNotification("https://internal-looking.example.com/notify", { text: "hi" });
    expect(result.ok).toBe(false);
    expect(httpRequestMock).not.toHaveBeenCalled();
    expect(httpsRequestMock).not.toHaveBeenCalled();
  });

  it("refuses a literal private IP without even doing a DNS lookup", async () => {
    lookupMock.mockReset();
    const result = await deliverNotification("http://10.0.0.5/notify", { text: "hi" });
    expect(result.ok).toBe(false);
    expect(httpRequestMock).not.toHaveBeenCalled();
    expect(lookupMock).not.toHaveBeenCalled();
  });

  it("does not follow a redirect from the webhook target (a compromised/malicious target could otherwise redirect to an internal address and bypass the hostname check above)", async () => {
    nextStatusCode = 302;
    const result = await deliverNotification("https://hooks.example.com/notify", { text: "hi" });
    expect(result).toEqual({ ok: false, error: "webhook responded with a redirect, which is not followed" });
    expect(lastRequestOptions?.hostname).toBe("hooks.example.com");
  });
});

describe("notifyHumanAttention", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("does nothing when the tenant has no notifyWebhookUrl", async () => {
    await notifyHumanAttention(undefined, { ...TENANT, notifyWebhookUrl: undefined }, LEAD, "sms", "yes", "interested");
    expect(httpRequestMock).not.toHaveBeenCalled();
    expect(httpsRequestMock).not.toHaveBeenCalled();
  });

  it("succeeds on the first attempt without retrying", async () => {
    await notifyHumanAttention(undefined, TENANT, LEAD, "sms", "yes please", "interested");
    expect(httpsRequestMock).toHaveBeenCalledTimes(1);
  });

  it("retries once after a short delay, and succeeds if the retry works", async () => {
    pendingErrors.push(new Error("blip"));

    const done = notifyHumanAttention(undefined, TENANT, LEAD, "sms", "yes please", "interested");
    await vi.runAllTimersAsync();
    await done;

    expect(httpsRequestMock).toHaveBeenCalledTimes(2);
  });

  it("persists a FailedNotification when both attempts fail", async () => {
    pendingErrors.push(new Error("still down"), new Error("still down"));
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
    pendingErrors.push(new Error("still down"), new Error("still down"));
    const done = notifyHumanAttention(undefined, TENANT, LEAD, "email", "please help", "needs_human_reply");
    await vi.runAllTimersAsync();
    await expect(done).resolves.toBeUndefined();
  });

  it("never throws even if notificationStore.recordFailure itself rejects", async () => {
    // Regression test: both call sites in webhooks/index.ts invoke this as
    // `void notifyHumanAttention(...)` without awaiting or catching, so any
    // rejection here would be an unhandled promise rejection — which
    // crashes the whole process on Node 15+ by default.
    pendingErrors.push(new Error("still down"), new Error("still down"));
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
