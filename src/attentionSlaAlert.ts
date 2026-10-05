import type { Lead, Tenant } from "./types.js";
import type { LeadStore } from "./store/types.js";
import { isStaleAttentionItem } from "./attentionSla.js";
import { sendOperatorAlert } from "./operatorAlert.js";
import { logger } from "./logger.js";

/**
 * Fires a one-time operator alert (src/operatorAlert.ts — agency-facing,
 * not the tenant's own notifyWebhookUrl) for every lead still unresolved in
 * the needs-attention inbox past its tenant's configured SLA
 * (Tenant.attentionSlaHours). Runs for every tenant regardless of
 * status/terms-acceptance, same as the worker's own data-retention purge —
 * this is an agency monitoring concern, not a "send" gated by whether the
 * agency is currently allowed to message the tenant's leads. Sets
 * Lead.attentionAlertedAt so the same stale item never re-alerts on a
 * later tick; cleared along with needsAttentionAt once the lead is
 * replied to or marked handled (POST /leads/:id/reply, /mark-handled).
 *
 * Extracted out of src/worker.ts (which can't be imported directly in
 * tests — it installs process-level fatal-error handlers and a worker
 * lock as import-time side effects) so this function's own race-condition
 * fix (see the per-lead re-check below) has direct test coverage.
 */
export async function alertStaleAttentionItems(leadStore: LeadStore, tenants: Tenant[], now: Date): Promise<void> {
  for (const tenant of tenants) {
    if (!tenant.attentionSlaHours) continue;
    let leads: Lead[];
    try {
      leads = await leadStore.getAllLeads(tenant.id);
    } catch (err) {
      logger.error("attention_sla_list_failed", { tenantId: tenant.id, error: (err as Error).message });
      continue;
    }
    for (const lead of leads) {
      if (!isStaleAttentionItem(lead, tenant, now)) continue;

      // Re-checks immediately before writing: the `leads` snapshot above
      // can go stale by the time this lead's turn comes up in the loop —
      // an operator's reply/mark-handled, or a brand-new inbound message
      // (flagNeedsAttention), could have changed needsAttentionAt in the
      // meantime. Stamping attentionAlertedAt against a lead whose
      // needsAttentionAt no longer matches what was checked above would
      // permanently suppress the SLA alert for a genuinely new, separate
      // occurrence (isStaleAttentionItem short-circuits on any truthy
      // attentionAlertedAt, with no way to tell "already alerted for this
      // exact occurrence" apart from "already alerted for a stale one").
      let current: Lead | undefined;
      try {
        current = await leadStore.getLeadById(tenant.id, lead.id);
      } catch (err) {
        logger.error("attention_sla_recheck_failed", {
          tenantId: tenant.id,
          leadId: lead.id,
          error: (err as Error).message,
        });
        continue;
      }
      if (!current || current.needsAttentionAt !== lead.needsAttentionAt || current.attentionAlertedAt) continue;

      const waitHours = Math.round((now.getTime() - new Date(lead.needsAttentionAt!).getTime()) / (60 * 60 * 1000));
      void sendOperatorAlert(
        `Lead "${lead.name ?? lead.id}" for tenant "${tenant.name}" has been needing attention for ${waitHours}h (SLA: ${tenant.attentionSlaHours}h)`,
        { tenantId: tenant.id, leadId: lead.id, reason: lead.needsAttentionReason, waitHours }
      );
      try {
        await leadStore.updateLead(tenant.id, lead.id, { attentionAlertedAt: now.toISOString() });
      } catch (err) {
        logger.error("attention_sla_mark_failed", {
          tenantId: tenant.id,
          leadId: lead.id,
          error: (err as Error).message,
        });
      }
    }
  }
}
