import { Router, type Request, type Response } from "express";
import type { Stores } from "../store/index.js";
import type { Channel, Lead } from "../types.js";
import { requireTenantAuth } from "../middleware/auth.js";
import { createTenantLimiter } from "../middleware/rateLimit.js";
import { asyncHandler } from "../middleware/asyncHandler.js";
import { parsePageParams, paginate } from "../pagination.js";
import { leadsToCsv } from "../csv.js";
import { createLeadsDeduped, parseLeadsCsv } from "../leadImport.js";
import { buildFollowUpPlans, buildRecoveryPlans, buildWinBackPlans } from "../workflow.js";
import { hasCarrierApproval, safeSend, selectChannel } from "../channels/index.js";
import { generateId } from "../idgen.js";
import { hardStopReason, isHardStopped } from "../compliance.js";
import { isWithinQuietHours } from "../quietHours.js";

/** Clears the three needs-attention fields in one patch — shared by both /leads/:id/reply and /leads/:id/mark-handled below. */
const CLEAR_ATTENTION: Pick<Lead, "needsAttentionAt" | "needsAttentionReason" | "attentionAlertedAt"> = {
  needsAttentionAt: undefined,
  needsAttentionReason: undefined,
  attentionAlertedAt: undefined,
};

/** Everything under /leads/* — CRUD, CSV export/import, dry-run planning, and per-lead message history. */
export function createLeadRoutes({ tenantStore, tenantUserStore, leadStore, messageStore }: Stores): Router {
  const router = Router();
  const auth = [createTenantLimiter(), requireTenantAuth(tenantStore, tenantUserStore)];

  // Optional ?limit=&offset= pagination; omitted (the default) returns everything, unchanged from before —
  // existing dashboards that don't pass these params see no behavior change. X-Total-Count always reports the full count.
  router.get(
    "/leads",
    ...auth,
    asyncHandler(async (req: Request, res: Response) => {
      let leads = await leadStore.getAllLeads(req.tenant!.id);
      // Backs the dashboard's "Needs attention" inbox section — every lead
      // notifyHumanAttention has fired for (an "interested" reply, or a
      // question/unknown reply escalating) that hasn't yet been replied to or marked
      // handled (see POST /leads/:id/reply and /leads/:id/mark-handled).
      if (req.query.needsAttention === "true") {
        leads = leads.filter((lead) => Boolean(lead.needsAttentionAt));
      }
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
  // on their behalf. Dedupes against existing leads by phone/email (and
  // against earlier rows in this same file) via createLeadsDeduped — see
  // its own doc comment for why this skips rather than merging.
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
      const { imported, duplicates } = await createLeadsDeduped(leadStore, req.tenant!.id, leads);
      res.status(201).json({ imported, skipped: skippedCount, duplicates });
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
      const winBacks = buildWinBackPlans(req.tenant!, leads);
      const plans = [...initial.plans, ...followUps.plans, ...winBacks.plans];
      res.set("X-Total-Count", String(plans.length));
      res.json({
        plans: paginate(plans, parsePageParams(req)),
        skipped: [...initial.skipped, ...followUps.skipped, ...winBacks.skipped],
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
          | "marketingOptIn"
        >
      >;

      if (body.marketingOptIn !== undefined && typeof body.marketingOptIn !== "boolean") {
        res.status(400).json({ error: "marketingOptIn must be a boolean" });
        return;
      }

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
      // A consent flag, not status/compliance-suppression machinery — safe
      // to let the tenant toggle directly here, unlike `status` above. See
      // Lead.marketingOptIn and src/winback.ts.
      if ("marketingOptIn" in body) patch.marketingOptIn = body.marketingOptIn ?? undefined;

      const updated = await leadStore.updateLead(tenant.id, req.params.id, patch);
      res.json(updated);
    })
  );

  // The one, narrow, forward-only status transition this file otherwise
  // deliberately excludes from the general PATCH above (see its own
  // comment): marking a lead as a converted/won customer. Separate from
  // `marketingOptIn` — converting a lead says nothing about whether they
  // agreed to be re-contacted afterwards, so that's still an explicit,
  // independent choice (either in this same call or later via PATCH).
  router.post(
    "/leads/:id/convert",
    ...auth,
    asyncHandler(async (req: Request, res: Response) => {
      const tenant = req.tenant!;
      const existing = await leadStore.getLeadById(tenant.id, req.params.id);
      if (!existing) {
        res.status(404).json({ error: "no such lead" });
        return;
      }

      const body = req.body as { marketingOptIn?: unknown } | undefined;
      if (body?.marketingOptIn !== undefined && typeof body.marketingOptIn !== "boolean") {
        res.status(400).json({ error: "marketingOptIn must be a boolean" });
        return;
      }

      const updated = await leadStore.updateLead(tenant.id, req.params.id, {
        status: "converted",
        convertedAt: new Date().toISOString(),
        // Never assumed true by omission — see Lead.marketingOptIn's own
        // doc comment on why this needs its own explicit opt-in.
        marketingOptIn: body?.marketingOptIn === true ? true : undefined,
      });
      res.json(updated);
    })
  );

  // Sends a real reply on the operator's behalf — the "reply from the
  // dashboard" half of the needs-attention inbox (the other half is
  // /leads/:id/mark-handled below, for when the operator resolved it some
  // other way, e.g. a phone call). Defaults to whatever channel
  // selectChannel would pick for an automated send, so a human reply
  // behaves exactly like the bot's own would have, but an explicit
  // `channel` in the body can override that (e.g. replying by email even
  // though SMS is usable). Clears needsAttention* on success so the lead
  // drops out of the inbox.
  router.post(
    "/leads/:id/reply",
    ...auth,
    asyncHandler(async (req: Request, res: Response) => {
      const tenant = req.tenant!;
      // Same gate every other send path in this app already enforces
      // (worker.ts, POST /workflow/run, every webhook closer send,
      // the chat widget) — this is a real outbound send on the tenant's
      // behalf, not exempt just because a human typed it.
      if (!tenant.termsAcceptedAt) {
        res.status(403).json({ error: "this tenant must accept the Terms of Service before sending anything" });
        return;
      }

      const existing = await leadStore.getLeadById(tenant.id, req.params.id);
      if (!existing) {
        res.status(404).json({ error: "no such lead" });
        return;
      }
      // Narrower than the workflow's own checkSuppression (which also
      // treats converted/booked/active_conversation as "don't contact" —
      // the wrong rule here, since this endpoint exists specifically to
      // let an operator reply to one of those leads). Only a genuine
      // never-contact-again signal (STOP, do-not-contact, fraudulent)
      // blocks a manual reply too — see compliance.ts's own comment.
      if (isHardStopped(existing)) {
        res.status(403).json({ error: `cannot message this lead — ${hardStopReason(existing)}` });
        return;
      }

      const body = req.body as { message?: unknown; channel?: unknown } | undefined;
      const message = typeof body?.message === "string" ? body.message.trim() : "";
      if (!message) {
        res.status(400).json({ error: "message is required" });
        return;
      }

      const validChannels = new Set(["sms", "whatsapp", "email", "chat"]);
      if (body?.channel !== undefined && !validChannels.has(body.channel as string)) {
        res.status(400).json({ error: "channel must be one of sms/whatsapp/email/chat" });
        return;
      }
      if (body?.channel === "chat" && !existing.chatTokenHash) {
        res.status(422).json({ error: "this lead has no chat-widget conversation to reply on" });
        return;
      }
      const channel = (body?.channel as Channel | "chat" | undefined) ?? selectChannel(tenant, existing);
      if (!channel) {
        res.status(422).json({ error: "no usable channel for this lead — configure one in tenant settings" });
        return;
      }
      // Same quiet-hours policy every batch send in workflow.ts already
      // applies, channel-agnostic there too — a manual reply has no
      // "retry next run" the way a deferred automated send does, so this
      // just asks the operator to try again once quiet hours end.
      if (isWithinQuietHours(tenant)) {
        res.status(422).json({ error: "cannot send right now — it's within this tenant's quiet hours" });
        return;
      }

      const messageId = generateId("msg");
      if (channel === "chat") {
        // There's no live push into an already-open browser tab (no
        // WebSocket/SSE infra behind the chat widget) — this records the
        // reply so it shows up next time the visitor's widget polls, but
        // can't deliver it in real time. An honest, scoped limitation
        // rather than a fake real-time feature.
        await messageStore.logMessage({
          id: messageId,
          tenantId: tenant.id,
          leadId: existing.id,
          channel: "chat",
          direction: "outbound",
          body: message,
          at: new Date().toISOString(),
          kind: "manual_reply",
        });
      } else {
        if (!hasCarrierApproval(tenant, channel)) {
          res.status(422).json({ error: `carrier approval required before sending via ${channel}` });
          return;
        }
        const result = await safeSend(channel, tenant, existing, { channel, body: message }, messageId);
        if (!result.ok) {
          res.status(502).json({ error: `send failed: ${result.detail ?? "unknown error"}` });
          return;
        }
        await messageStore.logMessage({
          id: messageId,
          tenantId: tenant.id,
          leadId: existing.id,
          channel,
          direction: "outbound",
          body: message,
          at: new Date().toISOString(),
          providerMessageId: result.providerMessageId,
          kind: "manual_reply",
        });
      }

      const updated = await leadStore.updateLead(tenant.id, existing.id, CLEAR_ATTENTION);
      res.json(updated);
    })
  );

  // Resolves a needs-attention item without sending a reply through
  // LeadRecovery — e.g. the operator called the lead directly, or decided
  // no further action is needed. Just clears the flag.
  router.post(
    "/leads/:id/mark-handled",
    ...auth,
    asyncHandler(async (req: Request, res: Response) => {
      const tenant = req.tenant!;
      const existing = await leadStore.getLeadById(tenant.id, req.params.id);
      if (!existing) {
        res.status(404).json({ error: "no such lead" });
        return;
      }
      const updated = await leadStore.updateLead(tenant.id, existing.id, CLEAR_ATTENTION);
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
