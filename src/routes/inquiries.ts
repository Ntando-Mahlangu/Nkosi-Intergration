import { Router, type Request, type Response } from "express";
import type { Stores } from "../store/index.js";
import type { SalesInquiry } from "../store/types.js";
import { requireAdminAuth } from "../middleware/auth.js";
import { createAdminLimiter, createPublicInquiryLimiter } from "../middleware/rateLimit.js";
import { asyncHandler } from "../middleware/asyncHandler.js";
import { parsePageParams } from "../pagination.js";

const MAX_FIELD_LENGTH = 2000;
const VALID_STATUSES: ReadonlySet<SalesInquiry["status"]> = new Set(["new", "contacted", "closed"]);

function isValidField(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= MAX_FIELD_LENGTH;
}

/**
 * The public marketing page's (public/get-started.html) "tell us about your
 * business" inquiry form, plus the admin-side review of what comes in.
 * Deliberately separate from publicCapture.ts's /public/leads/:tenantId:
 * that endpoint creates a *lead* for an existing tenant (scoped by
 * formKey); this one has no tenant at all — it's a prospective business
 * inquiring about becoming a LeadRecovery client in the first place.
 */
export function createInquiryRoutes({ salesInquiryStore }: Stores): Router {
  const router = Router();
  const adminAuth = requireAdminAuth();

  // Public, no auth — this is meant to be submitted directly from the
  // marketing page served by this same app, same-origin, so (unlike
  // publicCapture.ts/publicChat.ts) there's no need to allow arbitrary
  // cross-origin callers here.
  router.post(
    "/inquiries",
    createPublicInquiryLimiter(),
    asyncHandler(async (req: Request, res: Response) => {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const businessName = isValidField(body.businessName) ? body.businessName.trim() : undefined;
      const contactName = isValidField(body.contactName) ? body.contactName.trim() : undefined;
      const email = isValidField(body.email) ? body.email.trim() : undefined;
      const phone = isValidField(body.phone) ? body.phone.trim() : undefined;
      const website = isValidField(body.website) ? body.website.trim() : undefined;
      const message = isValidField(body.message) ? body.message.trim() : undefined;

      if (!businessName) {
        res.status(400).json({ error: "businessName is required" });
        return;
      }
      if (!email && !phone) {
        res.status(400).json({ error: "phone or email is required" });
        return;
      }

      await salesInquiryStore.create({ businessName, contactName, email, phone, website, message });
      res.status(201).json({ ok: true });
    })
  );

  // Optional ?limit=&offset= pagination; omitted returns everything.
  router.get(
    "/admin/inquiries",
    createAdminLimiter(),
    adminAuth,
    asyncHandler(async (req, res) => {
      const total = await salesInquiryStore.count();
      res.set("X-Total-Count", String(total));
      res.json(await salesInquiryStore.list(parsePageParams(req)));
    })
  );

  router.patch(
    "/admin/inquiries/:id",
    createAdminLimiter(),
    adminAuth,
    asyncHandler(async (req, res) => {
      const body = req.body as { status?: unknown } | undefined;
      if (typeof body?.status !== "string" || !VALID_STATUSES.has(body.status as SalesInquiry["status"])) {
        res.status(400).json({ error: "status must be one of new/contacted/closed" });
        return;
      }
      const updated = await salesInquiryStore.updateStatus(req.params.id, body.status as SalesInquiry["status"]);
      if (!updated) {
        res.status(404).json({ error: "no such inquiry" });
        return;
      }
      res.json(updated);
    })
  );

  return router;
}
