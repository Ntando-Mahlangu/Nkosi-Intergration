import rateLimit from "express-rate-limit";
import { getPool } from "../db/pool.js";
import { PgRateLimitStore } from "./pgRateLimitStore.js";

/**
 * A distributed Postgres-backed store when DATABASE_URL is set (so limits
 * hold across every app replica sharing that database), otherwise
 * express-rate-limit's own in-memory default — correct for the
 * single-process demo/test setup and avoids requiring a database just to
 * run the unit suite. `keyPrefix` must be distinct per limiter — see
 * PgRateLimitStore's own doc comment for why (two limiters sharing a
 * windowMs would otherwise collide on the same Postgres row for the same
 * client IP).
 */
function distributedStoreIfConfigured(keyPrefix: string) {
  return process.env.DATABASE_URL ? new PgRateLimitStore(getPool(), keyPrefix) : undefined;
}

/**
 * Guards tenant onboarding/management — low volume by nature, so a tight
 * limit doesn't hurt legitimate use. Configurable because a UI driving many
 * admin actions in a short span (e.g. the admin.html e2e tests clicking
 * through create/suspend/rotate/delete repeatedly) can legitimately need a
 * higher ceiling than a human operator would in the same 15 minutes — see
 * playwright.config.ts, which raises this for the e2e test run only.
 */
export function createAdminLimiter() {
  return rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: Number(process.env.LEADRECOVERY_ADMIN_RATE_LIMIT ?? 30),
    standardHeaders: true,
    legacyHeaders: false,
    store: distributedStoreIfConfigured("admin"),
  });
}

/** Guards inbound provider webhooks against flooding/abuse; generous enough for real Twilio/SendGrid traffic. */
export function createWebhookLimiter() {
  return rateLimit({
    windowMs: 60 * 1000,
    limit: 120,
    standardHeaders: true,
    legacyHeaders: false,
    store: distributedStoreIfConfigured("webhook"),
  });
}

/** Guards tenant-authenticated routes so a leaked API key can't be used to hammer the API. */
export function createTenantLimiter() {
  return rateLimit({
    windowMs: 60 * 1000,
    limit: 60,
    standardHeaders: true,
    legacyHeaders: false,
    store: distributedStoreIfConfigured("tenant"),
  });
}
