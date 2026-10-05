import type { Lead, LeadStatus } from "./types.js";

/**
 * Statuses that are hard stops on contact (SYSTEM_PROMPT.md: "Never contact
 * a lead if the business has explicitly marked them as..."). These checks
 * run before scoring or messaging and override everything else.
 */
const SUPPRESSED_STATUSES: ReadonlySet<LeadStatus> = new Set([
  "do_not_contact",
  "unqualified",
  "fraudulent",
  "active_conversation",
  "booked",
  "converted",
  "opted_out",
]);

export interface SuppressionCheck {
  suppressed: boolean;
  reason?: string;
}

const STATUS_LABELS: Record<string, string> = {
  do_not_contact: "marked do not contact",
  unqualified: "marked unqualified",
  fraudulent: "marked fraudulent",
  active_conversation: "has an existing active customer conversation",
  booked: "already booked",
  converted: "already converted",
  opted_out: "opted out",
};

export function checkSuppression(lead: Lead): SuppressionCheck {
  if (SUPPRESSED_STATUSES.has(lead.status)) {
    return {
      suppressed: true,
      reason: STATUS_LABELS[lead.status] ?? `status is ${lead.status}`,
    };
  }
  return { suppressed: false };
}

/** True if the lead may be contacted at all. */
export function isContactable(lead: Lead): boolean {
  return !checkSuppression(lead).suppressed;
}

/**
 * The narrower subset of SUPPRESSED_STATUSES that reflects a genuine "never
 * contact this person again" signal (a STOP reply, an explicit do-not-
 * contact flag, or a number/address flagged fraudulent) rather than a
 * pipeline-state reason the broader checkSuppression above also blocks on
 * (already converted/booked/mid-conversation) — those three aren't "don't
 * message this person," they're "don't run automated outreach/follow-up on
 * them," which is the wrong rule for something that exists specifically to
 * reach one of those leads on purpose: an appointment reminder for someone
 * who's "booked" (see appointmentReminder.ts), or an operator's manual
 * reply to someone who already converted/has an active conversation and
 * needs a quick answer (see POST /leads/:id/reply). Only the genuine
 * never-contact-again statuses apply to those paths too.
 */
export const HARD_STOP_STATUSES: ReadonlySet<LeadStatus> = new Set(["opted_out", "do_not_contact", "fraudulent"]);

export function isHardStopped(lead: Lead): boolean {
  return HARD_STOP_STATUSES.has(lead.status);
}

export function hardStopReason(lead: Lead): string {
  return STATUS_LABELS[lead.status] ?? `status is ${lead.status}`;
}
