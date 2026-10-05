import type { Stores } from "./store/index.js";
import type { Lead, Message, ReplyClassification, Tenant } from "./types.js";
import { classifyReply } from "./reply/classify.js";
import { generateAutoReply } from "./chatbot.js";
import { composeCloserBody } from "./webhooks/index.js";
import { notifyHumanAttention } from "./notify.js";
import { generateId } from "./idgen.js";

export interface ChatWidgetReply {
  classification: ReplyClassification;
  /**
   * Always populated — never silence with no explanation. The bot's real
   * knowledge-base answer, the fixed not-interested close-out, or a fixed
   * hand-off/stop acknowledgment when there's nothing the widget itself can
   * show (see the fallbacks below).
   */
  displayText: string;
}

const ESCALATION_NOTICE = "Thanks for reaching out — one of our team will follow up with you shortly.";
const STOP_ACKNOWLEDGMENT = "You've been unsubscribed from automated messages. A person will follow up if needed.";

/**
 * The website-chat-widget equivalent of webhooks/index.ts's
 * recordInboundAndClassify — same classify → branch → compose pipeline
 * (STOP/not-interested/interested/question/unknown), reusing the exact same
 * classifier, chatbot, and closer-message logic a Twilio/SendGrid reply
 * gets. Deliberately NOT the same function: a chat reply must come back
 * synchronously in this HTTP response (there's no provider/channel to push
 * an async send through — the "channel" for a chat reply is this very
 * response), whereas the webhook path fires a real SMS/WhatsApp/email send.
 * "interested"/escalation still notifies the tenant's team exactly like any
 * other channel (src/notify.ts); the widget itself just shows a fixed
 * hand-off notice instead of waiting on a reply that will never come
 * through this channel.
 */
export async function answerChatMessage(
  stores: Stores,
  tenant: Tenant,
  lead: Lead,
  body: string,
  now: Date = new Date()
): Promise<ChatWidgetReply> {
  const history = await stores.messageStore.getMessagesForLead(tenant.id, lead.id);
  const classification = await classifyReply(body);

  await stores.messageStore.logMessage({
    id: generateId("msg"),
    tenantId: tenant.id,
    leadId: lead.id,
    channel: "chat",
    direction: "inbound",
    body,
    at: now.toISOString(),
    classification,
  });

  const logOutbound = (replyBody: string, kind: NonNullable<Message["kind"]>) =>
    stores.messageStore.logMessage({
      id: generateId("msg"),
      tenantId: tenant.id,
      leadId: lead.id,
      channel: "chat",
      direction: "outbound",
      body: replyBody,
      at: now.toISOString(),
      kind,
    });

  if (classification === "stop") {
    await stores.leadStore.updateLead(tenant.id, lead.id, { status: "opted_out" });
    return { classification, displayText: STOP_ACKNOWLEDGMENT };
  }

  if (classification === "not_interested") {
    await stores.leadStore.updateLead(tenant.id, lead.id, { status: "do_not_contact" });
    const replyBody = composeCloserBody(lead, tenant);
    await logOutbound(replyBody, "closer");
    return { classification, displayText: replyBody };
  }

  await stores.leadStore.updateLead(tenant.id, lead.id, { status: "responded" });

  if (classification === "interested") {
    void notifyHumanAttention(stores.notificationStore, tenant, lead, "chat", body, "interested");
    return { classification, displayText: ESCALATION_NOTICE };
  }

  // "question" or "unknown"
  const auto = await generateAutoReply(tenant, lead, history, body, now);
  if (auto.action === "reply" && auto.replyBody) {
    await logOutbound(auto.replyBody, "auto_reply");
    return { classification, displayText: auto.replyBody };
  }
  void notifyHumanAttention(stores.notificationStore, tenant, lead, "chat", body, "needs_human_reply");
  return { classification, displayText: ESCALATION_NOTICE };
}
