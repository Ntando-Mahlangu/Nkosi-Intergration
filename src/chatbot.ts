import Anthropic from "@anthropic-ai/sdk";
import { logger } from "./logger.js";
import type { Lead, Message, Tenant } from "./types.js";

export interface ChatbotResult {
  action: "reply" | "escalate" | "disabled";
  replyBody?: string;
}

/** The model is instructed to reply with exactly this word (optionally with trailing punctuation) to hand off to a human. */
const ESCALATE_PATTERN = /^escalate[.!]?$/i;

/** Caps how much prior conversation gets sent to Claude on each call, bounding token cost/context growth for a long-running lead relationship. */
const MAX_HISTORY_MESSAGES = 16;

/** Per-lead throttle: beyond this many auto-replies within RATE_WINDOW_MS, escalate instead of calling the model again — guards against runaway cost/abuse from one chatty (or malicious) conversation. */
const MAX_AUTO_REPLIES_PER_WINDOW = 5;
const RATE_WINDOW_MS = 60 * 60 * 1000;

/**
 * Prepended once, to the first auto-reply of a conversation, when
 * tenant.botDisclosureEnabled isn't explicitly false — several jurisdictions
 * require proactively disclosing an automated system in commercial
 * messaging (e.g. California's B.O.T. Act) rather than only disclosing when
 * asked. See COMPLIANCE.md "Bot disclosure".
 */
const BOT_DISCLOSURE_NOTE = "(Just so you know, you're chatting with an automated assistant.)";

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

/**
 * Maps prior Message history to Anthropic's turn format: keeps only the most
 * recent MAX_HISTORY_MESSAGES (bounding context size/cost for a long-running
 * lead relationship), then starts from the first inbound (user) message
 * within that window — a leading run of outbound-only history (e.g. the
 * initial campaign message) would violate the "first message must be user"
 * rule otherwise.
 *
 * Also merges consecutive same-role turns instead of emitting them back to
 * back: the Messages API requires strictly alternating user/assistant turns,
 * but this app's own message log doesn't guarantee that alternation — an
 * escalated inbound message never gets an outbound reply logged for it (see
 * notifyHumanAttention in src/webhooks/index.ts), so a lead sending a second
 * message before anyone replies would otherwise produce two consecutive
 * "user" turns and make every later call for that lead fail (and silently
 * auto-escalate) forever.
 */
function toClaudeMessages(history: Message[], incomingBody: string): Anthropic.MessageParam[] {
  const recent = history.slice(-MAX_HISTORY_MESSAGES);
  const firstInboundIndex = recent.findIndex((m) => m.direction === "inbound");
  const trimmed = firstInboundIndex === -1 ? [] : recent.slice(firstInboundIndex);

  const messages: Anthropic.MessageParam[] = [];
  const pushTurn = (role: "user" | "assistant", content: string) => {
    const last = messages[messages.length - 1];
    if (last && last.role === role) {
      last.content = `${last.content as string}\n${content}`;
    } else {
      messages.push({ role, content });
    }
  };
  for (const m of trimmed) pushTurn(m.direction === "inbound" ? "user" : "assistant", m.body);
  pushTurn("user", incomingBody);
  return messages;
}

/** How many auto_reply-kind outbound messages this lead has already received within the rate-limit window. */
function recentAutoReplyCount(history: Message[], now: Date): number {
  const cutoff = now.getTime() - RATE_WINDOW_MS;
  return history.filter((m) => m.kind === "auto_reply" && new Date(m.at).getTime() >= cutoff).length;
}

/**
 * Generates a knowledge-base-grounded auto-reply for an inbound question,
 * or signals that this should be escalated to a human instead. Opt-in per
 * tenant (autoReplyEnabled + knowledgeBase both required) and fails safe:
 * any API error, missing config, a model response that isn't a clean
 * answer, or exceeding the per-lead rate limit all result in "escalate" —
 * this never fabricates an answer it isn't confident is grounded in the
 * tenant's own knowledge base, and never lets one conversation run away
 * unbounded cost.
 */
export async function generateAutoReply(
  tenant: Tenant,
  lead: Lead,
  history: Message[],
  incomingBody: string,
  now: Date = new Date()
): Promise<ChatbotResult> {
  if (!tenant.autoReplyEnabled || !tenant.knowledgeBase?.trim()) {
    return { action: "disabled" };
  }

  if (recentAutoReplyCount(history, now) >= MAX_AUTO_REPLIES_PER_WINDOW) {
    return { action: "escalate" };
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

    const disclosureEnabled = tenant.botDisclosureEnabled !== false;
    const isFirstAutoReply = !history.some((m) => m.kind === "auto_reply");
    const replyBody = disclosureEnabled && isFirstAutoReply ? `${BOT_DISCLOSURE_NOTE}\n\n${text}` : text;
    return { action: "reply", replyBody };
  } catch (err) {
    logger.error("chatbot_reply_failed", { tenantId: tenant.id, leadId: lead.id, error: (err as Error).message });
    return { action: "escalate" };
  }
}
