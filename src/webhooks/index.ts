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
import { sendOperatorAlert } from "../operatorAlert.js";
import { verifySendGridEventSignature } from "../sendgridVerify.js";
import { verifyPaddleSignature, compareIsoTimestamps } from "../paddleVerify.js";
import { recordAudit } from "../audit.js";
import { asyncHandler } from "../middleware/asyncHandler.js";
import { logger } from "../logger.js";
import type { ComposedMessage, Lead, LeadSource, Message, Tenant } from "../types.js";
import { isLeadSource } from "../types.js";

const upload = multer();

function normalizeSource(raw: unknown): LeadSource {
  return isLeadSource(raw) ? raw : "other";
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

/**
 * A tenant can configure independent Twilio credentials per channel (e.g. a
 * different (sub)account for WhatsApp than for SMS), but /twilio/sms and
 * /twilio/status are shared endpoints for both channels. Validating only
 * against the SMS token would reject every genuine WhatsApp request's
 * signature (and vice versa) whenever the two tokens actually differ,
 * silently 403ing real inbound messages — so this tries every configured
 * token and accepts the request if any one of them validates.
 */
function validTwilioSignature(tenant: Tenant, signature: string, url: string, body: Record<string, string>): boolean {
  const tokens = new Set([tenant.channels.sms?.authToken, tenant.channels.whatsapp?.authToken].filter(Boolean));
  for (const token of tokens) {
    if (twilio.validateRequest(token as string, signature, url, body)) return true;
  }
  return false;
}

const DEFAULT_NOT_INTERESTED_CLOSER =
  "No problem, {name} — thanks for letting us know! Feel free to reach out anytime if that changes.";

/**
 * Which Paddle Billing webhook event types drive an automatic tenant
 * suspend/reactivate (see the /webhooks/paddle route below). Every other
 * event type (subscription.created, subscription.trialing,
 * subscription.updated, transaction.billed, transaction.ready, ...) is
 * intentionally a no-op here — acknowledged with 204 but otherwise ignored.
 * Configure the Paddle notification destination to send at least these
 * event types; sending others too is harmless.
 */
const PADDLE_EVENT_ACTIONS: Record<string, "suspend" | "reactivate"> = {
  "subscription.canceled": "suspend",
  "subscription.past_due": "suspend",
  "subscription.paused": "suspend",
  "transaction.payment_failed": "suspend",
  "subscription.activated": "reactivate",
  "subscription.resumed": "reactivate",
  "transaction.completed": "reactivate",
};

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
      const valid = validTwilioSignature(tenant, signature, requestUrl(req), req.body);
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
      const valid = validTwilioSignature(tenant, signature, requestUrl(req), req.body);
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

  // --- Paddle billing: auto-suspend/reactivate a tenant on subscription lapse/recovery ---
  // Unlike every other route in this file, this isn't scoped to one
  // tenant's own credentials via :tenantId in the URL — Paddle is the
  // *agency's* billing account, shared across every tenant, so one
  // PADDLE_WEBHOOK_SECRET (the signing secret for this webhook destination,
  // from the Paddle dashboard) authenticates every event regardless of
  // which tenant it's about. See DEPLOYMENT.md "Billing (Paddle)" for the
  // Paddle-side setup this route expects.
  router.post(
    "/webhooks/paddle",
    express.json({
      verify: (req, _res, buf) => {
        // Needs the exact raw request bytes to verify — re-serializing the
        // parsed body could differ byte-for-byte from what Paddle actually
        // signed (see paddleVerify.ts's own doc comment).
        (req as Request & { rawBody?: Buffer }).rawBody = buf;
      },
    }),
    asyncHandler(async (req, res) => {
      const secret = process.env.PADDLE_WEBHOOK_SECRET;
      if (!secret) {
        res.status(503).json({ error: "Paddle billing integration disabled: set PADDLE_WEBHOOK_SECRET" });
        return;
      }

      const signature = req.header("paddle-signature") ?? "";
      const rawBody = (req as Request & { rawBody?: Buffer }).rawBody;
      if (!rawBody || !verifyPaddleSignature(secret, rawBody.toString("utf8"), signature)) {
        res.status(403).send("invalid signature");
        return;
      }

      const eventType = req.body?.event_type;
      const data = req.body?.data;
      const action = typeof eventType === "string" ? PADDLE_EVENT_ACTIONS[eventType] : undefined;
      if (!action || typeof data !== "object" || data === null) {
        // Either an event type we don't act on (subscription.created,
        // transaction.billed, ...) or a payload shape we don't recognize —
        // safely ignored either way, not an error worth a non-2xx response
        // that would make Paddle retry.
        res.status(204).send();
        return;
      }

      const row = data as Record<string, unknown>;
      const customData = row.custom_data as Record<string, unknown> | undefined;
      const tenantIdFromCustomData = typeof customData?.tenantId === "string" ? customData.tenantId : undefined;
      // Subscription events carry the subscription id as `data.id`;
      // transaction events carry it as `data.subscription_id` (a
      // transaction's own `data.id` is a transaction id, not useful here).
      // Trimmed for the same reason every write site in routes/tenants.ts
      // trims it: an untrimmed value here would never match — or would
      // silently duplicate — the trimmed value the admin API stores.
      const rawSubscriptionId = (eventType.startsWith("subscription.") ? row.id : row.subscription_id) as
        string | undefined;
      const trimmedSubscriptionId = typeof rawSubscriptionId === "string" ? rawSubscriptionId.trim() : "";
      const subscriptionId = trimmedSubscriptionId.length > 0 ? trimmedSubscriptionId : undefined;

      const tenant = tenantIdFromCustomData
        ? await stores.tenantStore.getTenant(tenantIdFromCustomData)
        : typeof subscriptionId === "string"
          ? await stores.tenantStore.getTenantByPaddleSubscriptionId(subscriptionId)
          : undefined;

      if (!tenant) {
        // Not an error from Paddle's point of view — this subscription just
        // isn't (yet, or ever) linked to a tenant we know about. Logged so
        // an operator notices a misconfigured checkout (missing
        // custom_data.tenantId) instead of a tenant silently never getting
        // billing-suspended.
        logger.warn("paddle_webhook_unmatched_tenant", { eventType, tenantIdFromCustomData, subscriptionId });
        res.status(204).send();
        return;
      }

      // Paddle documents that webhook delivery can arrive out of order
      // (retries, multiple delivery workers) — without this check, a
      // delayed subscription.past_due (suspend) landing after a later
      // subscription.activated (reactivate) already processed would
      // silently re-suspend an otherwise-current tenant. `occurred_at` is
      // on the top-level envelope, not `data`.
      const occurredAt = typeof req.body?.occurred_at === "string" ? req.body.occurred_at : undefined;
      // compareIsoTimestamps, not Date.parse: Date only has millisecond
      // resolution, and occurred_at carries microsecond precision — parsing
      // both through Date would silently collapse two genuinely different
      // instants to the same millisecond, defeating this check entirely.
      // undefined (unrecognized format on either side) means "can't tell",
      // which is treated as not-stale rather than guessing.
      const comparison =
        occurredAt && tenant.paddleLastEventAt ? compareIsoTimestamps(occurredAt, tenant.paddleLastEventAt) : undefined;
      const isStale = comparison !== undefined && comparison <= 0;
      // This read-then-write is a check-then-act, not an atomic
      // compare-and-set: it closes the common case (a slower duplicate/retry
      // delivery arriving after the newer event's write already committed),
      // but not two deliveries for the same tenant landing at the exact same
      // instant, both reading tenant.paddleLastEventAt before either has
      // written. Closing that fully needs a conditional UPDATE ... WHERE
      // paddle_last_event_at < $newValue at the DB layer (Postgres can do
      // this atomically; the in-memory store would need its own equivalent
      // guard) — a bigger change than this pass's scope, and a race this
      // tight between two deliveries of the same tenant's events is rare in
      // practice.
      if (isStale) {
        logger.warn("paddle_webhook_stale_event", {
          tenantId: tenant.id,
          eventType,
          occurredAt,
          lastProcessedAt: tenant.paddleLastEventAt,
        });
        res.status(204).send();
        return;
      }

      const desiredStatus = action === "suspend" ? "suspended" : "active";
      const patch: Partial<Tenant> = {};
      if (tenant.status !== desiredStatus) {
        patch.status = desiredStatus;
        // So the admin UI can tell this apart from a deliberate admin hold —
        // see Tenant.statusReason's own doc comment.
        patch.statusReason = "billing";
      }
      // Self-heals the fallback mapping: once an event with custom_data
      // arrives, record which subscription this tenant's status is now
      // driven by, so a later event missing custom_data (or carrying the
      // wrong one) can still be matched by subscription id alone. Warns
      // (rather than silently overwriting) when this replaces an existing,
      // *different* value — a legitimate resubscription looks exactly like
      // this too, so it isn't rejected, but an operator watching logs can
      // still catch a mismatched custom_data.tenantId at checkout-link
      // creation before it does more damage.
      if (typeof subscriptionId === "string" && tenant.paddleSubscriptionId !== subscriptionId) {
        // Mirrors routes/tenants.ts's checkPaddleSubscriptionIdConflict: this
        // subscription id must not already belong to a *different* tenant —
        // e.g. a checkout-link misconfiguration sends custom_data.tenantId
        // for tenant B alongside a subscription id already bound to tenant
        // A. Binding it here too would let getTenantByPaddleSubscriptionId's
        // fallback lookup return an arbitrary one of them for future events.
        // The status change below still applies (custom_data named *this*
        // tenant) — only the self-heal binding is skipped, with a warning so
        // an operator can catch the misconfiguration.
        const conflictingTenant = await stores.tenantStore.getTenantByPaddleSubscriptionId(subscriptionId);
        if (conflictingTenant && conflictingTenant.id !== tenant.id) {
          logger.warn("paddle_webhook_subscription_conflict", {
            tenantId: tenant.id,
            eventType,
            subscriptionId,
            conflictingTenantId: conflictingTenant.id,
          });
        } else {
          if (tenant.paddleSubscriptionId) {
            logger.warn("paddle_webhook_subscription_rebind", {
              tenantId: tenant.id,
              eventType,
              from: tenant.paddleSubscriptionId,
              to: subscriptionId,
            });
          }
          patch.paddleSubscriptionId = subscriptionId;
        }
      }
      if (occurredAt && occurredAt !== tenant.paddleLastEventAt) patch.paddleLastEventAt = occurredAt;

      if (Object.keys(patch).length > 0) {
        await stores.tenantStore.updateTenant(tenant.id, patch);
      }
      if ("status" in patch) {
        await recordAudit(stores.auditLogStore, {
          tenantId: tenant.id,
          action: "tenant.paddle_status_change",
          actor: "paddle",
          details: { eventType, newStatus: patch.status },
        });
        logger.info("paddle_webhook_status_change", { tenantId: tenant.id, eventType, newStatus: patch.status });
        // Unlike an "interested" reply or a chatbot escalation (notify.ts),
        // this isn't something a tenant's own team needs to hear about via
        // their notifyWebhookUrl — it's the agency running LeadRecovery that
        // needs to know one of its clients just got auto-suspended (or
        // recovered) for non-payment, so it can follow up, not just find out
        // by noticing the audit log or a support ticket later.
        void sendOperatorAlert(
          patch.status === "suspended"
            ? `Tenant "${tenant.name}" (${tenant.id}) auto-suspended by Paddle: ${eventType}`
            : `Tenant "${tenant.name}" (${tenant.id}) reactivated by Paddle: ${eventType}`,
          { tenantId: tenant.id, eventType, newStatus: patch.status }
        );
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

      // Reuses an existing lead for this contact info instead of always
      // creating a new row — the same findLeadByContact lookup every other
      // inbound handler in this file already does before touching a lead.
      // A CRM/Zapier/Make automation retrying a delivery (or two automations
      // both notifying LeadRecovery about the same person) is common enough
      // that, without this, the same person ends up with two separate Lead
      // rows sharing a phone/email — and suppression (checkSuppression,
      // compliance.ts's SUPPRESSED_STATUSES) is tracked per lead row, so a
      // STOP reply against one row leaves the other fully contactable.
      //
      // This is a check-then-act, not an atomic upsert, so it closes the
      // common case (a retried/duplicate delivery arriving after the first
      // one already committed) but not two deliveries landing at the exact
      // same instant, before either has written its row — there's no
      // unique constraint on (tenantId, phone/email) backing this. Closing
      // that fully needs a DB-level constraint plus an atomic
      // insert-or-update per store implementation (see pgRateLimitStore.ts's
      // `INSERT ... ON CONFLICT` for the pattern this codebase already uses
      // elsewhere) — a bigger, separate change than this lookup.
      const existing = await stores.leadStore.findLeadByContact(tenant.id, {
        phone: body.phone,
        email: body.email,
      });

      if (existing) {
        const updated = await stores.leadStore.updateLead(tenant.id, existing.id, {
          name: body.name ?? existing.name,
          requestedService: body.requestedService ?? existing.requestedService,
          previousQuote: body.previousQuote ?? existing.previousQuote,
          previousConversationSummary: body.previousConversationSummary ?? existing.previousConversationSummary,
          appointmentStatus: body.appointmentStatus ?? existing.appointmentStatus,
          appointmentAt: body.appointmentAt ?? existing.appointmentAt,
          notes: body.notes ?? existing.notes,
          hadMissedCall: body.hadMissedCall ?? existing.hadMissedCall,
          preferredChannel: body.preferredChannel ?? existing.preferredChannel,
        });
        res.status(200).json(updated);
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
        appointmentAt: body.appointmentAt,
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
