import Anthropic from "@anthropic-ai/sdk";
import type { Lead, Message, Tenant } from "./types.js";

export interface ChatbotResult {
  action: "reply" | "escalate" | "disabled";
  replyBody?: string;
}

/** The model is instructed to reply with exactly this word (optionally with trailing punctuation) to hand off to a human. */
const ESCALATE_PATTERN = /^escalate[.!]?$/i;

function buildSystemPrompt(tenant: Tenant, lead: Lead): string {
  return [
    `You are answering customer messages on behalf of ${tenant.name}.`,
    "Answer ONLY using the knowledge base below. Never invent prices, availability, policies, or any fact it doesn't state.",
    lead.requestedService ? `This customer previously asked about: ${lead.requestedService}.` : undefined,
    "",
    "KNOWLEDGE BASE:",
    tenant.knowledgeBase ?? "",
    "",
    "Rules:",
    "- If the customer's message negotiates price/discounts, is a complaint, is a complex or multi-part " +
      "request, explicitly asks for a human/real person, or asks anything the knowledge base above does not " +
      'clearly answer — reply with EXACTLY the single word "ESCALATE" and nothing else.',
    "- Otherwise, write a short, friendly, natural reply (1-3 sentences, suitable for SMS/WhatsApp) that " +
      "answers using only the knowledge base.",
    "- If asked directly whether you are a bot/AI/automated system, answer honestly — never claim to be human.",
  ]
    .filter((line) => line !== undefined)
    .join("\n");
}

/** Maps prior Message history to Anthropic's turn format, starting from the first inbound (user) message — a leading run of outbound-only history (e.g. the initial campaign message) would violate the "first message must be user" rule otherwise. */
function toClaudeMessages(history: Message[], incomingBody: string): Anthropic.MessageParam[] {
  const firstInboundIndex = history.findIndex((m) => m.direction === "inbound");
  const trimmed = firstInboundIndex === -1 ? [] : history.slice(firstInboundIndex);
  const messages: Anthropic.MessageParam[] = trimmed.map((m) => ({
    role: m.direction === "inbound" ? "user" : "assistant",
    content: m.body,
  }));
  messages.push({ role: "user", content: incomingBody });
  return messages;
}

/**
 * Generates a knowledge-base-grounded auto-reply for an inbound question,
 * or signals that this should be escalated to a human instead. Opt-in per
 * tenant (autoReplyEnabled + knowledgeBase both required) and fails safe:
 * any API error, missing config, or a model response that isn't a clean
 * answer results in "escalate" — this never fabricates an answer it isn't
 * confident is grounded in the tenant's own knowledge base.
 */
export async function generateAutoReply(
  tenant: Tenant,
  lead: Lead,
  history: Message[],
  incomingBody: string
): Promise<ChatbotResult> {
  if (!tenant.autoReplyEnabled || !tenant.knowledgeBase?.trim()) {
    return { action: "disabled" };
  }

  try {
    const client = new Anthropic();
    const response = await client.messages.create({
      model: "claude-opus-5",
      max_tokens: 300,
      output_config: { effort: "medium" },
      system: buildSystemPrompt(tenant, lead),
      messages: toClaudeMessages(history, incomingBody),
    });

    const textBlock = response.content.find((block): block is Anthropic.TextBlock => block.type === "text");
    const text = textBlock?.text.trim();

    if (!text || ESCALATE_PATTERN.test(text)) {
      return { action: "escalate" };
    }
    return { action: "reply", replyBody: text };
  } catch (err) {
    console.error("generateAutoReply failed, escalating to a human:", err);
    return { action: "escalate" };
  }
}
