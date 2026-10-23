import { Router, type Request, type Response } from "express";
import type { Stores } from "../store/index.js";
import { safeCompare } from "../security.js";
import { asyncHandler } from "../middleware/asyncHandler.js";
import { createPublicFormLimiter } from "../middleware/rateLimit.js";

/** How far into the future a lead is allowed to self-book — keeps a stray/malicious date from scheduling a reminder years out. */
const MAX_BOOKING_DAYS_AHEAD = 180;

/**
 * A public, unauthenticated self-serve appointment-booking endpoint — a
 * lead who already exists (created via the capture form, a CRM webhook, a
 * missed call, etc.) can pick their own appointment time without a human
 * in the loop, instead of a business operator setting it by hand from the
 * lead's detail view in the dashboard. Reuses `Tenant.publicFormKey` (the
 * same "safe to publish" token the lead-capture form and chat widget use —
 * see src/idgen.ts's generateFormKey doc comment) plus the lead's own id,
 * which only the business ever hands out (e.g. in a link sent to that one
 * lead) — together these scope a caller to nothing but this one lead's
 * appointment, the same proportionate trust level as the other public
 * endpoints in this app.
 *
 * Booking directly sets `appointmentStatus: "booked"` and `appointmentAt`
 * — the exact fields src/appointmentReminder.ts already reads — so the
 * existing 24-hours-before reminder starts working immediately with zero
 * other code changes. There is deliberately no notion of "available
 * slots" or double-booking prevention here: the app has no calendar/
 * availability model anywhere else either, so this keeps the same scope
 * (pick a date/time, record it) rather than inventing a half-built
 * scheduling system. A business that needs slot-conflict checking should
 * still review bookings in the dashboard.
 */
export function createPublicBookingRoutes({ tenantStore, leadStore }: Stores): Router {
  const router = Router();

  // Same hand-rolled, narrowly-scoped CORS allowance as the other public
  // endpoints (src/routes/publicCapture.ts, src/routes/publicChat.ts) —
  // kept self-contained here rather than relying on another router's
  // middleware, even though the path differs enough that there'd be no
  // overlap anyway. Safe to allow any origin for the same reason: formKey
  // scopes a caller to nothing but this one lead's own appointment.
  router.use("/public/appointments/:tenantId/:leadId", (req: Request, res: Response, next) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    if (req.method === "OPTIONS") {
      res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", "Content-Type");
      res.setHeader("Access-Control-Max-Age", "600");
      res.status(204).end();
      return;
    }
    next();
  });

  // Same generic "invalid" response whichever of tenant/formKey/lead
  // doesn't check out — distinguishing them would let a caller enumerate
  // valid tenant/lead ids by trying random ones, the same anti-enumeration
  // reasoning as every other public endpoint in this app.
  const INVALID_ERROR = "invalid tenantId, leadId, or formKey";

  async function resolveLead(tenantId: string, leadId: string, formKey: unknown) {
    const tenant = await tenantStore.getTenant(tenantId);
    if (
      !tenant ||
      !tenant.publicFormKey ||
      typeof formKey !== "string" ||
      !safeCompare(formKey, tenant.publicFormKey)
    ) {
      return { error: INVALID_ERROR } as const;
    }
    const lead = await leadStore.getLeadById(tenantId, leadId);
    if (!lead) {
      return { error: INVALID_ERROR } as const;
    }
    return { tenant, lead } as const;
  }

  // Fetches just enough to render the booking page — the business name to
  // show the lead who they're booking with, and any existing appointment
  // so re-visiting the link (e.g. to reschedule) shows the current state
  // instead of a blank form.
  router.get(
    "/public/appointments/:tenantId/:leadId",
    createPublicFormLimiter(),
    asyncHandler(async (req: Request, res: Response) => {
      const resolved = await resolveLead(req.params.tenantId, req.params.leadId, req.query.formKey);
      if ("error" in resolved) {
        res.status(401).json({ error: resolved.error });
        return;
      }
      const { tenant, lead } = resolved;
      if (tenant.status === "suspended") {
        res.status(403).json({ error: "this business is not currently accepting bookings" });
        return;
      }
      res.json({
        businessName: tenant.name,
        leadName: lead.name,
        appointmentStatus: lead.appointmentStatus ?? "none",
        appointmentAt: lead.appointmentAt,
      });
    })
  );

  router.post(
    "/public/appointments/:tenantId/:leadId",
    createPublicFormLimiter(),
    asyncHandler(async (req: Request, res: Response) => {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const resolved = await resolveLead(req.params.tenantId, req.params.leadId, body.formKey);
      if ("error" in resolved) {
        res.status(401).json({ error: resolved.error });
        return;
      }
      const { tenant, lead } = resolved;
      if (tenant.status === "suspended") {
        res.status(403).json({ error: "this business is not currently accepting bookings" });
        return;
      }

      const raw = body.appointmentAt;
      const parsed = typeof raw === "string" ? Date.parse(raw) : NaN;
      if (Number.isNaN(parsed)) {
        res.status(400).json({ error: "appointmentAt must be a valid date/time" });
        return;
      }
      const now = Date.now();
      if (parsed <= now) {
        res.status(400).json({ error: "appointmentAt must be in the future" });
        return;
      }
      const maxAheadMs = MAX_BOOKING_DAYS_AHEAD * 24 * 60 * 60 * 1000;
      if (parsed - now > maxAheadMs) {
        res.status(400).json({ error: `appointmentAt must be within ${MAX_BOOKING_DAYS_AHEAD} days` });
        return;
      }

      const appointmentAt = new Date(parsed).toISOString();
      await leadStore.updateLead(tenant.id, lead.id, {
        appointmentStatus: "booked",
        appointmentAt,
        // Clear any prior reminder-sent flag — this is either a fresh
        // booking or a reschedule, and the reminder for whatever time was
        // previously booked (if any) should no longer be treated as "already sent".
        appointmentReminderSentAt: undefined,
      });

      res.json({ ok: true, appointmentAt });
    })
  );

  return router;
}
