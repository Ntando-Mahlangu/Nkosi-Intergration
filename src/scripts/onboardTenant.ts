import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { readFileSync } from "node:fs";
import { createStores } from "../store/index.js";
import { generateApiKey, generateId } from "../idgen.js";
import type { Tenant } from "../types.js";

async function ask(rl: ReturnType<typeof createInterface>, question: string, fallback = ""): Promise<string> {
  const answer = await rl.question(question);
  return answer.trim() || fallback;
}

async function main() {
  const rl = createInterface({ input: stdin, output: stdout });

  try {
    console.log("=== LeadRecovery tenant onboarding ===\n");

    const name = await ask(rl, "Business name: ");
    if (!name) throw new Error("Business name is required.");

    const timezone = await ask(rl, "IANA timezone [Africa/Johannesburg]: ", "Africa/Johannesburg");
    const quietStartRaw = await ask(rl, "Quiet hours start, local 24h hour [20]: ", "20");
    const quietEndRaw = await ask(rl, "Quiet hours end, local 24h hour [8]: ", "8");

    const twilioSid = await ask(rl, "Twilio Account SID (blank to skip SMS/WhatsApp): ");
    let sms: Tenant["channels"]["sms"];
    let whatsapp: Tenant["channels"]["whatsapp"];
    if (twilioSid) {
      const authToken = await ask(rl, "Twilio Auth Token: ");
      const smsFrom = await ask(rl, "Twilio SMS from-number, E.164 (blank to skip SMS): ");
      const waFrom = await ask(rl, "Twilio WhatsApp from-number, E.164 (blank to skip WhatsApp): ");
      if (smsFrom) sms = { accountSid: twilioSid, authToken, fromNumber: smsFrom };
      if (waFrom) whatsapp = { accountSid: twilioSid, authToken, fromNumber: waFrom };
    }

    const sendgridKey = await ask(rl, "SendGrid API key (blank to skip email): ");
    let email: Tenant["channels"]["email"];
    if (sendgridKey) {
      const fromEmail = await ask(rl, "SendGrid from-email: ");
      const fromName = await ask(rl, "SendGrid from-name (optional): ");
      email = { apiKey: sendgridKey, fromEmail, fromName: fromName || undefined };
    }

    const knowledgeBasePath = await ask(
      rl,
      "Path to a knowledge-base text file for the FAQ auto-reply chatbot (blank to skip / set up later): "
    );
    let knowledgeBase: string | undefined;
    let autoReplyEnabled = false;
    if (knowledgeBasePath) {
      knowledgeBase = readFileSync(knowledgeBasePath, "utf-8");
      const enable = await ask(rl, "Enable automated replies to customer questions using this knowledge base now? [y/N]: ");
      autoReplyEnabled = /^y(es)?$/i.test(enable);
    }

    const tenant: Tenant = {
      id: generateId("tenant"),
      name,
      apiKey: generateApiKey(),
      timezone,
      quietHours: { startHour: Number(quietStartRaw), endHour: Number(quietEndRaw) },
      devMode: false,
      channels: { sms, whatsapp, email },
      knowledgeBase,
      autoReplyEnabled,
      createdAt: new Date().toISOString(),
    };

    if (!process.env.DATABASE_URL) {
      console.warn(
        "\nDATABASE_URL is not set — this tenant will NOT be persisted anywhere. " +
          "Set DATABASE_URL and re-run this command to actually save it.\n"
      );
    }

    const stores = createStores();
    const created = await stores.tenantStore.createTenant(tenant);

    console.log("\nTenant created:");
    console.log(`  id:       ${created.id}`);
    console.log(`  name:     ${created.name}`);
    console.log(`  API key:  ${created.apiKey}   <-- save this now, it is only shown here`);
    console.log(`  timezone: ${created.timezone}`);
    console.log(
      `  channels: sms=${Boolean(created.channels.sms)} whatsapp=${Boolean(
        created.channels.whatsapp
      )} email=${Boolean(created.channels.email)}`
    );
    console.log(
      `  auto-reply: ${created.autoReplyEnabled ? "ON" : "off"}${created.knowledgeBase ? " (knowledge base set)" : ""}`
    );

    console.log("\nWebhook URLs to configure with providers (replace <host> with your deployed API host):");
    console.log(`  Twilio SMS inbound:      https://<host>/webhooks/${created.id}/twilio/sms`);
    console.log(`  Twilio voice status:     https://<host>/webhooks/${created.id}/twilio/voice-status`);
    console.log(`  SendGrid inbound parse:  https://<host>/webhooks/${created.id}/sendgrid/email?token=${created.apiKey}`);
    console.log(`  Generic lead intake:     https://<host>/webhooks/lead  (Authorization: Bearer ${created.apiKey})`);
  } finally {
    rl.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
