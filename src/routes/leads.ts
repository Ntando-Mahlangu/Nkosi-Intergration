import { Router, type Request, type Response } from "express";
import type { Stores } from "../store/index.js";
import type { Lead } from "../types.js";
import { requireTenantAuth } from "../middleware/auth.js";
import { createTenantLimiter } from "../middleware/rateLimit.js";
import { asyncHandler } from "../middleware/asyncHandler.js";
import { parsePageParams, paginate } from "../pagination.js";
import { leadsToCsv } from "../csv.js";
import { parseLeadsCsv } from "../leadImport.js";
import { buildFollowUpPlans, buildRecoveryPlans } from "../workflow.js";

/** Everything under /leads/* — CRUD, CSV export/import, dry-run planning, and per-lead message history. */
export function createLeadRoutes({ tenantStore, leadStore, messageStore }: Stores): Router {
  const router = Router();
  const auth = [createTenantLimiter(), requireTenantAuth(tenantStore)];

  // Optional ?limit=&offset= pagination; omitted (the default) returns everything, unchanged from before —
  // existing dashboards that don't pass these params see no behavior change. X-Total-Count always reports the full count.
  router.get(
    "/leads",
    ...auth,
    asyncHandler(async (req: Request, res: Response) => {
      const leads = await leadStore.getAllLeads(req.tenant!.id);
      res.set("X-Total-Count", String(leads.length));
      res.json(paginate(leads, parsePageParams(req)));
    })
  );

  // A full-fidelity export of a tenant's own lead data — every Lead field,
  // as CSV (default, for opening in a spreadsheet) or JSON — for their own
  // records or a data right-of-access request (see COMPLIANCE.md "Data
  // handling"). Unlike /leads, this is never paginated: it's a one-shot
  // download, not something a UI pages through.
  router.get(
    "/leads/export",
    ...auth,
    asyncHandler(async (req: Request, res: Response) => {
      const leads = await leadStore.getAllLeads(req.tenant!.id);
      if (req.query.format === "json") {
        res.setHeader("Content-Disposition", 'attachment; filename="leads-export.json"');
        res.json(leads);
        return;
      }
      res.setHeader("Content-Type", "text/csv; charset=utf-8");
      res.setHeader("Content-Disposition", 'attachment; filename="leads-export.csv"');
      res.send(leadsToCsv(leads));
    })
  );

  // Bulk lead import from a CSV's raw text (read client-side via
  // FileReader and posted as JSON, not multipart — see public/dashboard.html
  // — so this reuses the already-mounted express.json() above with no extra
  // body parser). Shares its column mapping/validation with
  // `npm run import-leads` via src/leadImport.ts, so a client uploading a
  // spreadsheet themselves gets identical behavior to you running the CLI
  // on their behalf. Does not dedupe against existing leads by phone/email
  // (neither does the CLI) — re-uploading the same file creates duplicates.
  router.post(
    "/leads/import",
    ...auth,
    asyncHandler(async (req: Request, res: Response) => {
      const csv = (req.body as { csv?: unknown } | undefined)?.csv;
      if (typeof csv !== "string" || csv.trim().length === 0) {
        res.status(400).json({ error: "csv (the file's raw text content) is required" });
        return;
      }
      if (csv.length > 5_000_000) {
        res.status(400).json({ error: "csv is too large (5MB max)" });
        return;
      }

      const { leads, skippedCount } = parseLeadsCsv(csv, req.tenant!.id);
      for (const lead of leads) {
        await leadStore.createLead(lead);
      }
      res.status(201).json({ imported: leads.length, skipped: skippedCount });
    })
  );

  // Dry run: initial-outreach + follow-up plans, nothing sent or mutated.
  router.get(
    "/leads/plan",
    ...auth,
    asyncHandler(async (req: Request, res: Response) => {
      const leads = await leadStore.getAllLeads(req.tenant!.id);
      const initial = buildRecoveryPlans(req.tenant!, leads);
      const followUps = buildFollowUpPlans(req.tenant!, leads);
      const plans = [...initial.plans, ...followUps.plans];
      res.set("X-Total-Count", String(plans.length));
      res.json({
        plans: paginate(plans, parsePageParams(req)),
        skipped: [...initial.skipped, ...followUps.skipped],
      });
    })
  );

  router.get(
    "/leads/:id/messages",
    ...auth,
    asyncHandler(async (req: Request, res: Response) => {
      res.json(await messageStore.getMessagesForLead(req.tenant!.id, req.params.id));
    })
  );

  // Lets a tenant edit the handful of fields that are genuinely theirs to
  // set by hand — notably appointmentAt/appointmentStatus, which is how an
  // operator books/reschedules the appointment src/appointmentReminder.ts's
  // 24-hours-before reminder fires against. Deliberately excludes `status`:
  // that's governed by the classify/workflow/compliance logic elsewhere
  // (STOP handling, the workflow's own state machine), not something a
  // stray PATCH here should be able to silently override — e.g. clearing
  // an opted_out lead back to contactable.
  router.patch(
    "/leads/:id",
    ...auth,
    asyncHandler(async (req: Request, res: Response) => {
      const tenant = req.tenant!;
      const existing = await leadStore.getLeadById(tenant.id, req.params.id);
      if (!existing) {
        res.status(404).json({ error: "no such lead" });
        return;
      }

      const body = req.body as Partial<
        Pick<
          Lead,
          | "name"
          | "requestedService"
          | "previousQuote"
          | "notes"
          | "appointmentStatus"
          | "appointmentAt"
          | "preferredChannel"
        >
      >;

      const validAppointmentStatuses = new Set(["none", "requested", "abandoned", "booked"]);
      if (body.appointmentStatus !== undefined && !validAppointmentStatuses.has(body.appointmentStatus)) {
        res.status(400).json({ error: "appointmentStatus must be one of none/requested/abandoned/booked" });
        return;
      }
      if (
        body.appointmentAt !== undefined &&
        body.appointmentAt !== null &&
        Number.isNaN(Date.parse(body.appointmentAt))
      ) {
        res.status(400).json({ error: "appointmentAt must be a valid date, or null to clear it" });
        return;
      }
      const validChannels = new Set(["sms", "whatsapp", "email"]);
      if (
        body.preferredChannel !== undefined &&
        body.preferredChannel !== null &&
        !validChannels.has(body.preferredChannel)
      ) {
        res.status(400).json({ error: "preferredChannel must be sms/whatsapp/email, or null" });
        return;
      }

      const patch: Partial<Lead> = {};
      if ("name" in body) patch.name = body.name ?? undefined;
      if ("requestedService" in body) patch.requestedService = body.requestedService ?? undefined;
      if ("previousQuote" in body) patch.previousQuote = body.previousQuote ?? undefined;
      if ("notes" in body) patch.notes = body.notes ?? undefined;
      if ("appointmentStatus" in body) patch.appointmentStatus = body.appointmentStatus ?? undefined;
      if ("appointmentAt" in body) {
        patch.appointmentAt = body.appointmentAt ? new Date(body.appointmentAt).toISOString() : undefined;
        // A changed appointment date invalidates any reminder already sent
        // for the old one — without this, rescheduling to a later time
        // would never get a fresh reminder, since appointmentReminderSentAt
        // from the previous date would still be set.
        patch.appointmentReminderSentAt = undefined;
      }
      if ("preferredChannel" in body) patch.preferredChannel = body.preferredChannel ?? undefined;

      const updated = await leadStore.updateLead(tenant.id, req.params.id, patch);
      res.json(updated);
    })
  );

  // A specific person's right-to-erasure request — distinct from the
  // automatic data-retention purge (src/dataRetention.ts, src/worker.ts),
  // which deliberately never touches do_not_contact/opted_out leads (see
  // COMPLIANCE.md "Data handling"): an explicit request to delete one
  // person's data overrides that exemption, since it's the person
  // themselves (or the business acting on their behalf) asking, not an
  // automatic age-based sweep. In Postgres this cascades to the lead's
  // message history (ON DELETE CASCADE, migration 0001) — no undo. Before
  // this existed, the only way to remove one lead's data was deleting the
  // entire tenant (DELETE /admin/tenants/:id).
  router.delete(
    "/leads/:id",
    ...auth,
    asyncHandler(async (req: Request, res: Response) => {
      const deleted = await leadStore.deleteLead(req.tenant!.id, req.params.id);
      if (!deleted) {
        res.status(404).json({ error: "no such lead" });
        return;
      }
      res.status(204).send();
    })
  );

  return router;
}
