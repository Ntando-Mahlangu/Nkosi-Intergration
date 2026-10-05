import type { Lead, LeadStatus, Tenant } from "./types.js";

/** Applied when a tenant hasn't set its own `dataRetentionDays` override. */
export const DEFAULT_DATA_RETENTION_DAYS = 365;

/** A tenant-configured `dataRetentionDays` must be within this range — see routes/tenants.ts validation. */
export const MIN_DATA_RETENTION_DAYS = 30;
export const MAX_DATA_RETENTION_DAYS = 3650;

/**
 * Statuses eligible for automatic data-retention purging: a lead fully
 * closed out with no further contact planned, AND no ongoing obligation to
 * remember *why* it's closed out. An active/in-flight lead (new,
 * contacted_no_response, responded, booked, active_conversation) is never
 * auto-purged regardless of age, since it's still part of the business's
 * live pipeline.
 *
 * Deliberately excludes "opted_out" and "do_not_contact": those two are the
 * system's only record that a specific phone/email must not be re-contacted
 * (checkSuppression in compliance.ts). Leads aren't deduplicated against
 * existing records on import (see leadImport.ts) or matched by contact info
 * except on an inbound reply — so purging an opted-out lead would let a
 * later re-import of the same contact (e.g. a refreshed CRM export) come
 * back in as a brand-new "new" lead with no memory of the prior opt-out,
 * and get messaged again. That's a real TCPA/CAN-SPAM re-contact risk, not
 * just a data-hygiene tradeoff — so these two are exempt regardless of how
 * old they are. "unqualified"/"fraudulent"/"converted" carry no such
 * ongoing suppression obligation and are safe to purge.
 */
const PURGE_ELIGIBLE_STATUSES: ReadonlySet<LeadStatus> = new Set(["unqualified", "fraudulent", "converted"]);

export function retentionDaysFor(tenant: Pick<Tenant, "dataRetentionDays">): number {
  return tenant.dataRetentionDays ?? DEFAULT_DATA_RETENTION_DAYS;
}

/**
 * True if `lead` is both closed-out and purge-eligible (PURGE_ELIGIBLE_STATUSES)
 * and has been inactive for at least `retentionDays` — the two conditions
 * the worker's purge (see worker.ts) requires before permanently deleting a
 * lead and its message history. Ages off whichever of `lastContactedAt`/
 * `lastWinBackAt` is more recent (falling back to `createdAt` if neither is
 * set — a lead imported already-closed and never actually contacted).
 *
 * lastWinBackAt matters here because sendWinBackPlans (workflow.ts)
 * deliberately never touches lastContactedAt when it sends a win-back
 * check-in — correctly, so a win-back send doesn't look like a fresh
 * contacted_no_response cycle. But that means a converted lead with
 * marketingOptIn getting periodic win-backs for years would otherwise
 * still age off its frozen original lastContactedAt and get purged —
 * destroying the exact marketingOptIn/consent record this function's own
 * opted_out/do_not_contact exemption above exists to protect, for the
 * identical reason: a later re-import of the same contact would come back
 * in as a brand-new lead with no memory of what they'd opted into.
 */
export function isPastRetention(lead: Lead, retentionDays: number, now: Date = new Date()): boolean {
  if (!PURGE_ELIGIBLE_STATUSES.has(lead.status)) return false;
  const candidates = [lead.lastContactedAt, lead.lastWinBackAt, lead.createdAt].filter((t): t is string => Boolean(t));
  const reference = candidates.reduce((latest, t) => (new Date(t) > new Date(latest) ? t : latest));
  const ageMs = now.getTime() - new Date(reference).getTime();
  return ageMs >= retentionDays * 24 * 60 * 60 * 1000;
}
