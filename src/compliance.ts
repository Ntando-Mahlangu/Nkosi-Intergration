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
