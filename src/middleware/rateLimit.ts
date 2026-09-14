import rateLimit from "express-rate-limit";
import { getPool } from "../db/pool.js";
import { PgRateLimitStore } from "./pgRateLimitStore.js";

/**
 * A distributed Postgres-backed store when DATABASE_URL is set (so limits
 * hold across every app replica sharing that database), otherwise
 * express-rate-limit's own in-memory default — correct for the
 * single-process demo/test setup and avoids requiring a database just to
 * run the unit suite.
 */
function distributedStoreIfConfigured() {
  return process.env.DATABASE_URL ? new PgRateLimitStore(getPool()) : undefined;
}

/** Guards tenant onboarding/management — low volume by nature, so a tight limit doesn't hurt legitimate use. */
export function createAdminLimiter() {
  return rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 30,
    standardHeaders: true,
    legacyHeaders: false,
    store: distributedStoreIfConfigured(),
  });
}

/** Guards inbound provider webhooks against flooding/abuse; generous enough for real Twilio/SendGrid traffic. */
export function createWebhookLimiter() {
  return rateLimit({
    windowMs: 60 * 1000,
    limit: 120,
    standardHeaders: true,
    legacyHeaders: false,
    store: distributedStoreIfConfigured(),
  });
}

/** Guards tenant-authenticated routes so a leaked API key can't be used to hammer the API. */
export function createTenantLimiter() {
  return rateLimit({
    windowMs: 60 * 1000,
    limit: 60,
    standardHeaders: true,
    legacyHeaders: false,
    store: distributedStoreIfConfigured(),
  });
}
