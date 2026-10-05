import { randomBytes } from "node:crypto";
import { Router, type Request, type Response } from "express";
import type { Stores } from "../store/index.js";
import type { Lead, Message, Tenant } from "../types.js";
import { hashToken, safeCompare } from "../security.js";
import { asyncHandler } from "../middleware/asyncHandler.js";
import { createPublicChatLimiter } from "../middleware/rateLimit.js";
import { generateId } from "../idgen.js";
import { answerChatMessage } from "../chatWidget.js";

const MAX_FIELD_LENGTH = 2000;
/** A real chat message can run long (a pasted question, an address) but still needs a sane ceiling — same cap webhooks/index.ts applies to an inbound SMS/email body. */
const MAX_MESSAGE_LENGTH = 4000;

function isValidField(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= MAX_FIELD_LENGTH;
}

/** Same generic CORS allowance as publicCapture.ts's lead-capture form — see that file's own doc comment for why this is safe despite allowing any origin. */
function allowAnyOrigin(req: Request, res: Response, next: () => void): void {
  res.setHeader("Access-Control-Allow-Origin", "*");
  if (req.method === "OPTIONS") {
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    res.setHeader("Access-Control-Max-Age", "600");
    res.status(204).end();
    return;
  }
  next();
}

/**
 * Resolves {tenant, lead} for an authenticated chat-widget request, or
 * sends an error response and returns undefined. Checks formKey (scopes the
 * caller to this tenant's chat widget, same as publicCapture.ts) AND the
 * per-conversation chatToken (scopes the caller to this one lead's thread —
 * without it, formKey alone would let any visitor read/post into any other
 * visitor's conversation, since formKey is the same for every visitor to a
 * given tenant's site). Same generic error for every failure mode
 * (wrong tenantId, wrong formKey, wrong leadId, wrong chatToken, suspended
 * tenant) — distinguishing them would let a caller enumerate valid
 * tenantIds/leadIds.
 */
async function resolveChatSession(
  stores: Stores,
  res: Response,
  params: { tenantId: string; formKey: unknown; leadId: unknown; chatToken: unknown }
): Promise<{ tenant: Tenant; lead: Lead } | undefined> {
  const invalid = () => {
    res.status(401).json({ error: "invalid chat session" });
    return undefined;
  };

  const tenant = await stores.tenantStore.getTenant(params.tenantId);
  if (!tenant || !tenant.publicFormKey || typeof params.formKey !== "string") return invalid();
  if (!safeCompare(params.formKey, tenant.publicFormKey)) return invalid();
  if (typeof params.leadId !== "string" || typeof params.chatToken !== "string") return invalid();

  const lead = await stores.leadStore.getLeadById(tenant.id, params.leadId);
  if (!lead || !lead.chatTokenHash) return invalid();
  if (!safeCompare(hashToken(params.chatToken), lead.chatTokenHash)) return invalid();

  if (tenant.status === "suspended") {
    res.status(403).json({ error: "this chat is not currently available" });
    return undefined;
  }

  return { tenant, lead };
}

/**
 * The website chat widget's own public, unauthenticated-except-token
 * endpoints (see public/chat-widget.js, and public/settings.html's "Add a
 * chat box to your website" panel for the embeddable snippet). Mirrors
 * publicCapture.ts's trust model — formKey is safe to publish, same as
 * there — plus a second, per-conversation chatToken (see resolveChatSession
 * above) so one visitor can never read or post into another's thread.
 */
export function createPublicChatRoutes(stores: Stores): Router {
  const router = Router();

  router.use("/public/chat/:tenantId", allowAnyOrigin);

  router.post(
    "/public/chat/:tenantId/start",
    createPublicChatLimiter(),
    asyncHandler(async (req: Request, res: Response) => {
      const tenant = await stores.tenantStore.getTenant(req.params.tenantId);
      const body = (req.body ?? {}) as Record<string, unknown>;
      const formKey = body.formKey;
      if (
        !tenant ||
        !tenant.publicFormKey ||
        typeof formKey !== "string" ||
        !safeCompare(formKey, tenant.publicFormKey)
      ) {
        res.status(401).json({ error: "invalid tenantId or formKey" });
        return;
      }
      if (tenant.status === "suspended") {
        res.status(403).json({ error: "this chat is not currently available" });
        return;
      }

      const name = isValidField(body.name) ? body.name.trim() : undefined;
      const phone = isValidField(body.phone) ? body.phone.trim() : undefined;
      const email = isValidField(body.email) ? body.email.trim() : undefined;

      const chatToken = randomBytes(24).toString("hex");
      const lead: Lead = {
        id: generateId("lead"),
        tenantId: tenant.id,
        name,
        phone,
        email,
        source: "chat",
        createdAt: new Date().toISOString(),
        status: "new",
        chatTokenHash: hashToken(chatToken),
      };
      await stores.leadStore.createLead(lead);
      res.status(201).json({ leadId: lead.id, chatToken });
    })
  );

  router.post(
    "/public/chat/:tenantId/message",
    createPublicChatLimiter(),
    asyncHandler(async (req: Request, res: Response) => {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const session = await resolveChatSession(stores, res, {
        tenantId: req.params.tenantId,
        formKey: body.formKey,
        leadId: body.leadId,
        chatToken: body.chatToken,
      });
      if (!session) return;
      const { tenant, lead } = session;

      // Same compliance gate every other send/auto-reply path enforces
      // (worker.ts, webhooks/index.ts, POST /workflow/run) — a tenant that
      // hasn't accepted LeadRecovery's own Terms of Service/Privacy Policy
      // yet must be fully paused, including the chatbot.
      if (!tenant.termsAcceptedAt) {
        res.status(503).json({ error: "chat is temporarily unavailable" });
        return;
      }

      const messageBody = body.body;
      if (
        typeof messageBody !== "string" ||
        messageBody.trim().length === 0 ||
        messageBody.length > MAX_MESSAGE_LENGTH
      ) {
        res.status(400).json({ error: `body is required, up to ${MAX_MESSAGE_LENGTH} characters` });
        return;
      }

      const reply = await answerChatMessage(stores, tenant, lead, messageBody);
      res.json(reply);
    })
  );

  router.get(
    "/public/chat/:tenantId/history",
    createPublicChatLimiter(),
    asyncHandler(async (req: Request, res: Response) => {
      const session = await resolveChatSession(stores, res, {
        tenantId: req.params.tenantId,
        formKey: req.query.formKey,
        leadId: req.query.leadId,
        chatToken: req.query.chatToken,
      });
      if (!session) return;
      const { tenant, lead } = session;

      const messages = await stores.messageStore.getMessagesForLead(tenant.id, lead.id);
      // Scoped to this one channel — a lead record could in principle also
      // carry SMS/email history (e.g. if the same contact info later gets
      // imported another way); this endpoint must never surface any of that
      // to an anonymous website visitor holding only a chat token.
      const chatOnly = messages.filter((m: Message) => m.channel === "chat");
      res.json(
        chatOnly.map((m) => ({
          direction: m.direction,
          body: m.body,
          at: m.at,
        }))
      );
    })
  );

  return router;
}
