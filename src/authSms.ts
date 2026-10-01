import twilio from "twilio";
import { logger } from "./logger.js";

/**
 * LeadRecovery's own transactional SMS — one-time login codes
 * (src/routes/auth.ts's /auth/request-code) — distinct from a tenant's
 * `channels.sms`, which texts THAT business's own leads on their behalf.
 * Reuses the same shared agency Twilio account as channelDefaults.ts/
 * numberHosting.ts (DEFAULT_TWILIO_ACCOUNT_SID/AUTH_TOKEN) for auth, with
 * its own dedicated sending number (PLATFORM_SMS_FROM_NUMBER) so a client's
 * own assigned/hosted number is never used to text the client about their
 * own account.
 *
 * Falls back to logging the code (never returned over the API itself — see
 * routes/auth.ts) when not configured, the same "never silently do nothing"
 * fallback every channel adapter already uses for devMode.
 */
export async function sendAccountSms(to: string, body: string): Promise<void> {
  const accountSid = process.env.DEFAULT_TWILIO_ACCOUNT_SID;
  const authToken = process.env.DEFAULT_TWILIO_AUTH_TOKEN;
  const from = process.env.PLATFORM_SMS_FROM_NUMBER;
  if (!accountSid || !authToken || !from) {
    logger.info("account_sms_not_configured", { to, body });
    return;
  }
  const client = twilio(accountSid, authToken);
  await client.messages.create({ to, from, body });
}
