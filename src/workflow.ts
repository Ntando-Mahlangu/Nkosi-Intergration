import type { ContactReason, Lead, Priority, RecoveryPlan, SkippedLead, Tenant, WorkflowResult } from "./types.js";
import type { LeadStore, MessageStore } from "./store/types.js";
import { checkSuppression } from "./compliance.js";
import { scoreLeads, sortByPriority } from "./scoring.js";
import { determineContactReason } from "./reason.js";
import { composeInitialMessage } from "./messaging.js";
import { safeSend, selectChannel, type SendResult } from "./channels/index.js";
import { isWithinQuietHours } from "./quietHours.js";
import { composeFollowUpMessage, followUpReason, getLeadsDueForFollowUp } from "./followup.js";
import { generateId } from "./idgen.js";

/**
 * Builds initial-outreach recovery plans (SYSTEM_PROMPT.md STEP 1-4) for
 * leads LeadRecovery has never contacted before, without sending anything.
 * Useful for dry runs, review UIs, and tests.
 */
export function buildRecoveryPlans(tenant: Tenant, leads: Lead[], now: Date = new Date()): WorkflowResult {
  const skipped: SkippedLead[] = [];
  const contactable: Lead[] = [];

  for (const lead of leads) {
    if (lead.firstOutreachSentAt) continue; // already got its initial LeadRecovery message; follow-ups handle it from here
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
    const channel = selectChannel(tenant, lead);
    if (!channel) {
      skipped.push({ lead, reason: "no usable contact channel (no phone/email, or no provider configured)" });
      continue;
    }
    const reason = determineContactReason(lead);
    const message = composeInitialMessage(lead, reason, channel, tenant);
    plans.push({ lead, priority, priorityReasons, reason, message });
  }

  return { plans, skipped };
}

/** Builds follow-up nudge plans for leads already past their initial message and due for another touch. */
export function buildFollowUpPlans(tenant: Tenant, leads: Lead[], now: Date = new Date()): WorkflowResult {
  const skipped: SkippedLead[] = [];
  const due = getLeadsDueForFollowUp(leads, now);
  const plans: RecoveryPlan[] = [];

  for (const lead of due) {
    const channel = selectChannel(tenant, lead);
    if (!channel) {
      skipped.push({ lead, reason: "no usable contact channel for follow-up" });
      continue;
    }
    const followUpIndex = lead.followUpCount ?? 0;
    const priority: Priority = "MEDIUM";
    const message = composeFollowUpMessage(lead, followUpIndex, channel, tenant);
    plans.push({
      lead,
      priority,
      priorityReasons: [`Follow-up #${followUpIndex + 1}`],
      reason: followUpReason(followUpIndex),
      message,
    });
  }

  return { plans, skipped };
}

export interface SentPlan {
  plan: RecoveryPlan;
  result: SendResult;
  isFollowUp: boolean;
}

export interface RecoveryRunResult extends WorkflowResult {
  sent: SentPlan[];
  deferred: SkippedLead[];
}

async function sendPlans(
  tenant: Tenant,
  store: LeadStore,
  messages: MessageStore | undefined,
  plans: RecoveryPlan[],
  isFollowUp: boolean,
  now: Date
): Promise<{ sent: SentPlan[]; deferred: SkippedLead[] }> {
  const sent: SentPlan[] = [];
  const deferred: SkippedLead[] = [];

  if (isWithinQuietHours(tenant, now)) {
    for (const plan of plans) {
      deferred.push({ lead: plan.lead, reason: "deferred: within tenant quiet hours, will retry next run" });
    }
    return { sent, deferred };
  }

  for (const plan of plans) {
    const messageId = generateId("msg");
    // safeSend never throws — a channel adapter can throw a real
    // provider-level error (Twilio/SendGrid rejecting a malformed number),
    // not just return {ok: false}, and without that guarantee one such
    // lead used to abort this whole loop, silently skipping every
    // remaining lead in this tenant's batch (and, for the initial batch,
    // the follow-up batch never even ran).
    const result = await safeSend(plan.message.channel, tenant, plan.lead, plan.message, messageId);
    sent.push({ plan, result, isFollowUp });

    if (result.ok) {
      await messages?.logMessage({
        id: messageId,
        tenantId: tenant.id,
        leadId: plan.lead.id,
        channel: plan.message.channel,
        direction: "outbound",
        body: plan.message.body,
        at: now.toISOString(),
        providerMessageId: result.providerMessageId,
      });

      const patch: Partial<Lead> = {
        status: "contacted_no_response",
        lastContactedAt: now.toISOString(),
      };
      if (isFollowUp) {
        patch.followUpCount = (plan.lead.followUpCount ?? 0) + 1;
        patch.nextFollowUpAt = undefined;
      } else {
        patch.firstOutreachSentAt = now.toISOString();
        patch.followUpCount = 0;
      }
      // Guarded on the lead's status still being what this plan was built
      // from: the send above (a real network call) can take long enough for
      // the lead to reply in the meantime — an inbound webhook recording
      // that reply (e.g. opted_out, do_not_contact, responded) races this
      // write, and without the guard this patch would blindly overwrite
      // that status back to "contacted_no_response".
      await store.updateLead(tenant.id, plan.lead.id, patch, { onlyIfStatusIn: [plan.lead.status] });
    }
  }

  return { sent, deferred };
}

/**
 * Runs the full recovery workflow for one tenant: identify, filter
 * (compliance), score, determine reason, compose, send (respecting quiet
 * hours), and log/update status back to the store. Covers both brand-new
 * leads (initial outreach) and leads due for a follow-up nudge.
 */
export async function runRecoveryWorkflow(
  tenant: Tenant,
  store: LeadStore,
  messages?: MessageStore,
  now: Date = new Date()
): Promise<RecoveryRunResult> {
  const leads = await store.getAllLeads(tenant.id);

  const initial = buildRecoveryPlans(tenant, leads, now);
  const followUps = buildFollowUpPlans(tenant, leads, now);

  const initialResult = await sendPlans(tenant, store, messages, initial.plans, false, now);
  const followUpResult = await sendPlans(tenant, store, messages, followUps.plans, true, now);

  return {
    plans: [...initial.plans, ...followUps.plans],
    skipped: [...initial.skipped, ...followUps.skipped],
    sent: [...initialResult.sent, ...followUpResult.sent],
    deferred: [...initialResult.deferred, ...followUpResult.deferred],
  };
}

export type { ContactReason };
