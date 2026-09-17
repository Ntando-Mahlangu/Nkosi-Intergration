import express, { Router, type Request } from "express";
import twilio from "twilio";
import multer from "multer";
import type { Stores } from "../store/index.js";
import { classifyReply } from "../reply/classify.js";
import { generateAutoReply } from "../chatbot.js";
import { safeSend } from "../channels/index.js";
import { requireTenantAuth } from "../middleware/auth.js";
import { createWebhookLimiter } from "../middleware/rateLimit.js";
import { generateId } from "../idgen.js";
import { publicBaseUrl } from "../publicUrl.js";
import { safeCompare } from "../security.js";
import { substituteTemplate } from "../templateSubstitute.js";
import { notifyHumanAttention } from "../notify.js";
import { verifySendGridEventSignature } from "../sendgridVerify.js";
import { asyncHandler } from "../middleware/asyncHandler.js";
import { logger } from "../logger.js";
import type { ComposedMessage, Lead, LeadSource, Message, Tenant } from "../types.js";

const upload = multer();

const LEAD_SOURCES: ReadonlySet<LeadSource> = new Set([
  "crm",
  "website_form",
  "missed_call",
  "booking_software",
  "email",
  "sms",
  "whatsapp",
  "spreadsheet",
  "customer_database",
  "other",
]);

function normalizeSource(raw: unknown): LeadSource {
  return typeof raw === "string" && LEAD_SOURCES.has(raw as LeadSource) ? (raw as LeadSource) : "other";
}

/**
 * Twilio signs the exact URL it POSTed to. When PUBLIC_BASE_URL is
 * configured, use it — trusting req.protocol/req.get("host") instead only
 * works when this process is directly internet-facing, and silently breaks
 * signature verification behind a TLS-terminating proxy/load balancer that
 * doesn't forward the original scheme/host (or if it did, would be trusting
 * a client-influenceable Host header for a security check).
 */
function requestUrl(req: Request): string {
  const base = publicBaseUrl();
  if (base) return `${base}${req.originalUrl}`;
  return `${req.protocol}://${req.get("host")}${req.originalUrl}`;
}

const DEFAULT_NOT_INTERESTED_CLOSER =
  "No problem, {name} — thanks for letting us know! Feel free to reach out anytime if that changes.";

function firstName(lead: Lead): string {
  if (!lead.name) return "there";
  return lead.name.trim().split(/\s+/)[0];
}

function composeCloserBody(lead: Lead, tenant: Tenant): string {
  const template = tenant.templates?.notInterestedCloser ?? DEFAULT_NOT_INTERESTED_CLOSER;
  return substituteTemplate(template, { name: firstName(lead), businessName: tenant.name });
}

/** Sends a reply through the same channel the lead wrote in and logs it, tagged with what produced it. */
async function sendAndLog(
  stores: Stores,
  tenant: Tenant,
  lead: Lead,
  message: ComposedMessage,
  kind: NonNullable<Message["kind"]>
): Promise<void> {
  const messageId = generateId("msg");
  // safeSend never throws — a provider SDK (Twilio/SendGrid) can throw on a
  // provider-level error, not just return {ok: false}, and without that
  // guarantee it would turn what's really just "the auto-reply/closer
  // couldn't be sent" into a request failure for the whole inbound webhook.
  const result = await safeSend(message.channel, tenant, lead, message, messageId);
  if (!result.ok) {
    logger.error("send_failed", { kind, leadId: lead.id, channel: message.channel, detail: result.detail });
    return;
  }
  await stores.messageStore.logMessage({
    id: messageId,
    tenantId: tenant.id,
    leadId: lead.id,
    channel: message.channel,
    direction: "outbound",
    body: message.body,
    at: new Date().toISOString(),
    providerMessageId: result.providerMessageId,
    kind,
  });
}

/**
 * Records an inbound reply, classifies it, and decides what happens next:
 * - stop -> opt out, nothing else.
 * - interested -> notify the tenant's team; a human takes it from here.
 * - not_interested -> a fixed, no-LLM-needed polite close-out reply.
 * - question / unknown -> attempt a knowledge-base-grounded auto-reply
 *   (src/chatbot.ts); if it's disabled, not configured, or the model itself
 *   determines this needs a human (price negotiation, complaint, complex
 *   request, explicit ask for a person, or anything outside the knowledge
 *   base), notify the tenant's team instead of guessing.
 */
async function recordInboundAndClassify(
  stores: Stores,
  tenant: Tenant,
  lead: Lead,
  channel: Message["channel"],
  body: string
): Promise<{ classification: Awaited<ReturnType<typeof classifyReply>> }> {
  const history = await stores.messageStore.getMessagesForLead(tenant.id, lead.id);
  const classification = await classifyReply(body);

  await stores.messageStore.logMessage({
    id: generateId("msg"),
    tenantId: tenant.id,
    leadId: lead.id,
    channel,
    direction: "inbound",
    body,
    at: new Date().toISOString(),
    classification,
  });

  if (classification === "stop") {
    await stores.leadStore.updateLead(tenant.id, lead.id, { status: "opted_out" });
    return { classification };
  }

  // SYSTEM_PROMPT.md STEP 4: "mark the lead as opted out / do-not-contact"
  // on any negative signal, not just an explicit STOP — do_not_contact is
  // one of compliance.ts's SUPPRESSED_STATUSES, so this actually stops the
  // lead from being recontacted; "responded" (used below for every other
  // classification) is not suppressed and would leave them contactable.
  if (classification === "not_interested") {
    await stores.leadStore.updateLead(tenant.id, lead.id, { status: "do_not_contact" });
    await sendAndLog(stores, tenant, lead, { channel, body: composeCloserBody(lead, tenant) }, "closer");
    return { classification };
  }

  await stores.leadStore.updateLead(tenant.id, lead.id, { status: "responded" });

  if (classification === "interested") {
    void notifyHumanAttention(stores.notificationStore, tenant, lead, channel, body, "interested");
    return { classification };
  }

  // "question" or "unknown"
  const auto = await generateAutoReply(tenant, lead, history, body);
  if (auto.action === "reply" && auto.replyBody) {
    await sendAndLog(stores, tenant, lead, { channel, body: auto.replyBody }, "auto_reply");
  } else {
    void notifyHumanAttention(stores.notificationStore, tenant, lead, channel, body, "needs_human_reply");
  }

  return { classification };
}

/**
 * Inbound webhooks: Twilio SMS/voice-status/delivery-status (signature-
 * verified per tenant), SendGrid inbound parse + delivery events, and a
 * generic JSON lead-intake endpoint for connecting an arbitrary CRM via an
 * outgoing webhook or a Zapier/Make/n8n automation. All routes are rate
 * limited against flooding/abuse.
 */
export function createWebhookRoutes(stores: Stores): Router {
  const router = Router();
  // Scoped to /webhooks/* specifically — this router is mounted at the app
  // root with no path prefix (see server.ts), so an unscoped `router.use(...)`
  // here would run for every request the whole app receives (health checks,
  // the dashboards, /admin/*, /leads, ...), not just webhook traffic,
  // sharing one 120/min-per-IP budget across everything.
  router.use("/webhooks", createWebhookLimiter());

  // --- Twilio inbound SMS/WhatsApp replies ---
  router.post(
    "/webhooks/:tenantId/twilio/sms",
    express.urlencoded({ extended: false }),
    asyncHandler(async (req, res) => {
      const tenant = await stores.tenantStore.getTenant(req.params.tenantId);
      const authToken = tenant?.channels.sms?.authToken ?? tenant?.channels.whatsapp?.authToken;
      if (!tenant || !authToken) {
        res.status(404).send();
        return;
      }

      const signature = req.header("x-twilio-signature") ?? "";
      const valid = twilio.validateRequest(authToken, signature, requestUrl(req), req.body);
      if (!valid) {
        res.status(403).send("invalid Twilio signature");
        return;
      }

      // A suspended tenant (see PATCH /admin/tenants/:id) must be fully
      // paused — no classification, no auto-reply/closer sends, no
      // notifications — not just blocked from the authenticated tenant API.
      // Responds exactly like "no lead matched" so this isn't distinguishable
      // from ordinary traffic and Twilio doesn't retry it as an error.
      if (tenant.status === "suspended") {
        res.type("text/xml").send("<Response></Response>");
        return;
      }

      const from = req.body.From as string | undefined;
      const body = (req.body.Body as string | undefined) ?? "";
      // Twilio's WhatsApp `From` is "whatsapp:+2782..." — stored lead phone
      // numbers are always bare E.164 (the "whatsapp:" prefix is only ever
      // added when *sending*, see src/channels/whatsapp.ts's toWhatsAppAddress),
      // so this must be stripped before the lookup or a genuine WhatsApp reply
      // never matches its lead at all.
      const channel = from?.startsWith("whatsapp:") ? "whatsapp" : "sms";
      const phone = from?.replace(/^whatsapp:/, "");
      const lead = phone ? await stores.leadStore.findLeadByContact(tenant.id, { phone }) : undefined;

      if (lead) {
        await recordInboundAndClassify(stores, tenant, lead, channel, body);
      }

      res.type("text/xml").send("<Response></Response>");
    })
  );

  // --- Twilio voice status callback: detects missed calls ---
  router.post(
    "/webhooks/:tenantId/twilio/voice-status",
    express.urlencoded({ extended: false }),
    asyncHandler(async (req, res) => {
      const tenant = await stores.tenantStore.getTenant(req.params.tenantId);
      if (!tenant?.channels.sms) {
        res.status(404).send();
        return;
      }

      const signature = req.header("x-twilio-signature") ?? "";
      const valid = twilio.validateRequest(tenant.channels.sms.authToken, signature, requestUrl(req), req.body);
      if (!valid) {
        res.status(403).send("invalid Twilio signature");
        return;
      }

      // See the identical suspended-tenant check in the /twilio/sms route above.
      if (tenant.status === "suspended") {
        res.status(204).send();
        return;
      }

      const from = req.body.From as string | undefined;
      const callStatus = req.body.CallStatus as string | undefined;
      const missed = callStatus === "no-answer" || callStatus === "busy" || callStatus === "failed";

      if (from && missed) {
        const lead = await stores.leadStore.findLeadByContact(tenant.id, { phone: from });
        if (lead) {
          await stores.leadStore.updateLead(tenant.id, lead.id, { hadMissedCall: true });
        } else {
          await stores.leadStore.createLead({
            id: generateId("lead"),
            tenantId: tenant.id,
            phone: from,
            source: "missed_call",
            createdAt: new Date().toISOString(),
            status: "new",
            hadMissedCall: true,
          });
        }
      }

      res.status(204).send();
    })
  );

  // --- Twilio delivery-status callback (SMS/WhatsApp): queued/sent/delivered/failed/undelivered ---
  router.post(
    "/webhooks/:tenantId/twilio/status",
    express.urlencoded({ extended: false }),
    asyncHandler(async (req, res) => {
      const tenant = await stores.tenantStore.getTenant(req.params.tenantId);
      const authToken = tenant?.channels.sms?.authToken ?? tenant?.channels.whatsapp?.authToken;
      if (!tenant || !authToken) {
        res.status(404).send();
        return;
      }

      const signature = req.header("x-twilio-signature") ?? "";
      const valid = twilio.validateRequest(authToken, signature, requestUrl(req), req.body);
      if (!valid) {
        res.status(403).send("invalid Twilio signature");
        return;
      }

      // See the identical suspended-tenant check in the /twilio/sms route above.
      if (tenant.status === "suspended") {
        res.status(204).send();
        return;
      }

      const messageId = req.query.messageId as string | undefined;
      const status = req.body.MessageStatus as string | undefined;
      if (messageId && status) {
        await stores.messageStore.updateMessageStatus(tenant.id, messageId, status);
      }

      res.status(204).send();
    })
  );

  // --- SendGrid inbound parse (email replies) ---
  // SendGrid posts multipart/form-data and (without the paid signed-webhook
  // feature) doesn't sign requests — a `?token=<tenant api key>` shared
  // secret is a pragmatic MVP guard; swap for SendGrid's signed webhook
  // verification before handling real client traffic (see COMPLIANCE.md).
  router.post(
    "/webhooks/:tenantId/sendgrid/email",
    upload.none(),
    asyncHandler(async (req, res) => {
      const tenant = await stores.tenantStore.getTenant(req.params.tenantId);
      if (!tenant) {
        res.status(404).send();
        return;
      }
      const token = req.query.token;
      if (typeof token !== "string" || !safeCompare(token, tenant.apiKey)) {
        res.status(403).send("invalid token");
        return;
      }

      // See the identical suspended-tenant check in the /twilio/sms route above.
      if (tenant.status === "suspended") {
        res.status(204).send();
        return;
      }

      const from = req.body.from as string | undefined;
      const emailMatch = from?.match(/<([^>]+)>/);
      const fromEmail = (emailMatch ? emailMatch[1] : from)?.trim();
      const text = (req.body.text as string | undefined) ?? "";

      const lead = fromEmail ? await stores.leadStore.findLeadByContact(tenant.id, { email: fromEmail }) : undefined;
      if (lead) {
        await recordInboundAndClassify(stores, tenant, lead, "email", text);
      }

      res.status(204).send();
    })
  );

  // --- SendGrid Event Webhook (delivery/bounce/etc.) ---
  // Real ECDSA signature verification when the tenant has configured
  // channels.email.eventWebhookPublicKey (SendGrid's "Signed Event Webhook"
  // setting); otherwise falls back to the same pragmatic ?token= guard used
  // by inbound parse below. Needs the exact raw request bytes to verify, so
  // this captures them via express.json's `verify` hook rather than
  // re-serializing the parsed body (which could differ byte-for-byte from
  // what SendGrid actually signed).
  router.post(
    "/webhooks/:tenantId/sendgrid/events",
    express.json({
      verify: (req, _res, buf) => {
        (req as Request & { rawBody?: Buffer }).rawBody = buf;
      },
    }),
    asyncHandler(async (req, res) => {
      const tenant = await stores.tenantStore.getTenant(req.params.tenantId);
      if (!tenant) {
        res.status(404).send();
        return;
      }

      const publicKey = tenant.channels.email?.eventWebhookPublicKey;
      if (publicKey) {
        const signature = req.header("x-twilio-email-event-webhook-signature");
        const timestamp = req.header("x-twilio-email-event-webhook-timestamp");
        const rawBody = (req as Request & { rawBody?: Buffer }).rawBody;
        if (
          !signature ||
          !timestamp ||
          !rawBody ||
          !verifySendGridEventSignature(publicKey, rawBody.toString("utf8"), signature, timestamp)
        ) {
          res.status(403).send("invalid signature");
          return;
        }
      } else {
        const token = req.query.token;
        if (typeof token !== "string" || !safeCompare(token, tenant.apiKey)) {
          res.status(403).send("invalid token");
          return;
        }
      }

      // See the identical suspended-tenant check in the /twilio/sms route above.
      if (tenant.status === "suspended") {
        res.status(204).send();
        return;
      }

      const events = Array.isArray(req.body) ? req.body : [];
      for (const event of events) {
        const messageId = event?.leadrecovery_message_id;
        const status = event?.event;
        if (typeof messageId === "string" && typeof status === "string") {
          await stores.messageStore.updateMessageStatus(tenant.id, messageId, status);
        }
      }

      res.status(204).send();
    })
  );

  // --- Generic lead intake (CRM outgoing webhook / Zapier / Make / n8n) ---
  router.post(
    "/webhooks/lead",
    express.json(),
    requireTenantAuth(stores.tenantStore),
    asyncHandler(async (req, res) => {
      const tenant = req.tenant!;
      const body = req.body as Partial<Lead>;

      if (!body.phone && !body.email) {
        res.status(400).json({ error: "at least one of phone or email is required" });
        return;
      }

      const lead: Lead = {
        id: generateId("lead"),
        tenantId: tenant.id,
        name: body.name,
        phone: body.phone,
        email: body.email,
        source: normalizeSource(body.source),
        createdAt: new Date().toISOString(),
        status: "new",
        requestedService: body.requestedService,
        previousQuote: body.previousQuote,
        previousConversationSummary: body.previousConversationSummary,
        appointmentStatus: body.appointmentStatus,
        notes: body.notes,
        hadMissedCall: body.hadMissedCall,
        preferredChannel: body.preferredChannel,
      };

      const created = await stores.leadStore.createLead(lead);
      res.status(201).json(created);
    })
  );

  return router;
}
