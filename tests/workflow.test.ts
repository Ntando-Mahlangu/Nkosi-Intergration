import { describe, expect, it, vi } from "vitest";
import { InMemoryLeadStore, InMemoryMessageStore } from "../src/store/memory.js";
import { buildRecoveryPlans, runRecoveryWorkflow } from "../src/workflow.js";
import type { Lead, Tenant } from "../src/types.js";

const NOW = new Date("2026-09-12T00:00:00.000Z");

const TENANT: Tenant = {
  id: "tenant-1",
  name: "Acme Co",
  apiKey: "test-key",
  timezone: "UTC",
  devMode: true, // console-fallback sends, no real Twilio/SendGrid credentials needed
  quietHours: { startHour: 0, endHour: 0 }, // disabled, so tests aren't sensitive to what time NOW happens to be
  channels: {},
  createdAt: NOW.toISOString(),
};

const LEADS: Lead[] = [
  {
    id: "recoverable-1",
    tenantId: TENANT.id,
    name: "Amara Ncube",
    phone: "+27821111111",
    source: "missed_call",
    createdAt: new Date("2026-09-10T00:00:00.000Z").toISOString(),
    hadMissedCall: true,
    requestedService: "kitchen remodel",
    status: "new",
  },
  {
    id: "suppressed-1",
    tenantId: TENANT.id,
    name: "Do Not Contact Dan",
    phone: "+27822222222",
    source: "crm",
    createdAt: new Date("2026-09-01T00:00:00.000Z").toISOString(),
    status: "do_not_contact",
  },
  {
    id: "no-contact-info",
    tenantId: TENANT.id,
    name: "No Info Nomvula",
    source: "crm",
    createdAt: new Date("2026-09-01T00:00:00.000Z").toISOString(),
    requestedService: "fencing",
    status: "new",
  },
];

describe("buildRecoveryPlans", () => {
  it("excludes suppressed leads and leads with no usable channel", () => {
    const { plans, skipped } = buildRecoveryPlans(TENANT, LEADS, NOW);
    expect(plans).toHaveLength(1);
    expect(plans[0].lead.id).toBe("recoverable-1");
    expect(skipped.map((s) => s.lead.id).sort()).toEqual(["no-contact-info", "suppressed-1"]);
  });

  it("never produces a plan for a do_not_contact lead", () => {
    const { plans } = buildRecoveryPlans(TENANT, LEADS, NOW);
    expect(plans.some((p) => p.lead.status === "do_not_contact")).toBe(false);
  });

  it("skips leads that already got their initial LeadRecovery outreach", () => {
    const alreadyContacted: Lead = {
      ...LEADS[0],
      id: "already-contacted",
      firstOutreachSentAt: NOW.toISOString(),
      status: "contacted_no_response",
    };
    const { plans, skipped } = buildRecoveryPlans(TENANT, [alreadyContacted], NOW);
    expect(plans).toHaveLength(0);
    expect(skipped).toHaveLength(0); // handled by the follow-up pass instead, not reported as skipped here
  });
});

describe("runRecoveryWorkflow", () => {
  it("sends to contactable leads and updates their status/firstOutreachSentAt in the store", async () => {
    const store = new InMemoryLeadStore(LEADS);
    const messages = new InMemoryMessageStore();
    const result = await runRecoveryWorkflow(TENANT, store, messages, NOW);

    expect(result.sent).toHaveLength(1);
    expect(result.sent[0].result.ok).toBe(true);
    expect(result.sent[0].isFollowUp).toBe(false);

    const updated = await store.getAllLeads(TENANT.id);
    const contacted = updated.find((l) => l.id === "recoverable-1");
    expect(contacted?.status).toBe("contacted_no_response");
    expect(contacted?.lastContactedAt).toBe(NOW.toISOString());
    expect(contacted?.firstOutreachSentAt).toBe(NOW.toISOString());
    expect(contacted?.followUpCount).toBe(0);

    const suppressed = updated.find((l) => l.id === "suppressed-1");
    expect(suppressed?.status).toBe("do_not_contact");

    const logged = await messages.getMessagesForLead(TENANT.id, "recoverable-1");
    expect(logged).toHaveLength(1);
    expect(logged[0].direction).toBe("outbound");
  });

  it("defers sends during tenant quiet hours instead of sending or mutating status", async () => {
    const quietTenant: Tenant = { ...TENANT, quietHours: { startHour: 0, endHour: 24 } };
    const store = new InMemoryLeadStore(LEADS);
    const result = await runRecoveryWorkflow(quietTenant, store, undefined, NOW);

    expect(result.sent).toHaveLength(0);
    expect(result.deferred.some((d) => d.lead.id === "recoverable-1")).toBe(true);

    const updated = await store.getAllLeads(TENANT.id);
    const untouched = updated.find((l) => l.id === "recoverable-1");
    expect(untouched?.status).toBe("new");
    expect(untouched?.firstOutreachSentAt).toBeUndefined();
  });

  it("sends a follow-up (not a duplicate initial message) to a lead already contacted once", async () => {
    const contactedLead: Lead = {
      id: "followup-lead",
      tenantId: TENANT.id,
      name: "Farai Moyo",
      phone: "+27821234099",
      source: "crm",
      createdAt: new Date("2026-08-01T00:00:00.000Z").toISOString(),
      status: "contacted_no_response",
      firstOutreachSentAt: new Date("2026-09-05T00:00:00.000Z").toISOString(),
      lastContactedAt: new Date("2026-09-05T00:00:00.000Z").toISOString(),
      followUpCount: 0,
    };
    const store = new InMemoryLeadStore([contactedLead]);
    const result = await runRecoveryWorkflow(TENANT, store, undefined, NOW);

    expect(result.sent).toHaveLength(1);
    expect(result.sent[0].isFollowUp).toBe(true);

    const updated = await store.getLeadById(TENANT.id, "followup-lead");
    expect(updated?.followUpCount).toBe(1);
  });

  it("a channel adapter throwing for one lead doesn't abort the rest of the batch", async () => {
    // Regression test: adapter.send() can throw a real provider-level error
    // (Twilio rejecting a malformed number), not just return {ok: false} —
    // sendPlans() used to have no try/catch around that call, so the first
    // such lead aborted the loop and silently skipped every lead after it.
    const leadA: Lead = {
      id: "lead-a",
      tenantId: TENANT.id,
      name: "Lead A",
      phone: "+27821110001",
      source: "crm",
      createdAt: NOW.toISOString(),
      status: "new",
    };
    const leadB: Lead = {
      id: "lead-b",
      tenantId: TENANT.id,
      name: "Lead B",
      phone: "+27821110002",
      source: "crm",
      createdAt: NOW.toISOString(),
      status: "new",
    };
    const store = new InMemoryLeadStore([leadA, leadB]);

    const { smsAdapter } = await import("../src/channels/sms.js");
    const sendSpy = vi.spyOn(smsAdapter, "send").mockRejectedValueOnce(new Error("Twilio: invalid phone number"));

    const result = await runRecoveryWorkflow(TENANT, store, undefined, NOW);

    expect(result.sent).toHaveLength(2);
    const forA = result.sent.find((s) => s.plan.lead.id === "lead-a");
    const forB = result.sent.find((s) => s.plan.lead.id === "lead-b");
    expect(forA?.result.ok).toBe(false);
    expect(forA?.result.detail).toContain("invalid phone number");
    expect(forB?.result.ok).toBe(true);

    // The lead whose send threw keeps its pre-send status; the one after
    // it in the loop still got contacted normally.
    const updatedA = await store.getLeadById(TENANT.id, "lead-a");
    const updatedB = await store.getLeadById(TENANT.id, "lead-b");
    expect(updatedA?.status).toBe("new");
    expect(updatedB?.status).toBe("contacted_no_response");

    sendSpy.mockRestore();
  });

  it("doesn't overwrite a status change that lands mid-send back to contacted_no_response", async () => {
    // Regression test: sendPlans() unconditionally patched
    // {status: "contacted_no_response", ...} after a successful send. A real
    // send is a network call, so a reply (e.g. "STOP") can be recorded by
    // the inbound-webhook handler while it's in flight — sendPlans() must
    // not then clobber that reply-driven status back to
    // "contacted_no_response" just because the send itself succeeded.
    const lead: Lead = {
      id: "recoverable-1",
      tenantId: TENANT.id,
      name: "Amara Ncube",
      phone: "+27821111111",
      source: "missed_call",
      createdAt: new Date("2026-09-10T00:00:00.000Z").toISOString(),
      requestedService: "kitchen remodel",
      status: "new",
    };
    const store = new InMemoryLeadStore([lead]);

    const { smsAdapter } = await import("../src/channels/sms.js");
    const sendSpy = vi.spyOn(smsAdapter, "send").mockImplementationOnce(async () => {
      // Simulate the lead replying STOP and the webhook handler recording
      // that opt-out while this send is still in flight.
      await store.updateLead(TENANT.id, lead.id, { status: "opted_out" });
      return { ok: true, channel: "sms", providerMessageId: "SM-concurrent" };
    });

    const result = await runRecoveryWorkflow(TENANT, store, undefined, NOW);
    expect(result.sent).toHaveLength(1);
    expect(result.sent[0].result.ok).toBe(true);

    const updated = await store.getLeadById(TENANT.id, lead.id);
    expect(updated?.status).toBe("opted_out"); // not clobbered back to "contacted_no_response"

    sendSpy.mockRestore();
  });

  it("sends an appointment reminder, marks appointmentReminderSentAt, and doesn't touch follow-up bookkeeping", async () => {
    const lead: Lead = {
      id: "booked-lead",
      tenantId: TENANT.id,
      name: "Priya Naidoo",
      phone: "+27821119999",
      source: "booking_software",
      createdAt: new Date("2026-09-01T00:00:00.000Z").toISOString(),
      status: "booked",
      appointmentStatus: "booked",
      appointmentAt: new Date(NOW.getTime() + 12 * 60 * 60 * 1000).toISOString(), // 12h out
      followUpCount: 3, // must survive untouched — a reminder isn't a follow-up
    };
    const store = new InMemoryLeadStore([lead]);
    const messages = new InMemoryMessageStore();
    const result = await runRecoveryWorkflow(TENANT, store, messages, NOW);

    expect(result.sent).toHaveLength(1);
    expect(result.sent[0].result.ok).toBe(true);
    expect(result.sent[0].isReminder).toBe(true);
    expect(result.sent[0].isFollowUp).toBe(false);

    const updated = await store.getLeadById(TENANT.id, "booked-lead");
    expect(updated?.appointmentReminderSentAt).toBe(NOW.toISOString());
    expect(updated?.status).toBe("booked"); // untouched — reminders don't drive the recovery status machine
    expect(updated?.followUpCount).toBe(3); // untouched

    const logged = await messages.getMessagesForLead(TENANT.id, "booked-lead");
    expect(logged).toHaveLength(1);
    expect(logged[0].kind).toBe("appointment_reminder");
  });

  it("never sends the same appointment reminder twice across runs", async () => {
    const lead: Lead = {
      id: "booked-lead",
      tenantId: TENANT.id,
      name: "Priya Naidoo",
      phone: "+27821119999",
      source: "booking_software",
      createdAt: new Date("2026-09-01T00:00:00.000Z").toISOString(),
      status: "booked",
      appointmentStatus: "booked",
      appointmentAt: new Date(NOW.getTime() + 12 * 60 * 60 * 1000).toISOString(),
    };
    const store = new InMemoryLeadStore([lead]);

    const first = await runRecoveryWorkflow(TENANT, store, undefined, NOW);
    expect(first.sent).toHaveLength(1);

    const later = new Date(NOW.getTime() + 60 * 60 * 1000); // an hour later, still well before the appointment
    const second = await runRecoveryWorkflow(TENANT, store, undefined, later);
    expect(second.sent).toHaveLength(0);
  });

  it("defers an appointment reminder during quiet hours instead of sending it", async () => {
    const quietTenant: Tenant = { ...TENANT, quietHours: { startHour: 0, endHour: 24 } };
    const lead: Lead = {
      id: "booked-lead",
      tenantId: TENANT.id,
      name: "Priya Naidoo",
      phone: "+27821119999",
      source: "booking_software",
      createdAt: new Date("2026-09-01T00:00:00.000Z").toISOString(),
      status: "booked",
      appointmentStatus: "booked",
      appointmentAt: new Date(NOW.getTime() + 12 * 60 * 60 * 1000).toISOString(),
    };
    const store = new InMemoryLeadStore([lead]);
    const result = await runRecoveryWorkflow(quietTenant, store, undefined, NOW);

    expect(result.sent).toHaveLength(0);
    expect(result.deferred.some((d) => d.lead.id === "booked-lead")).toBe(true);

    const updated = await store.getLeadById(TENANT.id, "booked-lead");
    expect(updated?.appointmentReminderSentAt).toBeUndefined();
  });
});
