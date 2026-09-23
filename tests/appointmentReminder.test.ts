import { describe, expect, it } from "vitest";
import {
  APPOINTMENT_REMINDER_HOURS_BEFORE,
  composeAppointmentReminderMessage,
  getLeadsDueForAppointmentReminder,
  isDueForAppointmentReminder,
} from "../src/appointmentReminder.js";
import type { Lead, Tenant } from "../src/types.js";

const NOW = new Date("2026-09-12T12:00:00.000Z");

const TENANT: Tenant = {
  id: "t1",
  name: "Acme Plumbing",
  apiKey: "key",
  timezone: "Africa/Johannesburg",
  channels: {},
  createdAt: NOW.toISOString(),
};

function makeBookedLead(overrides: Partial<Lead>): Lead {
  return {
    id: "lead-1",
    tenantId: "t1",
    name: "Jordan Smith",
    phone: "+27821234567",
    source: "crm",
    createdAt: new Date("2026-09-01T00:00:00.000Z").toISOString(),
    status: "booked",
    appointmentStatus: "booked",
    appointmentAt: new Date(NOW.getTime() + 12 * 60 * 60 * 1000).toISOString(), // 12h from NOW, within the 24h window
    ...overrides,
  };
}

describe("isDueForAppointmentReminder", () => {
  it("is due when the appointment is within the reminder window and never reminded", () => {
    expect(isDueForAppointmentReminder(makeBookedLead({}), NOW)).toBe(true);
  });

  it("is not due when the appointment is further out than the window", () => {
    const lead = makeBookedLead({ appointmentAt: new Date(NOW.getTime() + 48 * 60 * 60 * 1000).toISOString() });
    expect(isDueForAppointmentReminder(lead, NOW)).toBe(false);
  });

  it("is not due once the appointment has already passed", () => {
    const lead = makeBookedLead({ appointmentAt: new Date(NOW.getTime() - 60 * 60 * 1000).toISOString() });
    expect(isDueForAppointmentReminder(lead, NOW)).toBe(false);
  });

  it("is not due right at the threshold's edge (exactly 24h out is still due; past it isn't)", () => {
    const atThreshold = makeBookedLead({
      appointmentAt: new Date(NOW.getTime() + APPOINTMENT_REMINDER_HOURS_BEFORE * 60 * 60 * 1000).toISOString(),
    });
    expect(isDueForAppointmentReminder(atThreshold, NOW)).toBe(true);

    const justPastThreshold = makeBookedLead({
      appointmentAt: new Date(NOW.getTime() + APPOINTMENT_REMINDER_HOURS_BEFORE * 60 * 60 * 1000 + 1000).toISOString(),
    });
    expect(isDueForAppointmentReminder(justPastThreshold, NOW)).toBe(false);
  });

  it("is not due once the reminder has already been sent", () => {
    const lead = makeBookedLead({ appointmentReminderSentAt: new Date("2026-09-12T00:00:00.000Z").toISOString() });
    expect(isDueForAppointmentReminder(lead, NOW)).toBe(false);
  });

  it("is not due for a merely requested/abandoned appointment, only a booked one", () => {
    expect(isDueForAppointmentReminder(makeBookedLead({ appointmentStatus: "requested" }), NOW)).toBe(false);
    expect(isDueForAppointmentReminder(makeBookedLead({ appointmentStatus: "abandoned" }), NOW)).toBe(false);
  });

  it("is not due without an appointmentAt at all", () => {
    expect(isDueForAppointmentReminder(makeBookedLead({ appointmentAt: undefined }), NOW)).toBe(false);
  });

  it("is not due for a suppressed lead (opted out, do-not-contact, ...)", () => {
    expect(isDueForAppointmentReminder(makeBookedLead({ status: "opted_out" }), NOW)).toBe(false);
    expect(isDueForAppointmentReminder(makeBookedLead({ status: "do_not_contact" }), NOW)).toBe(false);
  });

  it("never throws on an unparseable appointmentAt", () => {
    expect(isDueForAppointmentReminder(makeBookedLead({ appointmentAt: "not-a-date" }), NOW)).toBe(false);
  });
});

describe("getLeadsDueForAppointmentReminder", () => {
  it("returns only the leads that are actually due", () => {
    const due = makeBookedLead({ id: "due" });
    const notDue = makeBookedLead({
      id: "not-due",
      appointmentAt: new Date(NOW.getTime() + 72 * 60 * 60 * 1000).toISOString(),
    });
    const result = getLeadsDueForAppointmentReminder([due, notDue], NOW);
    expect(result.map((l) => l.id)).toEqual(["due"]);
  });
});

describe("composeAppointmentReminderMessage", () => {
  it("uses the built-in default wording, substituting name/businessName/appointmentTime", () => {
    const lead = makeBookedLead({});
    const message = composeAppointmentReminderMessage(lead, "sms", TENANT);
    expect(message.channel).toBe("sms");
    expect(message.body).toContain("Jordan"); // first name only
    expect(message.body).toContain("Acme Plumbing");
    expect(message.body).toMatch(/reply stop/i);
    expect(message.body).not.toContain("{"); // no leftover unsubstituted placeholders
  });

  it("uses the tenant's own template override when set", () => {
    const lead = makeBookedLead({});
    const tenant: Tenant = {
      ...TENANT,
      templates: { appointmentReminder: "Reminder: {name}, see you {appointmentTime}! - {businessName}" },
    };
    const message = composeAppointmentReminderMessage(lead, "sms", tenant);
    expect(message.body).toContain("Reminder: Jordan");
    expect(message.body).toContain("Acme Plumbing");
  });

  it("formats appointmentTime in the tenant's own timezone, not the server's", () => {
    // Africa/Johannesburg is UTC+2 — a fixed UTC instant must render as a
    // different wall-clock hour there than in UTC, proving the timezone is
    // actually being applied rather than silently ignored.
    const lead = makeBookedLead({ appointmentAt: "2026-09-13T10:00:00.000Z" });
    const tenant: Tenant = { ...TENANT, timezone: "Africa/Johannesburg" };
    const message = composeAppointmentReminderMessage(lead, "sms", tenant);
    expect(message.body).toContain("12:00"); // 10:00 UTC + 2h
  });
});
