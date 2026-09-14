import rateLimit from "express-rate-limit";

/** Guards tenant onboarding/management — low volume by nature, so a tight limit doesn't hurt legitimate use. */
export function createAdminLimiter() {
  return rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 30,
    standardHeaders: true,
    legacyHeaders: false,
  });
}

/** Guards inbound provider webhooks against flooding/abuse; generous enough for real Twilio/SendGrid traffic. */
export function createWebhookLimiter() {
  return rateLimit({
    windowMs: 60 * 1000,
    limit: 120,
    standardHeaders: true,
    legacyHeaders: false,
  });
}

/** Guards tenant-authenticated routes so a leaked API key can't be used to hammer the API. */
export function createTenantLimiter() {
  return rateLimit({
    windowMs: 60 * 1000,
    limit: 60,
    standardHeaders: true,
    legacyHeaders: false,
  });
}
