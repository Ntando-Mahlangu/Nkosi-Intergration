import type { ComposedMessage, Channel, ContactReason, Lead, Tenant } from "./types.js";
import { substituteTemplate } from "./templateSubstitute.js";

/** Default cooldown between win-back check-ins for a tenant that hasn't set its own `winBackCooldownDays`. */
export const DEFAULT_WIN_BACK_COOLDOWN_DAYS = 180;

function daysSince(isoDate: string, now: Date): number {
  return (now.getTime() - new Date(isoDate).getTime()) / (1000 * 60 * 60 * 24);
}

function firstName(lead: Lead): string {
  if (!lead.name) return "there";
  return lead.name.trim().split(/\s+/)[0];
}

/**
 * A past customer is due for a periodic win-back check-in when: the tenant
 * has deliberately turned the feature on, the lead has already converted
 * (never a prospect that hasn't bought anything yet — that's the initial-
 * outreach/follow-up job instead), the *lead themselves* has an explicit
 * marketing opt-in on file (POPIA section 69 requires opt-in for direct
 * marketing — this is marketing to an existing customer, not the original
 * transactional "you asked about X" outreach, so the tenant-level
 * consentBasisConfirmedAt from onboarding does NOT cover it; see
 * COMPLIANCE.md "Win-back messaging for past customers"), and the cooldown
 * since the last check-in (or since conversion, if none yet) has elapsed.
 * Any status change away from "converted" (e.g. a STOP reply flips it to
 * opted_out) immediately and permanently removes a lead from this list,
 * the same way isDueForFollowUp works.
 */
export function isDueForWinBack(tenant: Tenant, lead: Lead, now: Date = new Date()): boolean {
  if (!tenant.winBackEnabled) return false;
  if (lead.status !== "converted") return false;
  if (!lead.marketingOptIn) return false;
  const cooldownDays = tenant.winBackCooldownDays ?? DEFAULT_WIN_BACK_COOLDOWN_DAYS;
  const since = lead.lastWinBackAt ?? lead.convertedAt ?? lead.createdAt;
  return daysSince(since, now) >= cooldownDays;
}

export function getLeadsDueForWinBack(tenant: Tenant, leads: Lead[], now: Date = new Date()): Lead[] {
  return leads.filter((lead) => isDueForWinBack(tenant, lead, now));
}

const DEFAULT_WIN_BACK_TEMPLATE =
  "Hi {name}, it's been a while since {businessName} last helped you{serviceClause} — if you ever need us " +
  "again, we'd love to. Reply STOP anytime to stop these occasional check-ins.";

/**
 * Composes a periodic win-back nudge for a past customer. Uses the tenant's
 * own template override (tenant.templates.winBack) when set, otherwise the
 * built-in default — same substitution convention as composeInitialMessage
 * (src/messaging.ts), never fabricating a service the lead never mentioned.
 */
export function composeWinBackMessage(lead: Lead, channel: Channel, tenant: Tenant): ComposedMessage {
  const template = tenant.templates?.winBack ?? DEFAULT_WIN_BACK_TEMPLATE;
  const vars = {
    name: firstName(lead),
    businessName: tenant.name,
    service: lead.requestedService ?? "",
    serviceClause: lead.requestedService ? ` with ${lead.requestedService}` : "",
  };
  return { channel, body: substituteTemplate(template, vars) };
}

/** Reason attached to a win-back plan, for consistency with the initial-contact/follow-up ContactReason shape. */
export function winBackReason(): ContactReason {
  return { text: "periodic win-back check-in for a past customer who opted in to it", grounded: true };
}
