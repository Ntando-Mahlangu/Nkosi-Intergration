import { test, expect } from "@playwright/test";

// The embeddable chat widget (public/chat-widget.js) is meant to run on an
// arbitrary third-party website, not one of LeadRecovery's own dashboards —
// this spec renders a throwaway host page (standing in for a client's real
// site) and drives the real widget against the real server, the same way an
// actual website visitor would.

const ADMIN_KEY = "e2e-test-admin-key";

async function createChatTenant(page: import("@playwright/test").Page) {
  const name = `Chat Widget Test ${Date.now()}-${Math.floor(Math.random() * 10_000)}`;
  // Deliberately no knowledgeBase/autoReplyEnabled: generateAutoReply then
  // always resolves to {action: "disabled"} without ever calling the real
  // Anthropic API, so this spec stays fully deterministic and network-free,
  // the same as the unit suite's mocked equivalents — it asserts on the
  // fixed ESCALATION_NOTICE hand-off text instead of a model-generated one.
  const created = await page.request.post("/admin/tenants", {
    headers: { Authorization: `Bearer ${ADMIN_KEY}` },
    data: {
      name,
      timezone: "UTC",
      devMode: true,
      consentBasisConfirmed: true,
      termsAttested: true,
    },
  });
  expect(created.ok()).toBe(true);
  const tenant = await created.json();

  // The chat widget refuses to answer until the tenant has accepted its own
  // Terms of Service (the real client-facing gate, distinct from the admin's
  // termsAttested above) — see src/routes/publicChat.ts.
  const versionRes = await page.request.get("/terms-version");
  const { version } = await versionRes.json();
  await page.request.post("/tenants/me/accept-terms", {
    headers: { Authorization: `Bearer ${tenant.apiKey}` },
    data: { version },
  });

  return tenant as { id: string; apiKey: string; publicFormKey: string };
}

async function renderHostPage(page: import("@playwright/test").Page, tenant: { id: string; publicFormKey: string }) {
  // A real client's site, on its own origin — the widget's own CORS
  // allowance (Access-Control-Allow-Origin: *) is exactly what makes this
  // work from a different origin than the LeadRecovery server itself.
  await page.goto("/health");
  await page.setContent(
    `<!doctype html><html><head></head><body>
      <h1>Example Plumbing Co</h1>
      <script src="${new URL("/chat-widget.js", page.url()).toString()}" data-tenant="${tenant.id}" data-form-key="${tenant.publicFormKey}"></script>
    </body></html>`
  );
}

const ESCALATION_NOTICE = "Thanks for reaching out — one of our team will follow up with you shortly.";

test.describe("Website chat widget (public/chat-widget.js)", () => {
  test("a visitor can open the widget, chat, and the real classify/escalate pipeline runs end to end", async ({
    page,
  }) => {
    const tenant = await createChatTenant(page);
    await renderHostPage(page, tenant);

    await expect(page.locator("#leadrecovery-chat-widget .lrcw-button")).toBeVisible();
    await page.click("#leadrecovery-chat-widget .lrcw-button");
    await expect(page.locator("#leadrecovery-chat-widget .lrcw-panel")).toHaveClass(/lrcw-open/);

    // Pre-chat form: start without giving any contact info — an anonymous visitor can still chat.
    await page.click("#leadrecovery-chat-widget .lrcw-send");
    await expect(page.locator("#leadrecovery-chat-widget .lrcw-input")).toBeVisible();

    await page.fill("#leadrecovery-chat-widget .lrcw-input", "what are your hours?");
    await page.click("#leadrecovery-chat-widget .lrcw-send");

    await expect(page.locator("#leadrecovery-chat-widget .lrcw-bubble.lrcw-inbound")).toHaveText(
      "what are your hours?"
    );
    // No knowledge base configured on this tenant, so the real pipeline
    // (src/chatWidget.ts) resolves to "escalate" rather than fabricating an
    // answer — exactly the behavior this asserts on.
    await expect(page.locator("#leadrecovery-chat-widget .lrcw-bubble.lrcw-outbound")).toHaveText(ESCALATION_NOTICE);
  });

  test("resuming after a reload shows the prior conversation instead of starting over", async ({ page }) => {
    const tenant = await createChatTenant(page);
    await renderHostPage(page, tenant);

    await page.click("#leadrecovery-chat-widget .lrcw-button");
    await page.click("#leadrecovery-chat-widget .lrcw-send"); // start, no contact info
    await page.fill("#leadrecovery-chat-widget .lrcw-input", "what are your hours?");
    await page.click("#leadrecovery-chat-widget .lrcw-send");
    await expect(page.locator("#leadrecovery-chat-widget .lrcw-bubble.lrcw-outbound")).toHaveText(ESCALATION_NOTICE);

    // Re-render the host page fresh (simulates a reload) — localStorage
    // persists since we stayed on the same origin.
    await renderHostPage(page, tenant);
    await page.click("#leadrecovery-chat-widget .lrcw-button");

    await expect(page.locator("#leadrecovery-chat-widget .lrcw-bubble.lrcw-inbound")).toHaveText(
      "what are your hours?"
    );
    await expect(page.locator("#leadrecovery-chat-widget .lrcw-input")).toBeVisible(); // straight to the message box, no pre-chat form again
  });
});
