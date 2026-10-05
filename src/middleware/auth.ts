import type { NextFunction, Request, RequestHandler, Response } from "express";
import type { TenantStore, TenantUserStore } from "../store/types.js";
import type { Tenant } from "../types.js";
import { safeCompare } from "../security.js";
import { asyncHandler } from "./asyncHandler.js";

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      tenant?: Tenant;
      /** Set by requireAdminAuth() to whichever admin key name authenticated this request (see parseAdminKeys). */
      adminActor?: string;
      /**
       * Set by requireTenantAuth() to whichever identity authenticated this
       * request — the tenant's own login email (or "owner" if it has none)
       * when authenticated via the tenant's own apiKey, or a specific team
       * member's email when authenticated via their own TenantUser.loginKey.
       * For attribution in the audit log, same role requireAdminAuth's
       * adminActor plays for admin routes.
       */
      actor?: string;
      /**
       * The resolved identity's role — "owner" when authenticated via the
       * tenant's own apiKey (always, whether or not any TenantUser rows
       * exist — the tenant's own login is an implicit, unremovable owner)
       * or via a TenantUser with role "owner"; "member" for a TenantUser
       * with role "member". See requireOwnerRole below.
       */
      actorRole?: "owner" | "member";
    }
  }
}

function extractBearerToken(req: Request): string | undefined {
  const header = req.header("authorization");
  if (!header) return undefined;
  const [scheme, token] = header.split(" ");
  return scheme?.toLowerCase() === "bearer" ? token : undefined;
}

/**
 * Resolves the calling tenant from `Authorization: Bearer <...>` and
 * attaches it to `req.tenant`, along with `req.actor`/`req.actorRole` (see
 * their own doc comments above) for per-person attribution.
 *
 * Accepts either of two bearer credentials, both granting the same
 * tenant-scoped access: the tenant's own `apiKey` (unchanged — resolves to
 * actorRole "owner", since this is the tenant's own master credential), or
 * a team member's personal `TenantUser.loginKey` (see types.ts's TenantUser
 * — resolves to that member's own email + role). `tenantUserStore` is
 * optional so every existing call site keeps working unchanged until
 * updated to pass it; omitting it simply means team-member logins aren't
 * accepted on that particular route (e.g. a system-to-system webhook that
 * has no reason to support one).
 */
export function requireTenantAuth(tenantStore: TenantStore, tenantUserStore?: TenantUserStore): RequestHandler {
  // asyncHandler-wrapped for the same reason every route handler using this
  // is: it's async middleware, not a route handler, but Express 4 doesn't
  // forward a rejection from either kind to error-handling middleware on
  // its own — without this, tenantStore.getTenantByApiKey throwing (a
  // transient DB error) would leave the request hanging forever with no
  // response ever sent, on every tenant-authenticated route in the app.
  return asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    const token = extractBearerToken(req);
    if (!token) {
      res.status(401).json({ error: "missing Authorization: Bearer <api key> header" });
      return;
    }

    let tenant = await tenantStore.getTenantByApiKey(token);
    let actor: string | undefined;
    let actorRole: "owner" | "member" = "owner";

    if (!tenant && tenantUserStore) {
      const tenantUser = await tenantUserStore.getTenantUserByLoginKey(token);
      if (tenantUser) {
        tenant = await tenantStore.getTenant(tenantUser.tenantId);
        actor = tenantUser.email;
        actorRole = tenantUser.role;
      }
    }

    if (!tenant) {
      res.status(401).json({ error: "invalid API key" });
      return;
    }
    if (tenant.status === "suspended") {
      res.status(403).json({ error: "this tenant has been suspended" });
      return;
    }
    req.tenant = tenant;
    req.actor = actor ?? tenant.email ?? "owner";
    req.actorRole = actorRole;
    next();
  });
}

/**
 * Gates a tenant-authenticated route to the tenant's own apiKey login or a
 * TenantUser with role "owner" — rejects a "member"-role team account with
 * 403. Applied to tenant-wide settings (PATCH /tenants/me, the password
 * change endpoint) and team management itself (POST/PATCH/DELETE
 * /tenants/me/team*): day-to-day lead/message work stays open to both
 * roles, but anything that could let a team member escalate their own
 * access (e.g. changing the tenant's own password, or inviting a new
 * owner-role member) is owner-only. Must run after requireTenantAuth.
 */
export function requireOwnerRole(): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    if (req.actorRole !== "owner") {
      res.status(403).json({ error: "only a team owner can do this" });
      return;
    }
    next();
  };
}

interface AdminKeyEntry {
  /** Recorded as the audit log `actor` for any action authenticated with this key. */
  name: string;
  key: string;
}

/**
 * Reads admin credentials fresh on every call (not cached at module load) —
 * both env vars are plain strings a deployment or a test can change at any
 * time, and several existing tests toggle ADMIN_API_KEY per-test via direct
 * assignment.
 *
 * `ADMIN_API_KEY` (legacy, still supported) is a single shared key with no
 * per-person identity — every action it authenticates is recorded as actor
 * "admin". `ADMIN_API_KEYS` is a comma-separated `name:key` list
 * (e.g. `alice:<random>,bob:<random>`) so multiple people working the same
 * agency can each hold their own key, and the audit log
 * (GET /admin/audit-log) records *which one* took an action instead of an
 * indistinguishable "admin" for everyone. Both can be set at once; a
 * malformed entry in ADMIN_API_KEYS (no `:`, or an empty name/key) is
 * skipped rather than failing every other configured key.
 */
function parseAdminKeys(): AdminKeyEntry[] {
  const entries: AdminKeyEntry[] = [];
  const legacyKey = process.env.ADMIN_API_KEY;
  if (legacyKey) entries.push({ name: "admin", key: legacyKey });

  for (const rawEntry of (process.env.ADMIN_API_KEYS ?? "").split(",")) {
    const trimmed = rawEntry.trim();
    if (!trimmed) continue;
    const separator = trimmed.indexOf(":");
    if (separator === -1) continue;
    const name = trimmed.slice(0, separator).trim();
    const key = trimmed.slice(separator + 1).trim();
    if (name && key) entries.push({ name, key });
  }
  return entries;
}

/**
 * Protects tenant-management endpoints with one or more operator-held admin
 * keys (see parseAdminKeys). Sets req.adminActor to whichever key's name
 * authenticated the request, for attribution in the audit log.
 */
export function requireAdminAuth(): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    const adminKeys = parseAdminKeys();
    if (adminKeys.length === 0) {
      res.status(503).json({ error: "admin API disabled: set ADMIN_API_KEY or ADMIN_API_KEYS" });
      return;
    }
    const token = extractBearerToken(req);
    const match = token ? adminKeys.find((entry) => safeCompare(token, entry.key)) : undefined;
    if (!match) {
      res.status(401).json({ error: "invalid admin key" });
      return;
    }
    req.adminActor = match.name;
    next();
  };
}
