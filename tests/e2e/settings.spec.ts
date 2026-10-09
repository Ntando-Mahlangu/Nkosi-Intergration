import { test, expect } from "@playwright/test";

// public/settings.html lets a tenant edit their own outbound message
// templates — the self-service UI for what was previously API-only
// (PATCH /tenants/me). All tests here run serially against the same demo
// tenant (no per-test tenant creation, unlike admin.spec.ts) and each
// leaves the tenant's templates back in a known-blank state, so a local
// re-run (reuseExistingServer) starts from the same place a CI run does.

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
}

test.describe("Settings (public/settings.html)", () => {
  test("starts from a known-clean state: blank templates", async ({ page }) => {
    await connect(page);
    await resetToBlank(page);

    await page.reload();
    await expect(page.locator("#app")).toBeVisible();
    await expect(page.locator("#tpl-grounded")).toHaveValue("");
    await expect(page.locator("#tpl-ungrounded")).toHaveValue("");
    await expect(page.locator("#tpl-fu-0")).toHaveValue("");
    await expect(page.locator("#tpl-closer")).toHaveValue("");
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

  test('"Reset wording to defaults" clears custom templates without touching other settings', async ({ page }) => {
    await connect(page);
    // Set a known, unrelated field first (the previous test may have changed it).
    await page.fill("#data-retention-days", "90");
    await page.click("#save-btn");
    await expect(page.locator("#save-status")).toHaveText("Saved.");

    page.once("dialog", (d) => d.accept());
    await page.click("#reset-btn");
    await expect(page.locator("#save-status")).toHaveText("Reset to defaults.");

    await expect(page.locator("#tpl-grounded")).toHaveValue("");
    await expect(page.locator("#tpl-fu-0")).toHaveValue("");
    // The unrelated field is untouched by a wording reset.
    await expect(page.locator("#data-retention-days")).toHaveValue("90");

    // Leave the tenant blank for any later run of this suite.
    await resetToBlank(page);
  });

  test("data-retention-days round-trips and validates its range", async ({ page }) => {
    await connect(page);

    await page.fill("#data-retention-days", "90");
    await page.click("#save-btn");
    await expect(page.locator("#save-status")).toHaveText("Saved.");

    await page.reload();
    await expect(page.locator("#app")).toBeVisible();
    await expect(page.locator("#data-retention-days")).toHaveValue("90");

    await page.fill("#data-retention-days", "5"); // below the 30-day floor
    await page.click("#save-btn");
    await expect(page.locator("#save-status")).toContainText("30 to 3650");

    // There's no "clear" for dataRetentionDays once set (an empty field
    // just leaves the last saved value in place, same as any other field
    // this form doesn't submit when blank) — 90 days lingering on the demo
    // tenant doesn't affect anything else in this suite. Still need to fix
    // up the field's current value (left at "5" by the validation check
    // above) so this save doesn't fail the same check.
    await page.fill("#data-retention-days", "90");
    await page.click("#save-btn");
    await expect(page.locator("#save-status")).toHaveText("Saved.");
  });

  test("win-back enabled/cooldown/template round-trip, and the cooldown validates its range", async ({ page }) => {
    await connect(page);
    await expect(page.locator("#win-back-enabled")).not.toBeChecked();

    await page.check("#win-back-enabled");
    await page.fill("#win-back-cooldown-days", "90");
    await page.fill("#tpl-winback", "Hi {name}, miss you at {businessName}!");
    await page.click("#save-btn");
    await expect(page.locator("#save-status")).toHaveText("Saved.");

    await page.reload();
    await expect(page.locator("#app")).toBeVisible();
    await expect(page.locator("#win-back-enabled")).toBeChecked();
    await expect(page.locator("#win-back-cooldown-days")).toHaveValue("90");
    await expect(page.locator("#tpl-winback")).toHaveValue("Hi {name}, miss you at {businessName}!");

    await page.fill("#win-back-cooldown-days", "5"); // below the 30-day floor
    await page.click("#save-btn");
    await expect(page.locator("#save-status")).toContainText("30 to 3650");

    // Reset for any later run of this suite — same reasoning as the
    // data-retention test above.
    await page.fill("#win-back-cooldown-days", "90");
    await page.uncheck("#win-back-enabled");
    await page.click("#save-btn");
    await expect(page.locator("#save-status")).toHaveText("Saved.");
  });

  test("attention-SLA hours round-trips, validates its range, and clears on a blank save", async ({ page }) => {
    await connect(page);
    await expect(page.locator("#attention-sla-hours")).toHaveValue("");

    await page.fill("#attention-sla-hours", "12");
    await page.click("#save-btn");
    await expect(page.locator("#save-status")).toHaveText("Saved.");

    await page.reload();
    await expect(page.locator("#app")).toBeVisible();
    await expect(page.locator("#attention-sla-hours")).toHaveValue("12");

    await page.fill("#attention-sla-hours", "1000"); // above the 720-hour ceiling
    await page.click("#save-btn");
    await expect(page.locator("#save-status")).toContainText("1 to 720");

    // Clearing the field (rather than a syntactically invalid value) is how
    // this gets disabled — confirm a blank save round-trips back to blank.
    await page.fill("#attention-sla-hours", "");
    await page.click("#save-btn");
    await expect(page.locator("#save-status")).toHaveText("Saved.");
    await page.reload();
    await expect(page.locator("#app")).toBeVisible();
    await expect(page.locator("#attention-sla-hours")).toHaveValue("");
  });

  test("Team: invites a member, changes their role, then removes them", async ({ page }) => {
    await connect(page);
    const email = `e2e-team-${Date.now()}@example.com`;

    await page.fill("#team-invite-email", email);
    await page.selectOption("#team-invite-role", "member");
    await page.click("#team-invite-btn");
    await expect(page.locator("#team-status")).toContainText("Invited");

    const row = page.locator(".team-row", { hasText: email });
    await expect(row).toBeVisible();
    await expect(row.locator(".team-role-select")).toHaveValue("member");

    await row.locator(".team-role-select").selectOption("owner");
    await expect(page.locator("#team-status")).toHaveText("Saved.");
    await page.reload();
    await expect(page.locator("#app")).toBeVisible();
    await expect(page.locator(".team-row", { hasText: email }).locator(".team-role-select")).toHaveValue("owner");

    await page.locator(".team-row", { hasText: email }).locator(".team-remove-btn").click();
    await expect(page.locator("#team-status")).toHaveText("Removed.");
    await expect(page.locator(".team-row", { hasText: email })).toHaveCount(0);
  });
});
