import { Router } from "express";
import type { TenantStore } from "../store/types.js";
import { toPublicTenant, type Tenant } from "../types.js";
import { requireAdminAuth, requireTenantAuth } from "../middleware/auth.js";
import { generateApiKey, generateId } from "../idgen.js";

interface CreateTenantBody {
  name: string;
  timezone: string;
  quietHours?: Tenant["quietHours"];
  devMode?: boolean;
  channels?: Tenant["channels"];
}

/**
 * Tenant self-service (`/tenants/me`) and admin tenant management
 * (`/admin/tenants`, gated by ADMIN_API_KEY). The admin routes are how a new
 * client gets onboarded programmatically; `npm run onboard` wraps this same
 * flow in an interactive CLI.
 */
export function createTenantRoutes(tenantStore: TenantStore): Router {
  const router = Router();

  router.get("/tenants/me", requireTenantAuth(tenantStore), (req, res) => {
    res.json(toPublicTenant(req.tenant!));
  });

  router.get("/admin/tenants", requireAdminAuth(), async (_req, res) => {
    const tenants = await tenantStore.listTenants();
    res.json(tenants.map(toPublicTenant));
  });

  router.post("/admin/tenants", requireAdminAuth(), async (req, res) => {
    const body = req.body as Partial<CreateTenantBody>;
    if (!body.name || !body.timezone) {
      res.status(400).json({ error: "name and timezone are required" });
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
      createdAt: new Date().toISOString(),
    };

    const created = await tenantStore.createTenant(tenant);
    // Only place the raw API key is ever returned — the client must save it now.
    res.status(201).json({ ...toPublicTenant(created), apiKey: created.apiKey });
  });

  return router;
}
