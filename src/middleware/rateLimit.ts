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

/**
 * Guards inbound provider webhooks against flooding/abuse; generous enough
 * for real Twilio/SendGrid traffic.
 *
 * `passOnStoreError: true` (unlike the other two limiters below) — a
 * transient Postgres error from the distributed store must never turn into
 * a 500 that blocks every inbound webhook at once, including a lead's own
 * STOP reply or a Paddle billing event. Failing open here trades a brief
 * window of unlimited webhook traffic during a rare DB blip for never
 * silently dropping a compliance-critical inbound message; the admin/tenant
 * limiters below guard authenticated/credentialed routes instead, where
 * failing closed on an uncertain store state is the safer default.
 */
export function createWebhookLimiter() {
  return rateLimit({
    windowMs: 60 * 1000,
    limit: 120,
    standardHeaders: true,
    legacyHeaders: false,
    store: distributedStoreIfConfigured("webhook"),
    passOnStoreError: true,
  });
}

/**
 * Guards tenant-authenticated routes so a leaked API key can't be used to
 * hammer the API. Configurable for the same reason createAdminLimiter is —
 * the dashboard e2e suite drives many tenant-authed actions from the same
 * loopback IP/API key in a short span, well beyond what a real client hits
 * in production; see playwright.config.ts, which raises this for the e2e
 * test run only.
 */
export function createTenantLimiter() {
  return rateLimit({
    windowMs: 60 * 1000,
    limit: Number(process.env.LEADRECOVERY_TENANT_RATE_LIMIT ?? 60),
    standardHeaders: true,
    legacyHeaders: false,
    store: distributedStoreIfConfigured("tenant"),
  });
}

/**
 * Guards the unauthenticated email/password sign-in endpoints
 * (src/routes/auth.ts) — a login attempt is exactly the kind of request a
 * brute-force/credential-stuffing attempt looks like, so this is
 * deliberately tighter than createTenantLimiter's already-authenticated
 * ceiling. Fails closed (no passOnStoreError) like createAdminLimiter/
 * createTenantLimiter: an uncertain store state should never widen a login
 * endpoint's rate limit.
 */
export function createAuthLimiter() {
  return rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: Number(process.env.LEADRECOVERY_AUTH_RATE_LIMIT ?? 10),
    standardHeaders: true,
    legacyHeaders: false,
    store: distributedStoreIfConfigured("auth"),
  });
}

/**
 * Guards the public lead-capture endpoint (POST /public/leads/:tenantId) —
 * unauthenticated by design (it's meant to be called from a tenant's own
 * public website), so this is its only real defense against a flood of
 * junk leads. `passOnStoreError: true` for the same reason as
 * createWebhookLimiter: a transient store error should never silently drop
 * a real website visitor's submission.
 */
export function createPublicFormLimiter() {
  return rateLimit({
    windowMs: 60 * 1000,
    limit: 20,
    standardHeaders: true,
    legacyHeaders: false,
    store: distributedStoreIfConfigured("public-form"),
    passOnStoreError: true,
  });
}

/**
 * Guards the public website chat widget (src/routes/publicChat.ts) —
 * unauthenticated by design, same reasoning as createPublicFormLimiter, but
 * its own separate budget/keyPrefix: a real back-and-forth conversation
 * sends far more requests per visitor than a one-shot contact-form submit,
 * so reusing that limiter's tighter budget would cut a real chat short.
 */
export function createPublicChatLimiter() {
  return rateLimit({
    windowMs: 60 * 1000,
    limit: 30,
    standardHeaders: true,
    legacyHeaders: false,
    store: distributedStoreIfConfigured("public-chat"),
    passOnStoreError: true,
  });
}
