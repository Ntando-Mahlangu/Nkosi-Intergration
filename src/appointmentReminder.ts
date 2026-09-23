import type { ComposedMessage, ContactReason, Lead, Tenant } from "./types.js";
import { substituteTemplate } from "./templateSubstitute.js";

/** How far ahead of the appointment the reminder goes out. */
export const APPOINTMENT_REMINDER_HOURS_BEFORE = 24;

/**
 * Deliberately narrower than compliance.ts's checkSuppression, which also
 * treats "booked" (among others) as a hard stop — appropriate for recovery
 * outreach ("don't keep chasing someone who already booked"), but wrong
 * here: a reminder's entire purpose is to reach exactly the leads booked
 * appointmentStatus="booked" implies. Only the genuine "never contact this
 * person again" signals apply to a reminder too.
 */
const HARD_STOP_STATUSES: ReadonlySet<Lead["status"]> = new Set(["opted_out", "do_not_contact", "fraudulent"]);

function firstName(lead: Lead): string {
  if (!lead.name) return "there";
  return lead.name.trim().split(/\s+/)[0];
}

/**
 * A lead is due for its appointment reminder when: it has a real, parseable
 * `appointmentAt` on a lead whose appointment is actually confirmed
 * (`appointmentStatus === "booked"` — a merely requested/abandoned one has
 * nothing to remind about), that appointment is still in the future, it's
 * now within the reminder window, the reminder hasn't already gone out, and
 * the lead isn't otherwise suppressed (opted out, do-not-contact, ...).
 *
 * The window is a "since we crossed the threshold" check, not an exact
 * instant, since the worker only runs periodically — whatever run first
 * observes `appointmentAt` within `APPOINTMENT_REMINDER_HOURS_BEFORE` sends
 * it, once, and `appointmentReminderSentAt` stops any later run from
 * sending it again.
 */
export function isDueForAppointmentReminder(lead: Lead, now: Date = new Date()): boolean {
  if (HARD_STOP_STATUSES.has(lead.status)) return false;
  if (lead.appointmentStatus !== "booked") return false;
  if (!lead.appointmentAt) return false;
  if (lead.appointmentReminderSentAt) return false;

  const appointmentMs = Date.parse(lead.appointmentAt);
  if (Number.isNaN(appointmentMs)) return false;

  const msUntil = appointmentMs - now.getTime();
  if (msUntil <= 0) return false; // already happened (or happening now) — too late for a "tomorrow" reminder
  return msUntil <= APPOINTMENT_REMINDER_HOURS_BEFORE * 60 * 60 * 1000;
}

export function getLeadsDueForAppointmentReminder(leads: Lead[], now: Date = new Date()): Lead[] {
  return leads.filter((lead) => isDueForAppointmentReminder(lead, now));
}

const DEFAULT_APPOINTMENT_REMINDER_TEMPLATE =
  "Hi {name}, just a reminder from {businessName} — your appointment is {appointmentTime}. Reply STOP anytime if you'd rather not hear from us.";

/** Formats `appointmentAt` in the tenant's own timezone — e.g. "tomorrow at 2:00 PM" reads correctly for the business's own local time, not the server's. */
function formatAppointmentTime(appointmentAt: string, tenant: Tenant): string {
  try {
    return new Intl.DateTimeFormat(undefined, {
      timeZone: tenant.timezone,
      weekday: "short",
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    }).format(new Date(appointmentAt));
  } catch {
    // An invalid tenant.timezone would throw here — validateTenantConfig
    // already rejects one at config time, so this is only a defensive
    // fallback, not a path expected to actually run.
    return new Date(appointmentAt).toISOString();
  }
}

/**
 * Composes the appointment reminder. Uses the tenant's own template
 * override (tenant.templates.appointmentReminder) when set, otherwise the
 * built-in default wording.
 */
export function composeAppointmentReminderMessage(
  lead: Lead,
  channel: ComposedMessage["channel"],
  tenant: Tenant
): ComposedMessage {
  const template = tenant.templates?.appointmentReminder ?? DEFAULT_APPOINTMENT_REMINDER_TEMPLATE;
  return {
    channel,
    body: substituteTemplate(template, {
      name: firstName(lead),
      businessName: tenant.name,
      appointmentTime: formatAppointmentTime(lead.appointmentAt!, tenant),
    }),
  };
}

/** Reason attached to a reminder plan, for consistency with the initial-contact ContactReason shape. */
export function appointmentReminderReason(): ContactReason {
  return { text: "appointment reminder — coming up within 24 hours", grounded: true };
}
