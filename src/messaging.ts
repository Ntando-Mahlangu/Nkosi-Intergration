import type { Channel, ComposedMessage, ContactReason, Lead, Tenant } from "./types.js";
import { substituteTemplate } from "./templateSubstitute.js";

function firstName(lead: Lead): string {
  if (!lead.name) return "there";
  return lead.name.trim().split(/\s+/)[0];
}

const DEFAULT_GROUNDED_TEMPLATE =
  "Hi {name}, this is {businessName} — {reason}. Is this still something you're looking for? " +
  "Reply STOP anytime if you'd rather not hear from us.";

const DEFAULT_UNGROUNDED_TEMPLATE =
  "Hi {name}, this is {businessName}. We wanted to check back in and see if you're still interested{serviceClause} " +
  "— happy to help whenever works for you. Reply STOP anytime if you'd rather not hear from us.";

/**
 * Composes the initial outreach message per SYSTEM_PROMPT.md STEP 4: short,
 * human, personalized, focused on the lead's previous interest, with one
 * clear next step and an easy, respectful way to opt out. Falls back to a
 * neutral reactivation message when the reason for contact isn't grounded
 * in known facts (never fabricates an event).
 *
 * Uses the tenant's own template override (tenant.templates.initialGrounded /
 * initialUngrounded) when set, otherwise the built-in default wording.
 */
export function composeInitialMessage(
  lead: Lead,
  reason: ContactReason,
  channel: Channel,
  tenant: Tenant
): ComposedMessage {
  const name = firstName(lead);
  const vars = {
    name,
    businessName: tenant.name,
    reason: reason.text ?? "",
    service: lead.requestedService ?? "",
    serviceClause: lead.requestedService ? ` in ${lead.requestedService}` : "",
  };

  const template =
    reason.grounded && reason.text
      ? (tenant.templates?.initialGrounded ?? DEFAULT_GROUNDED_TEMPLATE)
      : (tenant.templates?.initialUngrounded ?? DEFAULT_UNGROUNDED_TEMPLATE);

  return { channel, body: substituteTemplate(template, vars) };
}
