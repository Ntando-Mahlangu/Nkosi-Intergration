import type { ContactReason, Lead } from "./types.js";

/**
 * Determines a truthful reason for contact per SYSTEM_PROMPT.md STEP 3.
 * Only ever states things the lead data actually supports — never invents
 * an event. Returns `grounded: false` when nothing concrete is known, so
 * the messaging layer can fall back to a neutral reactivation message.
 */
export function determineContactReason(lead: Lead): ContactReason {
  if (lead.previousQuote) {
    return { text: "you previously requested a quote", grounded: true };
  }

  if (lead.hadMissedCall) {
    return { text: "we noticed we missed your call", grounded: true };
  }

  if (lead.requestedService && lead.appointmentStatus === "abandoned") {
    return {
      text: `you reached out about ${lead.requestedService} but never got a chance to book`,
      grounded: true,
    };
  }

  if (lead.requestedService && lead.previousConversationSummary) {
    return {
      text: `you previously spoke with our team about ${lead.requestedService}`,
      grounded: true,
    };
  }

  if (lead.requestedService) {
    return { text: `you previously asked about ${lead.requestedService}`, grounded: true };
  }

  if (lead.previousConversationSummary) {
    return { text: "you previously got in touch with us", grounded: true };
  }

  return { grounded: false };
}
