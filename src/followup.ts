import type { ComposedMessage, ContactReason, Lead, Tenant } from "./types.js";
import { checkSuppression } from "./compliance.js";

/** Days after the previous contact before each successive follow-up is due. */
export const FOLLOWUP_INTERVAL_DAYS = [3, 7, 14] as const;

export const MAX_FOLLOWUPS = FOLLOWUP_INTERVAL_DAYS.length;

function daysSince(isoDate: string, now: Date): number {
  return (now.getTime() - new Date(isoDate).getTime()) / (1000 * 60 * 60 * 24);
}

/**
 * A lead is due for a follow-up nudge when: it was contacted and never
 * responded, it hasn't already hit the follow-up cap, and enough time has
 * passed since the last contact per FOLLOWUP_INTERVAL_DAYS. Any reply
 * (STEP: reply handling flips status away from contacted_no_response) or
 * opt-out immediately and permanently removes a lead from this list.
 */
export function isDueForFollowUp(lead: Lead, now: Date = new Date()): boolean {
  if (checkSuppression(lead).suppressed) return false;
  if (lead.status !== "contacted_no_response") return false;
  if (!lead.firstOutreachSentAt) return false; // only follow up on contact LeadRecovery itself initiated
  const followUpCount = lead.followUpCount ?? 0;
  if (followUpCount >= MAX_FOLLOWUPS) return false;
  if (!lead.lastContactedAt) return false;

  if (lead.nextFollowUpAt) {
    return now.getTime() >= new Date(lead.nextFollowUpAt).getTime();
  }
  const requiredDays = FOLLOWUP_INTERVAL_DAYS[followUpCount];
  return daysSince(lead.lastContactedAt, now) >= requiredDays;
}

export function getLeadsDueForFollowUp(leads: Lead[], now: Date = new Date()): Lead[] {
  return leads.filter((lead) => isDueForFollowUp(lead, now));
}

const FOLLOWUP_TEMPLATES = [
  (name: string, businessName: string) =>
    `Hi ${name}, just following up from ${businessName} in case our last message got buried — still keen to help whenever you're ready. Reply STOP to opt out.`,
  (name: string, businessName: string) =>
    `Hi ${name}, one more check-in from ${businessName} — no pressure at all, just didn't want to leave you hanging. Reply STOP anytime.`,
  (name: string, businessName: string) =>
    `Hi ${name}, last note from ${businessName} for now — reach out whenever suits you and we'll pick up where we left off. Reply STOP to opt out.`,
];

function firstName(lead: Lead): string {
  if (!lead.name) return "there";
  return lead.name.trim().split(/\s+/)[0];
}

/**
 * Composes a follow-up nudge for a lead already past its initial message.
 * Deliberately distinct wording per attempt (spec: "never repeat the same
 * phrasing") and always short, low-pressure, and easy to opt out of.
 */
export function composeFollowUpMessage(
  lead: Lead,
  followUpIndex: number,
  channel: ComposedMessage["channel"],
  tenant: Tenant
): ComposedMessage {
  const template = FOLLOWUP_TEMPLATES[Math.min(followUpIndex, FOLLOWUP_TEMPLATES.length - 1)];
  return { channel, body: template(firstName(lead), tenant.name) };
}

/** Reason attached to a follow-up plan, for consistency with the initial-contact ContactReason shape. */
export function followUpReason(followUpIndex: number): ContactReason {
  return { text: `follow-up #${followUpIndex + 1} after no response`, grounded: true };
}
