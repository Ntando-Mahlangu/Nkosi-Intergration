import type { Channel, ComposedMessage, ContactReason, Lead } from "./types.js";

export interface MessagingOptions {
  /** Name the message is sent from, e.g. "Nkosi Integrations" or an agent's name. */
  businessName: string;
}

const DEFAULT_OPTIONS: MessagingOptions = { businessName: "our team" };

function firstName(lead: Lead): string {
  if (!lead.name) return "there";
  return lead.name.trim().split(/\s+/)[0];
}

/**
 * Composes the initial outreach message per SYSTEM_PROMPT.md STEP 4: short,
 * human, personalized, focused on the lead's previous interest, with one
 * clear next step and an easy, respectful way to opt out. Falls back to a
 * neutral reactivation message when the reason for contact isn't grounded
 * in known facts (never fabricates an event).
 */
export function composeInitialMessage(
  lead: Lead,
  reason: ContactReason,
  channel: Channel,
  options: Partial<MessagingOptions> = {}
): ComposedMessage {
  const { businessName } = { ...DEFAULT_OPTIONS, ...options };
  const name = firstName(lead);

  const body = reason.grounded && reason.text
    ? `Hi ${name}, this is ${businessName} — ${reason.text}. Is this still something you're looking for? Reply STOP anytime if you'd rather not hear from us.`
    : `Hi ${name}, this is ${businessName}. We wanted to check back in and see if you're still interested${
        lead.requestedService ? ` in ${lead.requestedService}` : ""
      } — happy to help whenever works for you. Reply STOP anytime if you'd rather not hear from us.`;

  return { channel, body };
}
