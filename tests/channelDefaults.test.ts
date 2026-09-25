import { afterEach, describe, expect, it } from "vitest";
import { resolveChannelDefaults } from "../src/channelDefaults.js";

describe("resolveChannelDefaults", () => {
  const originalEnv = {
    sid: process.env.DEFAULT_TWILIO_ACCOUNT_SID,
    token: process.env.DEFAULT_TWILIO_AUTH_TOKEN,
    key: process.env.DEFAULT_SENDGRID_API_KEY,
  };

  afterEach(() => {
    if (originalEnv.sid === undefined) delete process.env.DEFAULT_TWILIO_ACCOUNT_SID;
    else process.env.DEFAULT_TWILIO_ACCOUNT_SID = originalEnv.sid;
    if (originalEnv.token === undefined) delete process.env.DEFAULT_TWILIO_AUTH_TOKEN;
    else process.env.DEFAULT_TWILIO_AUTH_TOKEN = originalEnv.token;
    if (originalEnv.key === undefined) delete process.env.DEFAULT_SENDGRID_API_KEY;
    else process.env.DEFAULT_SENDGRID_API_KEY = originalEnv.key;
  });

  it("passes through empty/undefined channels untouched", () => {
    expect(resolveChannelDefaults(undefined)).toEqual({ channels: {} });
    expect(resolveChannelDefaults({})).toEqual({ channels: {} });
  });

  it("fills in the shared Twilio account when only fromNumber is given", () => {
    process.env.DEFAULT_TWILIO_ACCOUNT_SID = "AC_shared";
    process.env.DEFAULT_TWILIO_AUTH_TOKEN = "shared-token";

    const { channels, error } = resolveChannelDefaults({ sms: { fromNumber: "+15551234567" } as never });
    expect(error).toBeUndefined();
    expect(channels.sms).toEqual({ fromNumber: "+15551234567", accountSid: "AC_shared", authToken: "shared-token" });
  });

  it("leaves a channel with its own full credentials untouched (a client bringing their own account)", () => {
    process.env.DEFAULT_TWILIO_ACCOUNT_SID = "AC_shared";
    process.env.DEFAULT_TWILIO_AUTH_TOKEN = "shared-token";

    const { channels } = resolveChannelDefaults({
      sms: { fromNumber: "+15551234567", accountSid: "AC_own", authToken: "own-token" },
    });
    expect(channels.sms).toEqual({ fromNumber: "+15551234567", accountSid: "AC_own", authToken: "own-token" });
  });

  it("errors when fromNumber is given but no default is configured and no override was provided", () => {
    delete process.env.DEFAULT_TWILIO_ACCOUNT_SID;
    delete process.env.DEFAULT_TWILIO_AUTH_TOKEN;

    const { error } = resolveChannelDefaults({ sms: { fromNumber: "+15551234567" } as never });
    expect(error).toMatch(/no default Twilio account is configured/);
  });

  it("errors on a partially-specified override (accountSid without authToken)", () => {
    process.env.DEFAULT_TWILIO_ACCOUNT_SID = "AC_shared";
    process.env.DEFAULT_TWILIO_AUTH_TOKEN = "shared-token";

    const { error } = resolveChannelDefaults({
      sms: { fromNumber: "+15551234567", accountSid: "AC_own" } as never,
    });
    expect(error).toMatch(/must include both accountSid and authToken, or neither/);
  });

  it("errors when a Twilio channel is given with no fromNumber at all", () => {
    const { error } = resolveChannelDefaults({ sms: { accountSid: "AC1", authToken: "tok" } as never });
    expect(error).toMatch(/fromNumber is required/);
  });

  it("fills in the shared SendGrid API key when only fromEmail is given", () => {
    process.env.DEFAULT_SENDGRID_API_KEY = "SG.shared";

    const { channels, error } = resolveChannelDefaults({ email: { fromEmail: "hello@acme.com" } as never });
    expect(error).toBeUndefined();
    expect(channels.email).toEqual({ fromEmail: "hello@acme.com", apiKey: "SG.shared" });
  });

  it("leaves an email channel with its own apiKey untouched", () => {
    process.env.DEFAULT_SENDGRID_API_KEY = "SG.shared";

    const { channels } = resolveChannelDefaults({ email: { fromEmail: "hello@acme.com", apiKey: "SG.own" } });
    expect(channels.email).toEqual({ fromEmail: "hello@acme.com", apiKey: "SG.own" });
  });

  it("errors when fromEmail is given but no SendGrid default is configured", () => {
    delete process.env.DEFAULT_SENDGRID_API_KEY;

    const { error } = resolveChannelDefaults({ email: { fromEmail: "hello@acme.com" } as never });
    expect(error).toMatch(/no default SendGrid account is configured/);
  });

  it("errors when an email channel is given with no fromEmail at all", () => {
    const { error } = resolveChannelDefaults({ email: { apiKey: "SG1" } as never });
    expect(error).toMatch(/fromEmail is required/);
  });

  it("resolves sms, whatsapp, and email independently in one call", () => {
    process.env.DEFAULT_TWILIO_ACCOUNT_SID = "AC_shared";
    process.env.DEFAULT_TWILIO_AUTH_TOKEN = "shared-token";
    process.env.DEFAULT_SENDGRID_API_KEY = "SG.shared";

    const { channels, error } = resolveChannelDefaults({
      sms: { fromNumber: "+15551110000" } as never,
      whatsapp: { fromNumber: "+15551110000" } as never,
      email: { fromEmail: "hello@acme.com" } as never,
    });
    expect(error).toBeUndefined();
    expect(channels.sms?.accountSid).toBe("AC_shared");
    expect(channels.whatsapp?.accountSid).toBe("AC_shared");
    expect(channels.email?.apiKey).toBe("SG.shared");
  });
});
