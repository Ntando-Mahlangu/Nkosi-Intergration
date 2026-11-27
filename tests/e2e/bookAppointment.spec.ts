import { test, expect } from "@playwright/test";

// public/book-appointment.html — the self-serve booking page a lead gets
// linked to (see dashboard.html's "Copy self-serve booking link"). Backed
// by the real, unauthenticated GET/POST /public/appointments/:tenantId/:leadId
// (src/routes/publicBooking.ts). Each test creates its own tenant+lead via
// the admin/tenant APIs rather than sharing the demo tenant's leads, so
// tests can run in any order/in parallel without racing on the same lead's
// appointment state.

const ADMIN_KEY = "e2e-test-admin-key";

async function createTenantWithLead(page: import("@playwright/test").Page) {
  const name = `Booking Test ${Date.now()}-${Math.floor(Math.random() * 10_000)}`;
  const created = await page.request.post("/admin/tenants", {
    headers: { Authorization: `Bearer ${ADMIN_KEY}` },
    data: { name, timezone: "UTC", devMode: true, consentBasisConfirmed: true, termsAttested: true },
  });
  expect(created.ok()).toBe(true);
  const tenant = (await created.json()) as { id: string; apiKey: string; publicFormKey: string; name: string };

  const csv = "name,phone,email,source\nJordan Lee,+13125550147,jordan@example.com,website_form";
  const imported = await page.request.post("/leads/import", {
    headers: { Authorization: `Bearer ${tenant.apiKey}` },
    data: { csv },
  });
  expect(imported.ok()).toBe(true);

  const leadsRes = await page.request.get("/leads", { headers: { Authorization: `Bearer ${tenant.apiKey}` } });
  const leads = (await leadsRes.json()) as Array<{ id: string }>;
  const leadId = leads[0].id;

  return { tenant, leadId };
}

function bookingUrl(tenantId: string, leadId: string, formKey: string): string {
  return `/book-appointment.html?tenant=${encodeURIComponent(tenantId)}&lead=${encodeURIComponent(leadId)}&key=${encodeURIComponent(formKey)}`;
}

/**
 * A datetime-local <input> value represents local wall-clock time with no
 * timezone — toISOString() is UTC, so slicing it only happens to work in a
 * UTC-configured test environment. This builds the value from local
 * getters instead, so it's correct regardless of the runner's timezone.
 */
function toDateTimeLocal(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** A future datetime-local value well within the 180-day booking window. */
function futureDateTimeLocal(): string {
  return toDateTimeLocal(new Date(Date.now() + 3 * 24 * 60 * 60 * 1000));
}

test.describe("Self-serve booking (public/book-appointment.html)", () => {
  test("shows the invalid-link message with no query params at all", async ({ page }) => {
    await page.goto("/book-appointment.html");
    await expect(page.locator("#invalid-state")).toBeVisible();
    await expect(page.locator("#loading-state")).toBeHidden();
    await expect(page.locator("#form-state")).toBeHidden();
  });

  test("loads the form for a valid tenant/lead/key, showing the business name", async ({ page }) => {
    const { tenant, leadId } = await createTenantWithLead(page);
    await page.goto(bookingUrl(tenant.id, leadId, tenant.publicFormKey));

    await expect(page.locator("#form-state")).toBeVisible();
    await expect(page.locator("#loading-state")).toBeHidden();
    await expect(page.locator("#subheading")).toHaveText(`with ${tenant.name}`);
    await expect(page.locator("#existing-appt")).toBeHidden();
    await expect(page.locator("#book-btn")).toHaveText("Confirm appointment");
  });

  test("the real server rejects a wrong formKey with a clear, generic error", async ({ page }) => {
    const { tenant, leadId } = await createTenantWithLead(page);
    await page.goto(bookingUrl(tenant.id, leadId, "not-the-real-form-key"));

    await expect(page.locator("#invalid-state")).toBeVisible();
    await expect(page.locator("#invalid-state")).toContainText("invalid tenantId, leadId, or formKey");
    await expect(page.locator("#form-state")).toBeHidden();
  });

  test("rejects submitting with no date/time chosen, without calling the server", async ({ page }) => {
    const { tenant, leadId } = await createTenantWithLead(page);
    await page.goto(bookingUrl(tenant.id, leadId, tenant.publicFormKey));
    await expect(page.locator("#form-state")).toBeVisible();

    await page.click("#book-btn");
    await expect(page.locator("#form-error")).toHaveText("Please choose a date and time.");
  });

  test("books a real appointment and shows the success state", async ({ page }) => {
    const { tenant, leadId } = await createTenantWithLead(page);
    await page.goto(bookingUrl(tenant.id, leadId, tenant.publicFormKey));
    await expect(page.locator("#form-state")).toBeVisible();

    await page.fill("#appt-datetime", futureDateTimeLocal());
    await page.click("#book-btn");

    await expect(page.locator("#success-state")).toBeVisible();
    await expect(page.locator("#form-state")).toBeHidden();
    await expect(page.locator("#success-detail")).toContainText("You're booked for");
  });

  test("revisiting an already-booked lead's link shows the existing appointment and offers to reschedule", async ({
    page,
  }) => {
    const { tenant, leadId } = await createTenantWithLead(page);
    const url = bookingUrl(tenant.id, leadId, tenant.publicFormKey);

    // Book once for real, then reload the same link — rather than asserting
    // on the booked time's exact locale-formatted text (fragile across
    // environments), this only checks the page correctly switches into its
    // "reschedule" mode once the server reports an existing booking.
    await page.goto(url);
    await page.fill("#appt-datetime", futureDateTimeLocal());
    await page.click("#book-btn");
    await expect(page.locator("#success-state")).toBeVisible();

    await page.goto(url);
    await expect(page.locator("#existing-appt")).toBeVisible();
    await expect(page.locator("#existing-appt")).toContainText("Currently booked for");
    await expect(page.locator("#book-btn")).toHaveText("Reschedule appointment");
  });

  test("the real server rejects a past date/time", async ({ page }) => {
    const { tenant, leadId } = await createTenantWithLead(page);
    await page.goto(bookingUrl(tenant.id, leadId, tenant.publicFormKey));
    await expect(page.locator("#form-state")).toBeVisible();

    await page.fill("#appt-datetime", toDateTimeLocal(new Date(Date.now() - 24 * 60 * 60 * 1000)));
    await page.click("#book-btn");

    await expect(page.locator("#form-error")).toContainText("Could not book");
    await expect(page.locator("#success-state")).toBeHidden();
  });
});
