import type { ComposedMessage, ContactReason, Lead, Tenant } from "./types.js";
import { substituteTemplate } from "./templateSubstitute.js";
import { isHardStopped } from "./compliance.js";

/** How far ahead of the appointment the reminder goes out. */
export const APPOINTMENT_REMINDER_HOURS_BEFORE = 24;

/**
 * How close to the appointment a reminder is allowed to override quiet
 * hours (see isLastChanceForAppointmentReminder below) rather than being
 * deferred to a later run — deliberately much narrower than the 24h
 * due-window above, so this only ever kicks in when the alternative is
 * genuinely never sending it at all.
 */
export const APPOINTMENT_REMINDER_LAST_CHANCE_HOURS = 2;

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
  if (isHardStopped(lead)) return false;
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

/**
 * True once a due-for-reminder lead's appointment is close enough that
 * deferring it again for quiet hours would mean never sending it at all —
 * isDueForAppointmentReminder above permanently stops considering a lead
 * "due" the instant its appointment time passes (msUntil <= 0), so a tenant
 * whose quiet-hours window happens to cover every single tick between the
 * lead first entering the 24h window and the appointment itself would
 * otherwise have this reminder silently vanish, with nothing distinguishing
 * "deferred, will retry" from "deferred for the last time that mattered."
 * See sendAppointmentReminders in workflow.ts, the only caller: within this
 * narrow final window, it sends anyway rather than deferring for quiet
 * hours — a confirmed appointment someone already agreed to is a
 * transactional reminder, not a marketing send, and never sending it at
 * all is a worse outcome than sending it slightly outside the tenant's
 * configured quiet hours.
 */
export function isLastChanceForAppointmentReminder(lead: Lead, now: Date = new Date()): boolean {
  if (!isDueForAppointmentReminder(lead, now)) return false;
  const msUntil = Date.parse(lead.appointmentAt!) - now.getTime();
  return msUntil <= APPOINTMENT_REMINDER_LAST_CHANCE_HOURS * 60 * 60 * 1000;
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
