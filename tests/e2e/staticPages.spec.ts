import { test, expect } from "@playwright/test";

// The pre-login marketing/legal/standalone-auth pages — get-started.html,
// terms.html, privacy.html, and reset-password.html — had no e2e coverage
// at all before this spec (unlike the four sidebar dashboards and
// admin.html). They're simpler (no app-shell, no sidebar), but still real
// pages hitting real endpoints (POST /inquiries, POST /auth/forgot-password,
// POST /auth/reset-password), so this covers their actual render + submit
// paths rather than just trusting a screenshot taken once during the
// redesign.

test.describe("Get started (public/get-started.html)", () => {
  test("renders the hero and links to terms/privacy", async ({ page }) => {
    await page.goto("/get-started.html");
    await expect(page.locator("h1")).toContainText("Never lose another");
    await expect(page.locator('a[href="terms.html"]').first()).toBeVisible();
    await expect(page.locator('a[href="privacy.html"]').first()).toBeVisible();

    await page.click('nav a[href="terms.html"]');
    await expect(page).toHaveURL(/terms\.html$/);
  });

  test("rejects an inquiry with no business name", async ({ page }) => {
    await page.goto("/get-started.html");
    await page.fill("#email", "jane@example.com");
    await page.click("#submit-btn");
    await expect(page.locator("#form-error")).toHaveText("Business name is required.");
  });

  test("rejects an inquiry with neither phone nor email", async ({ page }) => {
    await page.goto("/get-started.html");
    await page.fill("#business-name", "Acme Plumbing");
    await page.click("#submit-btn");
    await expect(page.locator("#form-error")).toHaveText("Phone or email is required, so we can get back to you.");
  });

  test("submits a real inquiry to POST /inquiries and shows the success state", async ({ page }) => {
    await page.goto("/get-started.html");
    await page.fill("#business-name", `Acme Plumbing ${Date.now()}`);
    await page.fill("#contact-name", "Jane Smith");
    await page.fill("#email", "jane@example.com");
    await page.click("#submit-btn");

    await expect(page.locator("#form-success")).toBeVisible();
    await expect(page.locator("#form-success")).toContainText("Thanks — we'll be in touch.");
    await expect(page.locator("#form-state")).toBeHidden();
  });
});

test.describe("Terms of Service (public/terms.html)", () => {
  test("renders and links back to Get Started and to Privacy", async ({ page }) => {
    await page.goto("/terms.html");
    await expect(page.locator("h1")).toHaveText("Terms of Service");
    await expect(page.locator(".back-link")).toHaveAttribute("href", "get-started.html");
    await expect(page.locator('nav a[href="privacy.html"]')).toBeVisible();
  });
});

test.describe("Privacy Policy (public/privacy.html)", () => {
  test("renders and links back to Get Started and to Terms", async ({ page }) => {
    await page.goto("/privacy.html");
    await expect(page.locator("h1")).toHaveText("Privacy Policy");
    await expect(page.locator(".back-link")).toHaveAttribute("href", "get-started.html");
    await expect(page.locator('nav a[href="terms.html"]')).toBeVisible();
  });
});

test.describe("Reset password (public/reset-password.html)", () => {
  test("requesting a reset link always shows the same generic success message", async ({ page }) => {
    await page.goto("/reset-password.html");
    await expect(page.locator("#request-panel")).toBeVisible();
    await expect(page.locator("#reset-panel")).toBeHidden();

    await page.fill("#email", `nobody-${Date.now()}@example.com`);
    await page.click("#request-btn");

    await expect(page.locator("#request-ok")).toHaveText("If that email has an account, a reset link has been sent.");
  });

  test("requesting with no email shows a client-side error without calling the server", async ({ page }) => {
    await page.goto("/reset-password.html");
    await page.click("#request-btn");
    await expect(page.locator("#request-error")).toHaveText("Email is required.");
  });

  test("?token= switches to the set-new-password panel", async ({ page }) => {
    await page.goto("/reset-password.html?token=whatever-token-value");
    await expect(page.locator("#request-panel")).toBeHidden();
    await expect(page.locator("#reset-panel")).toBeVisible();
    await expect(page.locator("#base-url-2")).not.toHaveValue("");
  });

  test("the reset panel validates password length and match client-side before calling the server", async ({
    page,
  }) => {
    await page.goto("/reset-password.html?token=whatever-token-value");

    await page.fill("#new-password", "short");
    await page.fill("#confirm-password", "short");
    await page.click("#reset-btn");
    await expect(page.locator("#reset-error")).toHaveText("Password must be at least 8 characters.");

    await page.fill("#new-password", "longenough1");
    await page.fill("#confirm-password", "longenough2");
    await page.click("#reset-btn");
    await expect(page.locator("#reset-error")).toHaveText("Passwords don't match.");
  });

  test("an invalid/expired token is rejected by the real server with a clear error", async ({ page }) => {
    // Exercising the real POST /auth/reset-password here (not a client-side
    // check) — there's no way to mint a genuinely valid token from outside
    // the server process in an e2e test (it's only ever handed out via a
    // real account email, see src/routes/auth.ts's issuePasswordResetToken),
    // so the one server round trip this page's happy path can realistically
    // get here is "the server correctly rejects a bogus one".
    await page.goto("/reset-password.html?token=definitely-not-a-real-token");
    await page.fill("#new-password", "longenough1");
    await page.fill("#confirm-password", "longenough1");
    await page.click("#reset-btn");

    await expect(page.locator("#reset-error")).toContainText("Could not reset password");
  });
});
