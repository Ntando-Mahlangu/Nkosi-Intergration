import sgMail from "@sendgrid/mail";
import { logger } from "./logger.js";

/**
 * LeadRecovery's own transactional email (account setup / password reset
 * links) — distinct from a tenant's `channels.email` credentials, which
 * send messages to THAT business's own leads, on their behalf, from their
 * own SendGrid account. This is the platform's own mail to its own tenants,
 * so it uses one shared, platform-level SendGrid account
 * (PLATFORM_SENDGRID_API_KEY/PLATFORM_EMAIL_FROM), not a per-tenant one.
 *
 * Falls back to logging the link (and the caller returning it directly in
 * the API response — see src/routes/auth.ts) when no platform SendGrid key
 * is configured, the same "never silently do nothing" fallback pattern
 * every channel adapter already uses for devMode.
 */
export async function sendAccountEmail(to: string, subject: string, text: string): Promise<void> {
  const apiKey = process.env.PLATFORM_SENDGRID_API_KEY;
  const from = process.env.PLATFORM_EMAIL_FROM;
  if (!apiKey || !from) {
    logger.info("account_email_not_configured", { to, subject, text });
    return;
  }
  sgMail.setApiKey(apiKey);
  await sgMail.send({ to, from, subject, text });
}
