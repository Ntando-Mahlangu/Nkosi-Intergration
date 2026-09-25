import type { ChannelCredentials, SendGridCredentials, TwilioCredentials } from "./types.js";

/**
 * An agency running LeadRecovery for multiple small-business clients
 * typically owns ONE Twilio account (with a pool of purchased numbers)
 * and ONE SendGrid account, reused across every client — only the phone
 * number/from-address actually differs per client. Nothing in the data
 * model ties one Twilio/SendGrid credential set to one tenant, so this is
 * already possible by hand; these env vars just let the admin "Add new
 * client" form skip re-entering the same Account SID/Auth Token/API key
 * every time, asking only for the one thing that's genuinely per-client.
 *
 * A client bringing their own Twilio/SendGrid account still works exactly
 * as before — just supply that channel's accountSid/authToken/apiKey
 * directly and these defaults are never consulted for it.
 */
function getChannelDefaults() {
  return {
    twilioAccountSid: process.env.DEFAULT_TWILIO_ACCOUNT_SID,
    twilioAuthToken: process.env.DEFAULT_TWILIO_AUTH_TOKEN,
    sendgridApiKey: process.env.DEFAULT_SENDGRID_API_KEY,
  };
}

type PartialTwilio = Partial<TwilioCredentials>;
type PartialSendGrid = Partial<SendGridCredentials>;

function resolveTwilioChannel(
  label: "sms" | "whatsapp",
  creds: PartialTwilio,
  defaults: ReturnType<typeof getChannelDefaults>
): { creds?: TwilioCredentials; error?: string } {
  if (!creds.fromNumber) {
    return { error: `channels.${label}.fromNumber is required` };
  }
  if (creds.accountSid && creds.authToken) {
    return { creds: creds as TwilioCredentials };
  }
  if (creds.accountSid || creds.authToken) {
    return {
      error: `channels.${label} must include both accountSid and authToken, or neither (to use the shared default account)`,
    };
  }
  if (!defaults.twilioAccountSid || !defaults.twilioAuthToken) {
    return {
      error:
        `channels.${label}.fromNumber was given but no accountSid/authToken, and no default Twilio account is ` +
        "configured (set DEFAULT_TWILIO_ACCOUNT_SID/DEFAULT_TWILIO_AUTH_TOKEN, or provide this client's own accountSid/authToken)",
    };
  }
  return {
    creds: { fromNumber: creds.fromNumber, accountSid: defaults.twilioAccountSid, authToken: defaults.twilioAuthToken },
  };
}

function resolveSendGridChannel(
  creds: PartialSendGrid,
  defaults: ReturnType<typeof getChannelDefaults>
): { creds?: SendGridCredentials; error?: string } {
  if (!creds.fromEmail) {
    return { error: "channels.email.fromEmail is required" };
  }
  if (creds.apiKey) {
    return { creds: creds as SendGridCredentials };
  }
  if (!defaults.sendgridApiKey) {
    return {
      error:
        "channels.email.fromEmail was given but no apiKey, and no default SendGrid account is configured " +
        "(set DEFAULT_SENDGRID_API_KEY, or provide this client's own apiKey)",
    };
  }
  return { creds: { ...creds, fromEmail: creds.fromEmail, apiKey: defaults.sendgridApiKey } };
}

/**
 * Fills in the shared agency-wide Twilio/SendGrid credentials (see above)
 * for any channel the caller specified only the per-client piece for.
 * Returns an error message instead of throwing — this runs inside a route
 * handler that turns it into a 400, the same way the rest of tenant
 * validation in src/routes/tenants.ts works.
 */
export function resolveChannelDefaults(channels: Partial<ChannelCredentials> | undefined): {
  channels: ChannelCredentials;
  error?: string;
} {
  if (!channels) return { channels: {} };
  const defaults = getChannelDefaults();
  const resolved: ChannelCredentials = {};

  if (channels.sms) {
    const { creds, error } = resolveTwilioChannel("sms", channels.sms, defaults);
    if (error) return { channels: {}, error };
    resolved.sms = creds;
  }
  if (channels.whatsapp) {
    const { creds, error } = resolveTwilioChannel("whatsapp", channels.whatsapp, defaults);
    if (error) return { channels: {}, error };
    resolved.whatsapp = creds;
  }
  if (channels.email) {
    const { creds, error } = resolveSendGridChannel(channels.email, defaults);
    if (error) return { channels: {}, error };
    resolved.email = creds;
  }

  return { channels: resolved };
}
