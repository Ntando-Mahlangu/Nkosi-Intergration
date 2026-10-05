import type { Lead, Tenant } from "./types.js";

/**
 * True if `lead` is still unresolved in the needs-attention inbox
 * (Lead.needsAttentionAt set), has been that way for at least the tenant's
 * configured SLA (Tenant.attentionSlaHours), and hasn't already triggered
 * an alert for this specific unresolved item (Lead.attentionAlertedAt) —
 * used by the worker (src/worker.ts's alertStaleAttentionItems) to fire a
 * one-time sendOperatorAlert per stale item instead of re-alerting every
 * tick. A tenant with no attentionSlaHours configured never alerts — this
 * is opt-in (see Tenant.attentionSlaHours's own doc comment).
 */
export function isStaleAttentionItem(
  lead: Lead,
  tenant: Pick<Tenant, "attentionSlaHours">,
  now: Date = new Date()
): boolean {
  if (!tenant.attentionSlaHours) return false;
  if (!lead.needsAttentionAt || lead.attentionAlertedAt) return false;
  const ageMs = now.getTime() - new Date(lead.needsAttentionAt).getTime();
  return ageMs >= tenant.attentionSlaHours * 60 * 60 * 1000;
}
