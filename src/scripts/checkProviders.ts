import twilio from "twilio";
import Anthropic from "@anthropic-ai/sdk";
import { createStores } from "../store/index.js";
import type { TwilioCredentials } from "../types.js";

function parseArgs(argv: string[]): { tenantId?: string } {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith("--")) {
      out[argv[i].slice(2)] = argv[i + 1];
      i++;
    }
  }
  return { tenantId: out.tenant };
}

interface CheckResult {
  label: string;
  ok: boolean;
  detail: string;
}

/** A real, lightweight, read-only call per provider — enough to confirm the credential actually authenticates, without sending anything to a real customer. */
async function checkTwilio(label: string, creds: TwilioCredentials): Promise<CheckResult> {
  try {
    const client = twilio(creds.accountSid, creds.authToken);
    const account = await client.api.accounts(creds.accountSid).fetch();
    return { label, ok: true, detail: `authenticated OK (account status: ${account.status})` };
  } catch (err) {
    return { label, ok: false, detail: (err as Error).message };
  }
}

async function checkSendGrid(apiKey: string): Promise<CheckResult> {
  const label = "SendGrid (email)";
  try {
    const res = await fetch("https://api.sendgrid.com/v3/scopes", {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    if (!res.ok) return { label, ok: false, detail: `API responded ${res.status} — key is invalid or revoked` };
    const body = (await res.json()) as { scopes: string[] };
    const hasMailSend = body.scopes.includes("mail.send");
    return {
      label,
      ok: hasMailSend,
      detail: hasMailSend
        ? `authenticated OK (${body.scopes.length} scope(s) granted, including mail.send)`
        : "authenticated OK, but this key is missing the mail.send scope — sends will fail",
    };
  } catch (err) {
    return { label, ok: false, detail: (err as Error).message };
  }
}

async function checkAnthropic(apiKey: string): Promise<CheckResult> {
  const label = "Anthropic (chatbot auto-reply / LLM reply classification)";
  try {
    const client = new Anthropic({ apiKey });
    await client.models.list(); // lightweight metadata call, no token cost
    return { label, ok: true, detail: "authenticated OK" };
  } catch (err) {
    return { label, ok: false, detail: (err as Error).message };
  }
}

/**
 * Makes a real, lightweight, authenticated call to every provider a tenant
 * has credentials configured for (Twilio SMS/WhatsApp, SendGrid, and
 * Anthropic if the chatbot or LLM classification is enabled), to catch a
 * bad/revoked/misscoped credential before it fails silently on a real
 * customer's first message. Run this after onboarding a tenant and before
 * flipping it live — see ONBOARDING.md step 6 (Pilot).
 */
async function main() {
  const { tenantId } = parseArgs(process.argv.slice(2));
  if (!tenantId) {
    console.error("Usage: npm run check-providers -- --tenant <tenantId>");
    process.exitCode = 1;
    return;
  }

  const stores = createStores();
  const tenant = await stores.tenantStore.getTenant(tenantId);
  if (!tenant) {
    console.error(`No such tenant: ${tenantId}`);
    process.exitCode = 1;
    return;
  }

  console.log(`Checking provider credentials for tenant "${tenant.name}" (${tenant.id})...\n`);

  const checks: Promise<CheckResult>[] = [];
  if (tenant.channels.sms) checks.push(checkTwilio("Twilio (SMS)", tenant.channels.sms));
  if (tenant.channels.whatsapp) checks.push(checkTwilio("Twilio (WhatsApp)", tenant.channels.whatsapp));
  if (tenant.channels.email) checks.push(checkSendGrid(tenant.channels.email.apiKey));
  const needsAnthropic = tenant.autoReplyEnabled || process.env.LEADRECOVERY_USE_LLM_CLASSIFICATION === "true";
  if (needsAnthropic && process.env.ANTHROPIC_API_KEY) {
    checks.push(checkAnthropic(process.env.ANTHROPIC_API_KEY));
  }

  if (checks.length === 0) {
    console.log("Nothing to check — this tenant has no real provider credentials configured (devMode-only setup).");
    return;
  }

  const results = await Promise.all(checks);
  for (const r of results) {
    console.log(`${r.ok ? "✓" : "✗"} ${r.label}: ${r.detail}`);
  }

  if (needsAnthropic && !process.env.ANTHROPIC_API_KEY) {
    console.log("✗ Anthropic: chatbot/LLM classification is enabled but ANTHROPIC_API_KEY is not set in this environment.");
  }

  if (results.some((r) => !r.ok)) {
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
