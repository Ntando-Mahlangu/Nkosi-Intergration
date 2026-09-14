import { Router } from "express";
import type { TenantStore } from "../store/types.js";
import { toPublicTenant, type Tenant } from "../types.js";
import { requireAdminAuth, requireTenantAuth } from "../middleware/auth.js";
import { createAdminLimiter, createTenantLimiter } from "../middleware/rateLimit.js";
import { generateApiKey, generateId } from "../idgen.js";

const MAX_KNOWLEDGE_BASE_LENGTH = 20_000;

interface CreateTenantBody {
  name: string;
  timezone: string;
  quietHours?: Tenant["quietHours"];
  devMode?: boolean;
  channels?: Tenant["channels"];
  notifyWebhookUrl?: string;
  templates?: Tenant["templates"];
  knowledgeBase?: string;
  autoReplyEnabled?: boolean;
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
    return parsed.protocol === "https:" || parsed.protocol === "http:";
  } catch {
    return false;
  }
}

function isValidKnowledgeBase(knowledgeBase: unknown): boolean {
  if (knowledgeBase === undefined) return true;
  return typeof knowledgeBase === "string" && knowledgeBase.length <= MAX_KNOWLEDGE_BASE_LENGTH;
}

/**
 * Tenant self-service (`/tenants/me`, `PATCH /tenants/me`) and admin tenant
 * management (`/admin/tenants`, gated by ADMIN_API_KEY). The admin routes
 * are how a new client gets onboarded programmatically; `npm run onboard`
 * wraps this same flow in an interactive CLI.
 */
export function createTenantRoutes(tenantStore: TenantStore): Router {
  const router = Router();
  const tenantAuth = requireTenantAuth(tenantStore);

  router.get("/tenants/me", createTenantLimiter(), tenantAuth, (req, res) => {
    res.json(toPublicTenant(req.tenant!));
  });

  // Self-service settings: a tenant can update its own operational config
  // (timezone/quiet hours/devMode/channel credentials/notification hook/
  // message templates) using its own API key. id/apiKey/createdAt are
  // immutable here — rotate the API key via the admin API if ever needed.
  router.patch("/tenants/me", createTenantLimiter(), tenantAuth, async (req, res) => {
    const tenant = req.tenant!;
    const body = req.body as Partial<CreateTenantBody>;

    if (body.timezone !== undefined && !isValidTimezone(body.timezone)) {
      res.status(400).json({ error: `invalid timezone: ${body.timezone}` });
      return;
    }
    if (!isValidQuietHours(body.quietHours)) {
      res.status(400).json({ error: "quietHours must be { startHour: 0-23, endHour: 0-23 }" });
      return;
    }
    if (!isValidWebhookUrl(body.notifyWebhookUrl)) {
      res.status(400).json({ error: "notifyWebhookUrl must be a valid http(s) URL" });
      return;
    }
    if (!isValidKnowledgeBase(body.knowledgeBase)) {
      res.status(400).json({ error: `knowledgeBase must be a string up to ${MAX_KNOWLEDGE_BASE_LENGTH} characters` });
      return;
    }

    const mergedKnowledgeBase = body.knowledgeBase !== undefined ? body.knowledgeBase : tenant.knowledgeBase;
    const mergedAutoReplyEnabled = body.autoReplyEnabled !== undefined ? body.autoReplyEnabled : tenant.autoReplyEnabled;
    if (mergedAutoReplyEnabled && !mergedKnowledgeBase?.trim()) {
      res.status(400).json({ error: "autoReplyEnabled requires a non-empty knowledgeBase" });
      return;
    }

    const patch: Partial<Tenant> = {};
    if (body.timezone !== undefined) patch.timezone = body.timezone;
    if (body.quietHours !== undefined) patch.quietHours = body.quietHours;
    if (body.devMode !== undefined) patch.devMode = body.devMode;
    if (body.channels !== undefined) patch.channels = body.channels;
    if (body.notifyWebhookUrl !== undefined) patch.notifyWebhookUrl = body.notifyWebhookUrl;
    if (body.templates !== undefined) patch.templates = body.templates;
    if (body.knowledgeBase !== undefined) patch.knowledgeBase = body.knowledgeBase;
    if (body.autoReplyEnabled !== undefined) patch.autoReplyEnabled = body.autoReplyEnabled;

    const updated = await tenantStore.updateTenant(tenant.id, patch);
    res.json(toPublicTenant(updated!));
  });

  router.get("/admin/tenants", createAdminLimiter(), requireAdminAuth(), async (_req, res) => {
    const tenants = await tenantStore.listTenants();
    res.json(tenants.map(toPublicTenant));
  });

  router.post("/admin/tenants", createAdminLimiter(), requireAdminAuth(), async (req, res) => {
    const body = req.body as Partial<CreateTenantBody>;
    if (!body.name || !body.timezone) {
      res.status(400).json({ error: "name and timezone are required" });
      return;
    }
    if (!isValidTimezone(body.timezone)) {
      res.status(400).json({ error: `invalid timezone: ${body.timezone}` });
      return;
    }
    if (!isValidQuietHours(body.quietHours)) {
      res.status(400).json({ error: "quietHours must be { startHour: 0-23, endHour: 0-23 }" });
      return;
    }
    if (!isValidWebhookUrl(body.notifyWebhookUrl)) {
      res.status(400).json({ error: "notifyWebhookUrl must be a valid http(s) URL" });
      return;
    }
    if (!isValidKnowledgeBase(body.knowledgeBase)) {
      res.status(400).json({ error: `knowledgeBase must be a string up to ${MAX_KNOWLEDGE_BASE_LENGTH} characters` });
      return;
    }
    if (body.autoReplyEnabled && !body.knowledgeBase?.trim()) {
      res.status(400).json({ error: "autoReplyEnabled requires a non-empty knowledgeBase" });
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
      createdAt: new Date().toISOString(),
    };

    const created = await tenantStore.createTenant(tenant);
    // Only place the raw API key is ever returned — the client must save it now.
    res.status(201).json({ ...toPublicTenant(created), apiKey: created.apiKey });
  });

  return router;
}
