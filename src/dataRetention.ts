import type { Lead, LeadStatus, Tenant } from "./types.js";

/** Applied when a tenant hasn't set its own `dataRetentionDays` override. */
export const DEFAULT_DATA_RETENTION_DAYS = 365;

/** A tenant-configured `dataRetentionDays` must be within this range — see routes/tenants.ts validation. */
export const MIN_DATA_RETENTION_DAYS = 30;
export const MAX_DATA_RETENTION_DAYS = 3650;

/**
 * Statuses that mean a lead is fully closed out — no further contact is
 * planned, ever. Only these are eligible for automatic data-retention
 * purging; an active/in-flight lead (new, contacted_no_response,
 * responded, booked, active_conversation) is never auto-purged regardless
 * of age, since it's still part of the business's live pipeline.
 */
const TERMINAL_STATUSES: ReadonlySet<LeadStatus> = new Set([
  "do_not_contact",
  "unqualified",
  "fraudulent",
  "converted",
  "opted_out",
]);

export function retentionDaysFor(tenant: Pick<Tenant, "dataRetentionDays">): number {
  return tenant.dataRetentionDays ?? DEFAULT_DATA_RETENTION_DAYS;
}

/**
 * True if `lead` is both closed-out (TERMINAL_STATUSES) and has been
 * inactive for at least `retentionDays` — the two conditions the worker's
 * purge (see worker.ts) requires before permanently deleting a lead and its
 * message history. Ages off `lastContactedAt` when set, otherwise
 * `createdAt` (a lead that was imported already-closed and never actually
 * contacted).
 */
export function isPastRetention(lead: Lead, retentionDays: number, now: Date = new Date()): boolean {
  if (!TERMINAL_STATUSES.has(lead.status)) return false;
  const reference = lead.lastContactedAt ?? lead.createdAt;
  const ageMs = now.getTime() - new Date(reference).getTime();
  return ageMs >= retentionDays * 24 * 60 * 60 * 1000;
}
