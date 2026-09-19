import { Router } from "express";
import type { Stores } from "../store/index.js";
import type { AuditLogEntry, AuditLogStore } from "../store/types.js";
import { toPublicTenant, type Lead, type Message, type ReplyClassification, type Tenant } from "../types.js";
import { requireAdminAuth, requireTenantAuth } from "../middleware/auth.js";
import { createAdminLimiter, createTenantLimiter } from "../middleware/rateLimit.js";
import { generateApiKey, generateId } from "../idgen.js";
import { parsePageParams, paginate } from "../pagination.js";
import { asyncHandler } from "../middleware/asyncHandler.js";
import { isObviouslyUnsafeWebhookHostname } from "../ssrf.js";
import { logger } from "../logger.js";

/**
 * Records an audit-log entry without ever throwing. The tenant mutation
 * this accompanies has already succeeded and its response is about to be
 * sent — a transient failure to persist the audit trail must never hang
 * the request or crash the process (Express 4 doesn't catch a rejection
 * thrown after this point on its own).
 */
async function recordAudit(
  auditLogStore: AuditLogStore,
  entry: Omit<AuditLogEntry, "id" | "createdAt">
): Promise<void> {
  try {
    await auditLogStore.record(entry);
  } catch (err) {
    logger.error("audit_log_write_failed", {
      action: entry.action,
      tenantId: entry.tenantId,
      error: (err as Error).message,
    });
  }
}

const MAX_KNOWLEDGE_BASE_LENGTH = 20_000;

interface TenantConfigBody {
  name?: string;
  timezone?: string;
  quietHours?: Tenant["quietHours"];
  devMode?: boolean;
  channels?: Tenant["channels"];
  notifyWebhookUrl?: string;
  templates?: Tenant["templates"];
  knowledgeBase?: string;
  autoReplyEnabled?: boolean;
  status?: Tenant["status"];
}

/** True if `timezone` is a real IANA zone Intl can resolve — an invalid one throws at quiet-hours-check time otherwise. */
function isValidTimezone(timezone: string): boolean {
  try {
    new Intl.DateTimeFormat(undefined, { timeZone: timezone });
    return true;
  } catch {
    return false;
  }
}

function isValidQuietHours(quietHours: unknown): quietHours is Tenant["quietHours"] {
  if (quietHours === undefined) return true;
  if (typeof quietHours !== "object" || quietHours === null) return false;
  const { startHour, endHour } = quietHours as Record<string, unknown>;
  const inRange = (n: unknown) => typeof n === "number" && Number.isInteger(n) && n >= 0 && n <= 23;
  return inRange(startHour) && inRange(endHour);
}

function isValidWebhookUrl(url: unknown): boolean {
  if (url === undefined) return true;
  if (typeof url !== "string") return false;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return false;
    // Synchronous, config-time-only check (no DNS lookup) — catches the
    // obvious "notifyWebhookUrl set to localhost/an internal IP" case
    // immediately with a clear error. The load-bearing protection is the
    // DNS-resolution check deliverNotification does before every actual
    // send (src/ssrf.ts) — a hostname that resolves to an internal address
    // only at delivery time isn't (and can't be) caught here.
    return !isObviouslyUnsafeWebhookHostname(parsed.hostname);
  } catch {
    return false;
  }
}

function isValidKnowledgeBase(knowledgeBase: unknown): boolean {
  if (knowledgeBase === undefined) return true;
  return typeof knowledgeBase === "string" && knowledgeBase.length <= MAX_KNOWLEDGE_BASE_LENGTH;
}

function isValidStatus(status: unknown): boolean {
  return status === undefined || status === "active" || status === "suspended";
}

// A non-empty string, i.e. not "" or whitespace-only — a template that
// substitutes to a blank message would otherwise drop the mandatory
// "Reply STOP" opt-out line entirely, and messaging.ts's own
// `tenant.templates?.x ?? DEFAULT` fallback only kicks in for
// null/undefined, never for an explicitly-set "".
function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isValidTemplates(templates: unknown): templates is Tenant["templates"] {
  // null is accepted the same as undefined (not just here — every read of
  // tenant.templates elsewhere uses `?.`, which already treats the two the
  // same): explicitly clearing overrides back to the built-in defaults via
  // `{"templates": null}` worked before this function existed at all, and
  // rejecting it now would be a regression, not a new safety check.
  if (templates === undefined || templates === null) return true;
  if (typeof templates !== "object") return false;
  const { initialGrounded, initialUngrounded, followUps, notInterestedCloser } = templates as Record<string, unknown>;
  if (initialGrounded !== undefined && !isNonEmptyString(initialGrounded)) return false;
  if (initialUngrounded !== undefined && !isNonEmptyString(initialUngrounded)) return false;
  if (notInterestedCloser !== undefined && !isNonEmptyString(notInterestedCloser)) return false;
  if (followUps !== undefined && (!Array.isArray(followUps) || !followUps.every(isNonEmptyString))) return false;
  return true;
}

/**
 * Validates a tenant config patch/create body against the current (pre-merge)
 * tenant state, if any — so e.g. enabling autoReplyEnabled without touching
 * knowledgeBase in this request still checks against the tenant's existing
 * knowledgeBase. Returns an error message, or undefined if valid.
 */
function validateTenantConfig(body: Partial<TenantConfigBody>, existing?: Tenant): string | undefined {
  if (body.timezone !== undefined && !isValidTimezone(body.timezone)) {
    return `invalid timezone: ${body.timezone}`;
  }
  if (!isValidQuietHours(body.quietHours)) {
    return "quietHours must be { startHour: 0-23, endHour: 0-23 }";
  }
  if (!isValidWebhookUrl(body.notifyWebhookUrl)) {
    return "notifyWebhookUrl must be a valid http(s) URL";
  }
  if (!isValidKnowledgeBase(body.knowledgeBase)) {
    return `knowledgeBase must be a string up to ${MAX_KNOWLEDGE_BASE_LENGTH} characters`;
  }
  if (!isValidStatus(body.status)) {
    return 'status must be "active" or "suspended"';
  }
  if (!isValidTemplates(body.templates)) {
    return "templates.initialGrounded/initialUngrounded/notInterestedCloser must be non-empty strings, and followUps (if set) an array of non-empty strings";
  }
  const mergedKnowledgeBase = body.knowledgeBase !== undefined ? body.knowledgeBase : existing?.knowledgeBase;
  const mergedAutoReplyEnabled =
    body.autoReplyEnabled !== undefined ? body.autoReplyEnabled : existing?.autoReplyEnabled;
  if (mergedAutoReplyEnabled && !mergedKnowledgeBase?.trim()) {
    return "autoReplyEnabled requires a non-empty knowledgeBase";
  }
  return undefined;
}

function buildTenantPatch(
  body: Partial<TenantConfigBody>,
  { includeStatus }: { includeStatus: boolean }
): Partial<Tenant> {
  const patch: Partial<Tenant> = {};
  if (body.timezone !== undefined) patch.timezone = body.timezone;
  if (body.quietHours !== undefined) patch.quietHours = body.quietHours;
  if (body.devMode !== undefined) patch.devMode = body.devMode;
  if (body.channels !== undefined) patch.channels = body.channels;
  if (body.notifyWebhookUrl !== undefined) patch.notifyWebhookUrl = body.notifyWebhookUrl;
  if (body.templates !== undefined) patch.templates = body.templates;
  if (body.knowledgeBase !== undefined) patch.knowledgeBase = body.knowledgeBase;
  if (body.autoReplyEnabled !== undefined) patch.autoReplyEnabled = body.autoReplyEnabled;
  if (includeStatus && body.status !== undefined) patch.status = body.status;
  return patch;
}

/**
 * Tenant self-service (`/tenants/me`, `PATCH /tenants/me`) and admin tenant
 * management (`/admin/tenants`, gated by ADMIN_API_KEY). The admin routes
 * are how a new client gets onboarded programmatically; `npm run onboard`
 * wraps this same flow in an interactive CLI.
 */
export function createTenantRoutes({
  tenantStore,
  leadStore,
  messageStore,
  notificationStore,
  auditLogStore,
}: Stores): Router {
  const router = Router();
  const tenantAuth = requireTenantAuth(tenantStore);
  const adminAuth = requireAdminAuth();

  router.get("/tenants/me", createTenantLimiter(), tenantAuth, (req, res) => {
    res.json(toPublicTenant(req.tenant!));
  });

  // A summary the tenant (or whoever runs this on their behalf) can use for
  // "what did this cost/deliver this period" reporting — e.g. a monthly
  // retainer's activity report — without hand-computing it from GET /leads
  // and message history. `leads` is always a current pipeline-health
  // snapshot (not date-filtered); `messages` is activity within the
  // optional [since, until] window, which is what a billing-period report
  // actually wants ("what happened this month"), not "what leads happen to
  // have been created this month."
  router.get(
    "/tenants/me/report",
    createTenantLimiter(),
    tenantAuth,
    asyncHandler(async (req, res) => {
      const tenant = req.tenant!;
      const since = typeof req.query.since === "string" ? req.query.since : undefined;
      const until = typeof req.query.until === "string" ? req.query.until : undefined;
      if (since !== undefined && Number.isNaN(Date.parse(since))) {
        res.status(400).json({ error: "since must be a valid ISO date" });
        return;
      }
      if (until !== undefined && Number.isNaN(Date.parse(until))) {
        res.status(400).json({ error: "until must be a valid ISO date" });
        return;
      }

      // Independent queries — fetch concurrently rather than paying for two
      // sequential round trips to the store.
      const [leads, messages] = await Promise.all([
        leadStore.getAllLeads(tenant.id),
        messageStore.listForTenant(tenant.id, { since, until }),
      ]);

      const leadsByStatus: Partial<Record<Lead["status"], number>> = {};
      for (const lead of leads) {
        leadsByStatus[lead.status] = (leadsByStatus[lead.status] ?? 0) + 1;
      }

      let outboundSent = 0;
      const outboundByKind: Partial<Record<NonNullable<Message["kind"]>, number>> = {};
      let inboundReceived = 0;
      const inboundByClassification: Partial<Record<ReplyClassification | "unclassified", number>> = {};
      for (const message of messages) {
        if (message.direction === "outbound") {
          outboundSent++;
          const kind = message.kind ?? "campaign";
          outboundByKind[kind] = (outboundByKind[kind] ?? 0) + 1;
        } else {
          inboundReceived++;
          const classification = message.classification ?? "unclassified";
          inboundByClassification[classification] = (inboundByClassification[classification] ?? 0) + 1;
        }
      }

      res.json({
        range: { since: since ?? null, until: until ?? null },
        leads: { total: leads.length, byStatus: leadsByStatus },
        messages: { outboundSent, outboundByKind, inboundReceived, inboundByClassification },
      });
    })
  );

  // Self-service settings: a tenant can update its own operational config
  // (timezone/quiet hours/devMode/channel credentials/notification hook/
  // message templates/chatbot) using its own API key. id/apiKey/createdAt/
  // status are immutable here — a tenant can't un-suspend itself, and API
  // key rotation goes through the admin API.
  router.patch(
    "/tenants/me",
    createTenantLimiter(),
    tenantAuth,
    asyncHandler(async (req, res) => {
      const tenant = req.tenant!;
      const body = req.body as Partial<TenantConfigBody>;

      if (body.status !== undefined) {
        res.status(400).json({ error: "status can only be changed via the admin API" });
        return;
      }
      const error = validateTenantConfig(body, tenant);
      if (error) {
        res.status(400).json({ error });
        return;
      }

      const updated = await tenantStore.updateTenant(tenant.id, buildTenantPatch(body, { includeStatus: false }));
      res.json(toPublicTenant(updated!));
    })
  );

  // Optional ?limit=&offset= pagination; omitted (the default) returns everything, unchanged from before.
  router.get(
    "/admin/tenants",
    createAdminLimiter(),
    adminAuth,
    asyncHandler(async (req, res) => {
      const tenants = await tenantStore.listTenants();
      res.set("X-Total-Count", String(tenants.length));
      res.json(paginate(tenants, parsePageParams(req)).map(toPublicTenant));
    })
  );

  router.post(
    "/admin/tenants",
    createAdminLimiter(),
    adminAuth,
    asyncHandler(async (req, res) => {
      const body = req.body as Partial<TenantConfigBody>;
      if (!body.name || !body.timezone) {
        res.status(400).json({ error: "name and timezone are required" });
        return;
      }
      const error = validateTenantConfig(body);
      if (error) {
        res.status(400).json({ error });
        return;
      }

      const tenant: Tenant = {
        id: generateId("tenant"),
        name: body.name,
        apiKey: generateApiKey(),
        timezone: body.timezone,
        quietHours: body.quietHours,
        devMode: body.devMode ?? false,
        channels: body.channels ?? {},
        notifyWebhookUrl: body.notifyWebhookUrl,
        templates: body.templates,
        knowledgeBase: body.knowledgeBase,
        autoReplyEnabled: body.autoReplyEnabled ?? false,
        status: "active",
        createdAt: new Date().toISOString(),
      };

      const created = await tenantStore.createTenant(tenant);
      await recordAudit(auditLogStore, {
        tenantId: created.id,
        action: "tenant.create",
        actor: req.adminActor ?? "admin",
        details: { name: created.name, timezone: created.timezone },
      });
      // Only place the raw API key is ever returned — the client must save it now.
      res.status(201).json({ ...toPublicTenant(created), apiKey: created.apiKey });
    })
  );

  // Admin update — the only way to change a tenant's status (e.g. suspend for
  // non-payment or while an issue is investigated) or edit config on a
  // client's behalf without needing their API key.
  router.patch(
    "/admin/tenants/:id",
    createAdminLimiter(),
    adminAuth,
    asyncHandler(async (req, res) => {
      const existing = await tenantStore.getTenant(req.params.id);
      if (!existing) {
        res.status(404).json({ error: "no such tenant" });
        return;
      }
      const body = req.body as Partial<TenantConfigBody>;
      const error = validateTenantConfig(body, existing);
      if (error) {
        res.status(400).json({ error });
        return;
      }

      const updated = await tenantStore.updateTenant(req.params.id, buildTenantPatch(body, { includeStatus: true }));
      await recordAudit(auditLogStore, {
        tenantId: req.params.id,
        action: "tenant.admin_update",
        actor: req.adminActor ?? "admin",
        // Field names only — never the values, so this never duplicates a
        // credential/secret into a second store.
        details: { fieldsChanged: Object.keys(body) },
      });
      res.json(toPublicTenant(updated!));
    })
  );

  // Rotates a tenant's API key without touching anything else — the old key
  // stops working immediately. Use this instead of delete+recreate when a
  // key has leaked; the tenant keeps its id, leads, and message history.
  router.post(
    "/admin/tenants/:id/rotate-key",
    createAdminLimiter(),
    adminAuth,
    asyncHandler(async (req, res) => {
      const existing = await tenantStore.getTenant(req.params.id);
      if (!existing) {
        res.status(404).json({ error: "no such tenant" });
        return;
      }
      const updated = await tenantStore.updateTenant(req.params.id, { apiKey: generateApiKey() });
      await recordAudit(auditLogStore, {
        tenantId: req.params.id,
        action: "tenant.key_rotate",
        actor: req.adminActor ?? "admin",
      });
      // Only place the new raw API key is ever returned — the client must save it now.
      res.json({ ...toPublicTenant(updated!), apiKey: updated!.apiKey });
    })
  );

  // Permanently removes a tenant. In Postgres this cascades to the tenant's
  // leads and messages (ON DELETE CASCADE) — there is no undo.
  router.delete(
    "/admin/tenants/:id",
    createAdminLimiter(),
    adminAuth,
    asyncHandler(async (req, res) => {
      const deleted = await tenantStore.deleteTenant(req.params.id);
      if (!deleted) {
        res.status(404).json({ error: "no such tenant" });
        return;
      }
      await recordAudit(auditLogStore, {
        tenantId: req.params.id,
        action: "tenant.delete",
        actor: req.adminActor ?? "admin",
      });
      res.status(204).send();
    })
  );

  // Visibility into notify.ts's dead-letter queue: notifications ("interested"
  // replies / chatbot escalations) that failed to reach a tenant's
  // notifyWebhookUrl even after retries. "pending" ones are still being
  // retried by the worker each tick; "dead" ones gave up after
  // NOTIFICATION_MAX_ATTEMPTS and need a human to notice (usually a broken
  // notifyWebhookUrl) and fix the target, at which point new notifications
  // succeed again — this endpoint is how you'd notice in the first place.
  router.get(
    "/admin/notifications/failed",
    createAdminLimiter(),
    adminAuth,
    asyncHandler(async (_req, res) => {
      res.json(await notificationStore.listAll());
    })
  );

  // Optional ?limit=&offset= pagination; omitted returns everything.
  router.get(
    "/admin/audit-log",
    createAdminLimiter(),
    adminAuth,
    asyncHandler(async (req, res) => {
      const total = await auditLogStore.count();
      res.set("X-Total-Count", String(total));
      res.json(await auditLogStore.list(parsePageParams(req)));
    })
  );

  return router;
}
