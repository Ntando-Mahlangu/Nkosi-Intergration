import express, { Router, type Request } from "express";
import twilio from "twilio";
import multer from "multer";
import type { Stores } from "../store/index.js";
import { classifyReply } from "../reply/classify.js";
import { requireTenantAuth } from "../middleware/auth.js";
import { generateId } from "../idgen.js";
import type { Lead, LeadSource, Message } from "../types.js";

const upload = multer();

/** Twilio signs the exact URL it POSTed to — reconstruct it rather than trusting req.originalUrl behind a proxy. */
function requestUrl(req: Request): string {
  return `${req.protocol}://${req.get("host")}${req.originalUrl}`;
}

async function recordInboundAndClassify(
  stores: Stores,
  tenantId: string,
  leadId: string,
  channel: Message["channel"],
  body: string
): Promise<{ classification: Awaited<ReturnType<typeof classifyReply>> }> {
  const classification = await classifyReply(body);

  await stores.messageStore.logMessage({
    id: generateId("msg"),
    tenantId,
    leadId,
    channel,
    direction: "inbound",
    body,
    at: new Date().toISOString(),
    classification,
  });

  if (classification === "stop") {
    await stores.leadStore.updateLead(tenantId, leadId, { status: "opted_out" });
  } else {
    await stores.leadStore.updateLead(tenantId, leadId, { status: "responded" });
  }

  return { classification };
}

/**
 * Inbound webhooks: Twilio SMS/voice-status (signature-verified per tenant),
 * a SendGrid inbound-parse endpoint for email replies, and a generic JSON
 * lead-intake endpoint for connecting an arbitrary CRM via an outgoing
 * webhook or a Zapier/Make/n8n automation.
 */
export function createWebhookRoutes(stores: Stores): Router {
  const router = Router();

  // --- Twilio inbound SMS/WhatsApp replies ---
  router.post(
    "/webhooks/:tenantId/twilio/sms",
    express.urlencoded({ extended: false }),
    async (req, res) => {
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

      const from = req.body.From as string | undefined;
      const body = (req.body.Body as string | undefined) ?? "";
      const lead = from ? await stores.leadStore.findLeadByContact(tenant.id, { phone: from }) : undefined;

      if (lead) {
        const channel = from?.startsWith("whatsapp:") ? "whatsapp" : "sms";
        await recordInboundAndClassify(stores, tenant.id, lead.id, channel, body);
      }

      res.type("text/xml").send("<Response></Response>");
    }
  );

  // --- Twilio voice status callback: detects missed calls ---
  router.post(
    "/webhooks/:tenantId/twilio/voice-status",
    express.urlencoded({ extended: false }),
    async (req, res) => {
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

      const from = req.body.From as string | undefined;
      const callStatus = req.body.CallStatus as string | undefined;
      const missed = callStatus === "no-answer" || callStatus === "busy" || callStatus === "failed";

      if (from && missed) {
        let lead = await stores.leadStore.findLeadByContact(tenant.id, { phone: from });
        if (lead) {
          await stores.leadStore.updateLead(tenant.id, lead.id, { hadMissedCall: true });
        } else {
          lead = await stores.leadStore.createLead({
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
    }
  );

  // --- SendGrid inbound parse (email replies) ---
  // SendGrid posts multipart/form-data and (without the paid signed-webhook
  // feature) doesn't sign requests — a `?token=<tenant api key>` shared
  // secret is a pragmatic MVP guard; swap for SendGrid's signed webhook
  // verification before handling real client traffic (see COMPLIANCE.md).
  router.post("/webhooks/:tenantId/sendgrid/email", upload.none(), async (req, res) => {
    const tenant = await stores.tenantStore.getTenant(req.params.tenantId);
    if (!tenant) {
      res.status(404).send();
      return;
    }
    if (req.query.token !== tenant.apiKey) {
      res.status(403).send("invalid token");
      return;
    }

    const from = req.body.from as string | undefined;
    const emailMatch = from?.match(/<([^>]+)>/);
    const fromEmail = (emailMatch ? emailMatch[1] : from)?.trim();
    const text = (req.body.text as string | undefined) ?? "";

    const lead = fromEmail ? await stores.leadStore.findLeadByContact(tenant.id, { email: fromEmail }) : undefined;
    if (lead) {
      await recordInboundAndClassify(stores, tenant.id, lead.id, "email", text);
    }

    res.status(204).send();
  });

  // --- Generic lead intake (CRM outgoing webhook / Zapier / Make / n8n) ---
  router.post("/webhooks/lead", express.json(), requireTenantAuth(stores.tenantStore), async (req, res) => {
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
      source: (body.source as LeadSource) ?? "other",
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
  });

  return router;
}
