import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Lead, Message, Tenant } from "../src/types.js";

const createMock = vi.fn();

vi.mock("@anthropic-ai/sdk", () => {
  return {
    default: class MockAnthropic {
      messages = { create: createMock };
    },
  };
});

const { generateAutoReply } = await import("../src/chatbot.js");

function mockTextResponse(text: string) {
  createMock.mockResolvedValueOnce({ content: [{ type: "text", text }] });
}

function makeTenant(overrides: Partial<Tenant> = {}): Tenant {
  return {
    id: "tenant-1",
    name: "Acme Plumbing",
    apiKey: "key",
    timezone: "UTC",
    channels: {},
    autoReplyEnabled: true,
    knowledgeBase: "We offer callouts starting at R500. Open Mon-Fri 8am-5pm. Standard jobs take 24-48 hours.",
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

function makeLead(overrides: Partial<Lead> = {}): Lead {
  return {
    id: "lead-1",
    tenantId: "tenant-1",
    name: "Jordan",
    phone: "+27821234567",
    source: "crm",
    createdAt: new Date().toISOString(),
    status: "responded",
    ...overrides,
  };
}

function outbound(body: string): Message {
  return {
    id: "m1",
    tenantId: "tenant-1",
    leadId: "lead-1",
    channel: "sms",
    direction: "outbound",
    body,
    at: new Date().toISOString(),
  };
}

function inbound(body: string): Message {
  return {
    id: "m2",
    tenantId: "tenant-1",
    leadId: "lead-1",
    channel: "sms",
    direction: "inbound",
    body,
    at: new Date().toISOString(),
  };
}

describe("generateAutoReply", () => {
  beforeEach(() => {
    createMock.mockReset();
  });

  it("is disabled when the tenant hasn't opted in", async () => {
    const tenant = makeTenant({ autoReplyEnabled: false });
    const result = await generateAutoReply(tenant, makeLead(), [], "what are your hours?");
    expect(result.action).toBe("disabled");
    expect(createMock).not.toHaveBeenCalled();
  });

  it("is disabled when there's no knowledge base configured", async () => {
    const tenant = makeTenant({ knowledgeBase: undefined });
    const result = await generateAutoReply(tenant, makeLead(), [], "what are your hours?");
    expect(result.action).toBe("disabled");
    expect(createMock).not.toHaveBeenCalled();
  });

  it("is disabled when the knowledge base is just whitespace", async () => {
    const tenant = makeTenant({ knowledgeBase: "   \n  " });
    const result = await generateAutoReply(tenant, makeLead(), [], "what are your hours?");
    expect(result.action).toBe("disabled");
  });

  it("returns a grounded reply for a simple FAQ-shaped question", async () => {
    mockTextResponse("We're open Monday to Friday, 8am to 5pm!");
    const tenant = makeTenant();
    const result = await generateAutoReply(tenant, makeLead(), [], "what are your hours?");
    expect(result.action).toBe("reply");
    expect(result.replyBody).toBe("We're open Monday to Friday, 8am to 5pm!");

    const call = createMock.mock.calls[0][0];
    expect(call.model).toBe("claude-opus-5");
    expect(call.system).toContain("R500");
    expect(call.system).toContain("Acme Plumbing");
  });

  it("escalates when the model returns the ESCALATE token", async () => {
    mockTextResponse("ESCALATE");
    const tenant = makeTenant();
    const result = await generateAutoReply(tenant, makeLead(), [], "can you do it for R200 instead?");
    expect(result.action).toBe("escalate");
    expect(result.replyBody).toBeUndefined();
  });

  it("escalates on ESCALATE with trailing punctuation", async () => {
    mockTextResponse("Escalate.");
    const result = await generateAutoReply(makeTenant(), makeLead(), [], "I want a refund, this is unacceptable");
    expect(result.action).toBe("escalate");
  });

  it("never lets a mid-sentence use of the word escalate slip through as a real answer", async () => {
    // Sanity check on the exact-match pattern: a genuine answer that happens to start
    // with different text should never be misread as the escalate signal.
    mockTextResponse("We can definitely help — escalating isn't necessary for this one!");
    const result = await generateAutoReply(makeTenant(), makeLead(), [], "quick question");
    expect(result.action).toBe("reply");
  });

  it("fails safe to escalate on an API error", async () => {
    createMock.mockRejectedValueOnce(new Error("network down"));
    const result = await generateAutoReply(makeTenant(), makeLead(), [], "what are your hours?");
    expect(result.action).toBe("escalate");
  });

  it("fails safe to escalate when the model returns no text", async () => {
    createMock.mockResolvedValueOnce({ content: [] });
    const result = await generateAutoReply(makeTenant(), makeLead(), [], "hello?");
    expect(result.action).toBe("escalate");
  });

  it("passes prior conversation history as alternating turns, starting from the first inbound message", async () => {
    mockTextResponse("Sure thing!");
    const history = [outbound("Hi Jordan, this is Acme..."), inbound("what's the callout fee?"), outbound("R500")];
    await generateAutoReply(makeTenant(), makeLead(), history, "ok and how long does a job take?");

    const call = createMock.mock.calls[0][0];
    expect(call.messages[0].role).toBe("user"); // leading outbound-only prefix dropped
    expect(call.messages.map((m: { role: string }) => m.role)).toEqual(["user", "assistant", "user"]);
    expect(call.messages.at(-1).content).toBe("ok and how long does a job take?");
  });

  it("handles empty history (the lead's very first message) as a single user turn", async () => {
    mockTextResponse("Happy to help!");
    const call = await generateAutoReply(makeTenant(), makeLead(), [], "hi, do you do gutter cleaning?");
    expect(call.action).toBe("reply");
    const args = createMock.mock.calls[0][0];
    expect(args.messages).toEqual([{ role: "user", content: "hi, do you do gutter cleaning?" }]);
  });

  it("caps how much history is sent to the model, still starting on a user turn", async () => {
    mockTextResponse("Got it!");
    // 20 alternating turns — far more than MAX_HISTORY_MESSAGES (16).
    const history: Message[] = [];
    for (let i = 0; i < 10; i++) {
      history.push(inbound(`inbound #${i}`));
      history.push(outbound(`outbound #${i}`));
    }
    await generateAutoReply(makeTenant(), makeLead(), history, "one more question");

    const call = createMock.mock.calls[0][0];
    expect(call.messages.length).toBeLessThanOrEqual(17); // <=16 history turns + the incoming message
    expect(call.messages[0].role).toBe("user");
    // Only the most recent history should appear — the earliest turns are dropped.
    expect(JSON.stringify(call.messages)).not.toContain("inbound #0");
    expect(JSON.stringify(call.messages)).toContain("inbound #9");
  });

  it("escalates without calling the model once the per-lead reply rate limit is hit", async () => {
    const now = new Date("2026-01-01T12:00:00.000Z");
    const recentAutoReply = (minutesAgo: number): Message => ({
      id: `ar-${minutesAgo}`,
      tenantId: "tenant-1",
      leadId: "lead-1",
      channel: "sms",
      direction: "outbound",
      body: "an earlier auto-reply",
      at: new Date(now.getTime() - minutesAgo * 60_000).toISOString(),
      kind: "auto_reply",
    });
    // 5 auto-replies already within the last hour — at the limit.
    const history = [10, 20, 30, 40, 50].map(recentAutoReply);

    const result = await generateAutoReply(makeTenant(), makeLead(), history, "another question", now);
    expect(result.action).toBe("escalate");
    expect(createMock).not.toHaveBeenCalled();
  });

  it("does not count auto-replies from outside the rate-limit window", async () => {
    mockTextResponse("Sure!");
    const now = new Date("2026-01-01T12:00:00.000Z");
    const oldAutoReply = (hoursAgo: number): Message => ({
      id: `ar-old-${hoursAgo}`,
      tenantId: "tenant-1",
      leadId: "lead-1",
      channel: "sms",
      direction: "outbound",
      body: "an old auto-reply",
      at: new Date(now.getTime() - hoursAgo * 60 * 60_000).toISOString(),
      kind: "auto_reply",
    });
    // 5 auto-replies, but all well outside the 1-hour window — shouldn't count against the limit.
    const history = [2, 3, 4, 5, 6].map(oldAutoReply);

    const result = await generateAutoReply(makeTenant(), makeLead(), history, "another question", now);
    expect(result.action).toBe("reply");
    expect(createMock).toHaveBeenCalledTimes(1);
  });
});
