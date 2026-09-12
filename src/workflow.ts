import type { Lead, RecoveryPlan, SkippedLead, WorkflowResult } from "./types.js";
import type { LeadStore } from "./store/leadStore.js";
import { checkSuppression } from "./compliance.js";
import { scoreLeads, sortByPriority } from "./scoring.js";
import { determineContactReason } from "./reason.js";
import { composeInitialMessage, type MessagingOptions } from "./messaging.js";
import { getAdapter, selectChannel, type SendResult } from "./channels/index.js";

/**
 * Builds a recovery plan per lead without sending anything (STEP 1-4 minus
 * the actual send). Useful for dry runs, review UIs, and tests.
 */
export function buildRecoveryPlans(
  leads: Lead[],
  options: Partial<MessagingOptions> = {},
  now: Date = new Date()
): WorkflowResult {
  const skipped: SkippedLead[] = [];
  const contactable: Lead[] = [];

  for (const lead of leads) {
    const suppression = checkSuppression(lead);
    if (suppression.suppressed) {
      skipped.push({ lead, reason: suppression.reason ?? "suppressed" });
      continue;
    }
    contactable.push(lead);
  }

  const scored = sortByPriority(scoreLeads(contactable, now));

  const plans: RecoveryPlan[] = [];
  for (const { lead, priority, priorityReasons } of scored) {
    const channel = selectChannel(lead);
    if (!channel) {
      skipped.push({ lead, reason: "no usable contact channel (no phone or email on file)" });
      continue;
    }
    const reason = determineContactReason(lead);
    const message = composeInitialMessage(lead, reason, channel, options);
    plans.push({ lead, priority, priorityReasons, reason, message });
  }

  return { plans, skipped };
}

export interface SentPlan {
  plan: RecoveryPlan;
  result: SendResult;
}

export interface RecoveryRunResult extends WorkflowResult {
  sent: SentPlan[];
}

/**
 * Runs the full recovery workflow against a LeadStore: identify, filter
 * (compliance), score, determine reason, compose, send, and log/update
 * status back to the store (STEP 1-4 end to end).
 */
export async function runRecoveryWorkflow(
  store: LeadStore,
  options: Partial<MessagingOptions> = {},
  now: Date = new Date()
): Promise<RecoveryRunResult> {
  const leads = await store.getAllLeads();
  const { plans, skipped } = buildRecoveryPlans(leads, options, now);

  const sent: SentPlan[] = [];
  for (const plan of plans) {
    const adapter = getAdapter(plan.message.channel);
    const result = await adapter.send(plan.lead, plan.message);
    sent.push({ plan, result });
    if (result.ok) {
      await store.updateLead(plan.lead.id, {
        status: "contacted_no_response",
        lastContactedAt: now.toISOString(),
      });
    }
  }

  return { plans, skipped, sent };
}
