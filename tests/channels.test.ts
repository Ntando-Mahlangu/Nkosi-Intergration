import { describe, expect, it } from "vitest";
import { hasCarrierApproval, selectChannel } from "../src/channels/index.js";
import type { Lead, Tenant } from "../src/types.js";

function makeTenant(overrides: Partial<Tenant> = {}): Tenant {
  return {
    id: "tenant-1",
    name: "Acme Plumbing",
    apiKey: "key",
    timezone: "UTC",
    channels: {},
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

function makeLead(overrides: Partial<Lead> = {}): Lead {
  return {
    id: "lead-1",
    tenantId: "tenant-1",
    phone: "+15550000",
    email: "jordan@example.com",
    source: "crm",
    createdAt: new Date().toISOString(),
    status: "new",
    ...overrides,
  };
}

const SMS_CREDS = { accountSid: "AC1", authToken: "tok", fromNumber: "+15551111" };
const EMAIL_CREDS = { apiKey: "SG.key", fromEmail: "hello@acmeplumbing.com" };

describe("hasCarrierApproval", () => {
  it("is always true for email — no carrier-approval requirement applies", () => {
    expect(hasCarrierApproval(makeTenant(), "email")).toBe(true);
  });

  it("is false for sms/whatsapp with no confirmation and not in devMode", () => {
    expect(hasCarrierApproval(makeTenant(), "sms")).toBe(false);
    expect(hasCarrierApproval(makeTenant(), "whatsapp")).toBe(false);
  });

  it("is true for sms/whatsapp once carrierApprovalConfirmedAt is set", () => {
    const tenant = makeTenant({ carrierApprovalConfirmedAt: new Date().toISOString() });
    expect(hasCarrierApproval(tenant, "sms")).toBe(true);
    expect(hasCarrierApproval(tenant, "whatsapp")).toBe(true);
  });

  it("devMode bypasses the requirement even with no confirmation", () => {
    const tenant = makeTenant({ devMode: true });
    expect(hasCarrierApproval(tenant, "sms")).toBe(true);
  });
});

describe("selectChannel — carrier-approval gating (COMPLIANCE.md 'SMS / WhatsApp (Twilio)')", () => {
  it("skips SMS (falls back to email) when the tenant hasn't confirmed carrier approval", () => {
    const tenant = makeTenant({ channels: { sms: SMS_CREDS, email: EMAIL_CREDS } });
    expect(selectChannel(tenant, makeLead())).toBe("email");
  });

  it("has no usable channel when only sms/whatsapp are configured and unapproved", () => {
    const tenant = makeTenant({ channels: { sms: SMS_CREDS } });
    expect(selectChannel(tenant, makeLead({ email: undefined }))).toBeUndefined();
  });

  it("uses SMS once carrier approval is confirmed", () => {
    const tenant = makeTenant({
      channels: { sms: SMS_CREDS, email: EMAIL_CREDS },
      carrierApprovalConfirmedAt: new Date().toISOString(),
    });
    expect(selectChannel(tenant, makeLead())).toBe("sms");
  });

  it("devMode lets SMS be selected even with no carrier-approval confirmation", () => {
    const tenant = makeTenant({ devMode: true });
    expect(selectChannel(tenant, makeLead())).toBe("sms");
  });

  it("ignores an unapproved preferredChannel and falls back to the priority order", () => {
    const tenant = makeTenant({ channels: { whatsapp: SMS_CREDS, email: EMAIL_CREDS } });
    const lead = makeLead({ preferredChannel: "whatsapp" });
    expect(selectChannel(tenant, lead)).toBe("email");
  });
});
