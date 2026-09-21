import { test, expect } from "@playwright/test";

// public/settings.html lets a tenant edit their own outbound message
// templates and the auto-reply chatbot's knowledge base — the self-service
// UI for what was previously API-only (PATCH /tenants/me). All tests here
// run serially against the same demo tenant (no per-test tenant creation,
// unlike admin.spec.ts) and each leaves the tenant's templates/knowledge
// base back in a known-blank state, so a local re-run (reuseExistingServer)
// starts from the same place a CI run does.

test.describe.configure({ mode: "serial" });

async function connect(page: import("@playwright/test").Page) {
  await page.goto("/settings.html");
  await page.click("#demo-btn");
  await expect(page.locator("#app")).toBeVisible();
}

async function resetToBlank(page: import("@playwright/test").Page) {
  page.once("dialog", (d) => d.accept());
  await page.click("#reset-btn");
  await expect(page.locator("#save-status")).toHaveText("Reset to defaults.");
  await page.fill("#knowledge-base", "");
  await page.click("#save-btn");
  await expect(page.locator("#save-status")).toHaveText("Saved.");
}

test.describe("Settings (public/settings.html)", () => {
  test("starts from a known-clean state: blank templates, empty knowledge base", async ({ page }) => {
    await connect(page);
    await resetToBlank(page);

    await page.reload();
    await expect(page.locator("#app")).toBeVisible();
    await expect(page.locator("#tpl-grounded")).toHaveValue("");
    await expect(page.locator("#tpl-ungrounded")).toHaveValue("");
    await expect(page.locator("#tpl-fu-0")).toHaveValue("");
    await expect(page.locator("#tpl-closer")).toHaveValue("");
    await expect(page.locator("#knowledge-base")).toHaveValue("");
    await expect(page.locator("#auto-reply-enabled")).not.toBeChecked();
    await expect(page.locator("#auto-reply-enabled")).toBeDisabled();
  });

  test("saves a custom first-message template and it survives a reload", async ({ page }) => {
    await connect(page);

    const message = "Hi {name}, it's {businessName} following up on {reason}. Reply STOP to opt out.";
    await page.fill("#tpl-grounded", message);
    await page.click("#save-btn");
    await expect(page.locator("#save-status")).toHaveText("Saved.");

    await page.reload();
    await expect(page.locator("#app")).toBeVisible();
    await expect(page.locator("#tpl-grounded")).toHaveValue(message);
  });

  test("refuses to save a partially-filled follow-up sequence", async ({ page }) => {
    await connect(page);

    await page.fill("#tpl-fu-0", "Just checking in, {name}.");
    // tpl-fu-1 and tpl-fu-2 deliberately left blank.
    await page.click("#save-btn");

    await expect(page.locator("#save-status")).toHaveText(
      "Fill in all three follow-ups, or leave all three blank to use the defaults."
    );
    await expect(page.locator("#save-status")).toHaveClass(/err/);

    // Confirm it actually refused the request, not just showed a message
    // after a failed round trip — reload should show it was never sent.
    await page.reload();
    await expect(page.locator("#app")).toBeVisible();
    await expect(page.locator("#tpl-fu-0")).toHaveValue("");
  });

  test("saving all three follow-ups succeeds", async ({ page }) => {
    await connect(page);

    await page.fill("#tpl-fu-0", "Following up, {name}.");
    await page.fill("#tpl-fu-1", "Still here if you need us.");
    await page.fill("#tpl-fu-2", "Last check-in — reply STOP anytime.");
    await page.click("#save-btn");

    await expect(page.locator("#save-status")).toHaveText("Saved.");
  });

  test("the auto-reply checkbox is disabled until the knowledge base has content, mirroring the server's own rule", async ({
    page,
  }) => {
    await connect(page);

    const checkbox = page.locator("#auto-reply-enabled");
    await expect(checkbox).toBeDisabled();

    await page.fill("#knowledge-base", "We're open 9-5 Mon-Fri. Pricing starts at $99.");
    await expect(checkbox).toBeEnabled();

    await checkbox.check();
    await page.click("#save-btn");
    await expect(page.locator("#save-status")).toHaveText("Saved.");

    await page.reload();
    await expect(page.locator("#app")).toBeVisible();
    await expect(page.locator("#knowledge-base")).toHaveValue("We're open 9-5 Mon-Fri. Pricing starts at $99.");
    await expect(checkbox).toBeChecked();

    // Clearing the knowledge base client-side immediately un-checks and
    // disables it too — a server round trip shouldn't be needed to catch this.
    await page.fill("#knowledge-base", "");
    await expect(checkbox).not.toBeChecked();
    await expect(checkbox).toBeDisabled();
  });

  test('"Reset wording to defaults" clears custom templates without touching the knowledge base', async ({ page }) => {
    await connect(page);
    // Restore a known knowledge base first (the previous test cleared it).
    await page.fill("#knowledge-base", "We're open 9-5 Mon-Fri.");
    await page.click("#save-btn");
    await expect(page.locator("#save-status")).toHaveText("Saved.");

    page.once("dialog", (d) => d.accept());
    await page.click("#reset-btn");
    await expect(page.locator("#save-status")).toHaveText("Reset to defaults.");

    await expect(page.locator("#tpl-grounded")).toHaveValue("");
    await expect(page.locator("#tpl-fu-0")).toHaveValue("");
    // Knowledge base is untouched by a wording reset.
    await expect(page.locator("#knowledge-base")).toHaveValue("We're open 9-5 Mon-Fri.");

    // Leave the tenant blank for any later run of this suite.
    await resetToBlank(page);
  });
});
