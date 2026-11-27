import type { ComposedMessage, Channel, ContactReason, Lead, Tenant } from "./types.js";
import { substituteTemplate } from "./templateSubstitute.js";

/** Default delay after conversion before the review request goes out, for a tenant that hasn't set its own `reviewRequestDelayDays`. */
export const DEFAULT_REVIEW_REQUEST_DELAY_DAYS = 3;

function daysSince(isoDate: string, now: Date): number {
  return (now.getTime() - new Date(isoDate).getTime()) / (1000 * 60 * 60 * 24);
}

function firstName(lead: Lead): string {
  if (!lead.name) return "there";
  return lead.name.trim().split(/\s+/)[0];
}

/**
 * A converted customer is due for a one-time review request when: the
 * tenant has deliberately turned the feature on, the lead has converted
 * (never a prospect still in the funnel), the *lead themselves* has an
 * explicit marketing opt-in on file (reusing `Lead.marketingOptIn` — the
 * same flag win-back messaging uses, not a second separate checkbox; see
 * COMPLIANCE.md "Review requests" for why), it hasn't already been sent
 * (this never repeats, unlike win-back's recurring cooldown), and the
 * configured delay since conversion has elapsed — giving the work itself
 * time to be delivered/experienced before asking. Any status change away
 * from "converted" (e.g. a STOP reply) immediately and permanently removes
 * a lead from this list, the same way isDueForWinBack works.
 */
export function isDueForReviewRequest(tenant: Tenant, lead: Lead, now: Date = new Date()): boolean {
  if (!tenant.reviewRequestEnabled) return false;
  if (lead.status !== "converted") return false;
  if (!lead.marketingOptIn) return false;
  if (lead.reviewRequestSentAt) return false;
  if (!lead.convertedAt) return false;
  const delayDays = tenant.reviewRequestDelayDays ?? DEFAULT_REVIEW_REQUEST_DELAY_DAYS;
  return daysSince(lead.convertedAt, now) >= delayDays;
}

export function getLeadsDueForReviewRequest(tenant: Tenant, leads: Lead[], now: Date = new Date()): Lead[] {
  return leads.filter((lead) => isDueForReviewRequest(tenant, lead, now));
}

const DEFAULT_REVIEW_REQUEST_TEMPLATE =
  "Hi {name}, thanks again for choosing {businessName}{serviceClause}! If you have a moment, we'd really " +
  "appreciate a quick review — it helps a lot. Reply STOP anytime if you'd rather not hear from us again.";

/**
 * Composes the one-time review request. Uses the tenant's own template
 * override (tenant.templates.reviewRequest) when set, otherwise the
 * built-in default — same substitution convention as composeWinBackMessage,
 * never fabricating a service the lead never mentioned.
 */
export function composeReviewRequestMessage(lead: Lead, channel: Channel, tenant: Tenant): ComposedMessage {
  const template = tenant.templates?.reviewRequest ?? DEFAULT_REVIEW_REQUEST_TEMPLATE;
  const vars = {
    name: firstName(lead),
    businessName: tenant.name,
    service: lead.requestedService ?? "",
    serviceClause: lead.requestedService ? ` with ${lead.requestedService}` : "",
  };
  return { channel, body: substituteTemplate(template, vars) };
}

/** Reason attached to a review-request plan, for consistency with the initial-contact/follow-up/win-back ContactReason shape. */
export function reviewRequestReason(): ContactReason {
  return { text: "one-time review request for a converted, opted-in past customer", grounded: true };
}
