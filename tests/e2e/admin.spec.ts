import { test, expect } from "@playwright/test";
import { createHmac } from "node:crypto";

// public/admin.html manages tenants across the whole platform — connects
// with ADMIN_API_KEY (fixed to "e2e-test-admin-key" for this run, see
// playwright.config.ts), not a tenant API key. Every test here creates and
// deletes its own uniquely-named tenant and runs serially: these mutate
// shared server-side state (the tenant list, the audit log), unlike the
// read-only dashboard specs, so parallel workers would race on tenant counts.

const ADMIN_KEY = "e2e-test-admin-key";
// Matches playwright.config.ts's webServer.env — fixed test-only value.
const PADDLE_SECRET = "e2e-test-paddle-secret";

function uniqueName(label: string): string {
  return `${label} ${Date.now()}-${Math.floor(Math.random() * 10_000)}`;
}

async function connect(page: import("@playwright/test").Page) {
  await page.goto("/admin.html");
  await page.fill("#admin-key", ADMIN_KEY);
  await page.click("#connect-btn");
  await expect(page.locator("#app")).toBeVisible();
}

test.describe("Admin UI (public/admin.html)", () => {
  test.describe.configure({ mode: "serial" });

  test("connects with a valid admin key and lists the demo tenant", async ({ page }) => {
    await page.goto("/admin.html");
    await expect(page.locator("#auth")).toBeVisible();
    await connect(page);
    await expect(page.locator("#tenants")).toContainText("Nkosi Integrations (Demo)");
  });

  test("shows an error and stays on the gate for a bad admin key", async ({ page }) => {
    await page.goto("/admin.html");
    await page.fill("#admin-key", "not-the-real-key");
    await page.click("#connect-btn");

    await expect(page.locator("#auth")).toBeVisible();
    await expect(page.locator("#auth-error")).toContainText("Could not connect");
  });

  test("creates a tenant, reveals its API key once, then it appears in the tenant list", async ({ page }) => {
    await connect(page);
    const name = uniqueName("E2E Create");

    await page.fill("#new-name", name);
    await page.fill("#new-timezone", "Africa/Johannesburg");
    await page.click("#create-btn");

    await expect(page.locator(".reveal .key")).toContainText("lr_");
    await expect(page.locator("#tenants")).toContainText(name);

    // Clean up so this doesn't leak into other tests/spec files sharing the demo server.
    const card = page.locator(`.card:has-text("${name}")`);
    page.once("dialog", (d) => d.accept());
    await card.getByRole("button", { name: "Delete" }).click();
    await expect(page.locator("#tenants")).not.toContainText(name);
  });

  test("creating a tenant reveals a magic link, and the friendly contact fields show up in the tenant list", async ({
    page,
  }) => {
    await connect(page);
    const name = uniqueName("E2E Magic Link");

    await page.fill("#new-name", name);
    await page.fill("#new-timezone", "UTC");
    await page.fill("#new-phone", "(555) 123-4567");
    await page.fill("#new-email", "owner@example.com");
    await page.fill("#new-website", "https://example.com");
    await page.click("#create-btn");

    await expect(page.locator(".reveal .key")).toContainText("lr_");
    const magicLink = await page.locator(".reveal .magic-link-value").textContent();
    expect(magicLink).toMatch(/\/index\.html\?key=lr_/);

    const card = page.locator(`.card:has-text("${name}")`);
    await expect(card).toContainText("(555) 123-4567");
    await expect(card).toContainText("owner@example.com");
    await expect(card).toContainText("https://example.com");

    page.once("dialog", (d) => d.accept());
    await card.getByRole("button", { name: "Delete" }).click();
    await expect(page.locator("#tenants")).not.toContainText(name);
  });

  test("skips provider setup by default (test mode) — the Twilio/SendGrid fields only appear once unchecked", async ({
    page,
  }) => {
    await connect(page);
    await expect(page.locator("#new-skip-channels")).toBeChecked();
    await expect(page.locator("#channel-fields")).toBeHidden();

    await page.click("#new-skip-channels");
    await expect(page.locator("#channel-fields")).toBeVisible();

    await page.click("#new-skip-channels");
    await expect(page.locator("#channel-fields")).toBeHidden();
  });

  test("rejects a partially-filled Twilio section instead of silently dropping it", async ({ page }) => {
    await connect(page);
    const name = uniqueName("E2E Partial Twilio");

    await page.fill("#new-name", name);
    await page.fill("#new-timezone", "UTC");
    await page.click("#new-skip-channels"); // uncheck: show channel fields
    await page.fill("#new-twilio-sid", "AC123");
    // authToken and fromNumber left blank on purpose
    await page.click("#create-btn");

    await expect(page.locator("#create-error")).toContainText("Fill in all three Twilio fields");
    await expect(page.locator("#tenants")).not.toContainText(name);
  });

  test("rejects creating a tenant with no name/timezone", async ({ page }) => {
    await connect(page);
    await page.fill("#new-name", "");
    await page.fill("#new-timezone", "");
    await page.click("#create-btn");
    await expect(page.locator("#create-error")).toContainText("required");
  });

  test("suspend/reactivate toggles the tenant's status badge and blocks/restores its API key", async ({ page }) => {
    await connect(page);
    const name = uniqueName("E2E Suspend");
    await page.fill("#new-name", name);
    await page.fill("#new-timezone", "UTC");
    await page.click("#create-btn");
    await expect(page.locator(".reveal .key")).toContainText("lr_");

    const card = page.locator(`.card:has-text("${name}")`);
    await expect(card.locator(".badge")).toHaveText("active");

    await card.getByRole("button", { name: "Suspend" }).click();
    await expect(card.locator(".badge")).toHaveText("suspended");

    await card.getByRole("button", { name: "Reactivate" }).click();
    await expect(card.locator(".badge")).toHaveText("active");

    page.once("dialog", (d) => d.accept());
    await card.getByRole("button", { name: "Delete" }).click();
    await expect(page.locator("#tenants")).not.toContainText(name);
  });

  test("shows a distinct 'billing' tag when Paddle auto-suspends a tenant, unlike a manual suspend", async ({
    page,
  }) => {
    await connect(page);
    const name = uniqueName("E2E Billing");
    await page.fill("#new-name", name);
    await page.fill("#new-timezone", "UTC");
    await page.click("#create-btn");
    await expect(page.locator(".reveal .key")).toContainText("lr_");

    const card = page.locator(`.card:has-text("${name}")`);
    // The card's .meta text is "<id> · <timezone> · created <date>" — pull
    // the real tenant id out so the Paddle event below actually targets it.
    const metaText = await card.locator(".meta").innerText();
    const tenantId = metaText.split("·")[0].trim();

    const timestamp = String(Math.floor(Date.now() / 1000));
    const rawBody = JSON.stringify({
      event_type: "subscription.canceled",
      occurred_at: new Date().toISOString(),
      data: { id: `sub_e2e_${tenantId}`, custom_data: { tenantId } },
    });
    const hash = createHmac("sha256", PADDLE_SECRET).update(`${timestamp}:${rawBody}`).digest("hex");
    const res = await page.request.post("/webhooks/paddle", {
      headers: { "Content-Type": "application/json", "Paddle-Signature": `ts=${timestamp};h1=${hash}` },
      data: rawBody,
    });
    expect(res.status()).toBe(204);

    // admin.html only fetches the tenant list on connect/action, not on a
    // timer, so it won't see this server-side change until asked again.
    await page.reload();
    await expect(page.locator("#app")).toBeVisible(); // persisted session reconnects automatically

    const cardAfter = page.locator(`.card:has-text("${name}")`);
    await expect(cardAfter.locator(".badge.suspended")).toHaveText("suspended");
    await expect(cardAfter.locator(".badge.billing")).toHaveText("billing");

    // A manual reactivate should clear the billing tag, since it's now an
    // admin decision, not a billing-driven state. Asserting on the
    // class-scoped locators (not a bare ".badge", which matches both the
    // status and billing spans while suspended) avoids a Playwright
    // strict-mode violation during the moment between the click and the
    // card's re-render.
    await cardAfter.getByRole("button", { name: "Reactivate" }).click();
    await expect(cardAfter.locator(".badge.active")).toHaveText("active");
    await expect(cardAfter.locator(".badge.billing")).toHaveCount(0);

    page.once("dialog", (d) => d.accept());
    await cardAfter.getByRole("button", { name: "Delete" }).click();
    await expect(page.locator("#tenants")).not.toContainText(name);
  });

  test("rotate-key reveals a new key and records an audit-log entry", async ({ page }) => {
    await connect(page);
    const name = uniqueName("E2E Rotate");
    await page.fill("#new-name", name);
    await page.fill("#new-timezone", "UTC");
    await page.click("#create-btn");

    const card = page.locator(`.card:has-text("${name}")`);
    page.once("dialog", (d) => d.accept());
    await card.getByRole("button", { name: "Rotate key" }).click();
    await expect(page.locator(".reveal .key")).toContainText("lr_");
    await expect(page.locator("#audit-log")).toContainText("tenant.key_rotate");

    page.once("dialog", (d) => d.accept());
    await card.getByRole("button", { name: "Delete" }).click();
    await expect(page.locator("#tenants")).not.toContainText(name);
  });

  test("delete asks for confirmation and removes the tenant on accept", async ({ page }) => {
    await connect(page);
    const name = uniqueName("E2E Delete");
    await page.fill("#new-name", name);
    await page.fill("#new-timezone", "UTC");
    await page.click("#create-btn");
    await expect(page.locator("#tenants")).toContainText(name);

    const card = page.locator(`.card:has-text("${name}")`);
    page.once("dialog", (d) => d.dismiss());
    await card.getByRole("button", { name: "Delete" }).click();
    await expect(page.locator("#tenants")).toContainText(name); // dismissed — still there

    page.once("dialog", (d) => d.accept());
    await card.getByRole("button", { name: "Delete" }).click();
    await expect(page.locator("#tenants")).not.toContainText(name);
  });

  test("records tenant creation and deletion in the audit log", async ({ page }) => {
    await connect(page);
    const name = uniqueName("E2E Audit");
    await page.fill("#new-name", name);
    await page.fill("#new-timezone", "UTC");
    await page.click("#create-btn");
    await expect(page.locator("#audit-log")).toContainText("tenant.create");

    const card = page.locator(`.card:has-text("${name}")`);
    page.once("dialog", (d) => d.accept());
    await card.getByRole("button", { name: "Delete" }).click();
    await expect(page.locator("#audit-log")).toContainText("tenant.delete");
  });

  test("paginates the tenant list once there are more than one page's worth", async ({ page }) => {
    // Creating 21+ tenants through the UI would be slow and isn't what's under
    // test here — go straight through the admin API (same one the page calls)
    // to get past the page size (20), then drive only the pagination controls.
    const label = uniqueName("E2E Page");
    const created: string[] = [];
    for (let i = 0; i < 21; i++) {
      const res = await page.request.post("/admin/tenants", {
        headers: { Authorization: `Bearer ${ADMIN_KEY}` },
        data: { name: `${label} ${i}`, timezone: "UTC" },
      });
      expect(res.ok()).toBe(true);
      created.push(((await res.json()) as { id: string }).id);
    }

    try {
      await connect(page);
      await expect(page.locator("#tenants-summary")).toHaveText(/^1-20 of \d+ tenant\(s\)$/);
      await expect(page.locator("#tenants-prev-btn")).toBeDisabled();
      await expect(page.locator("#tenants-next-btn")).toBeEnabled();

      await page.click("#tenants-next-btn");
      await expect(page.locator("#tenants-summary")).toHaveText(/^21-\d+ of \d+ tenant\(s\)$/);
      await expect(page.locator("#tenants-prev-btn")).toBeEnabled();

      await page.click("#tenants-prev-btn");
      await expect(page.locator("#tenants-summary")).toHaveText(/^1-20 of \d+ tenant\(s\)$/);
      await expect(page.locator("#tenants-prev-btn")).toBeDisabled();
    } finally {
      for (const id of created) {
        await page.request.delete(`/admin/tenants/${id}`, {
          headers: { Authorization: `Bearer ${ADMIN_KEY}` },
        });
      }
    }
  });

  test("a slow, superseded page response never overwrites a newer one (pager race)", async ({ page }) => {
    // Regression test: loadAll() used to have no guard against two overlapping
    // requests resolving out of order — a fast double-click on "Next" could
    // let an older, slower response render after a newer one already did,
    // showing rows from one offset under a pager summary for a different
    // offset. Reproduced here by artificially delaying the response for the
    // first click (offset=20) so it resolves after the second (offset=40).
    const label = uniqueName("E2E Race");
    const created: string[] = [];
    for (let i = 0; i < 45; i++) {
      const res = await page.request.post("/admin/tenants", {
        headers: { Authorization: `Bearer ${ADMIN_KEY}` },
        data: { name: `${label} ${i}`, timezone: "UTC" },
      });
      expect(res.ok()).toBe(true);
      created.push(((await res.json()) as { id: string }).id);
    }

    try {
      // The real total (other tenants — e.g. the seeded demo one — may
      // already exist), so the pager math below isn't hardcoded to "45".
      const totalRes = await page.request.get("/admin/tenants?limit=1&offset=0", {
        headers: { Authorization: `Bearer ${ADMIN_KEY}` },
      });
      const total = Number(totalRes.headers()["x-total-count"]);
      const expectedShownTo = Math.min(60, total);

      await connect(page);

      await page.route("**/admin/tenants?*", async (route) => {
        const url = new URL(route.request().url());
        if (url.searchParams.get("offset") === "20") {
          await new Promise((resolve) => setTimeout(resolve, 500));
        }
        await route.continue();
      });

      // Click Next twice back-to-back: the first request (offset=20) is
      // delayed above; the second (offset=40) is not and resolves first.
      await page.click("#tenants-next-btn");
      await page.click("#tenants-next-btn");

      // Wait past the artificial delay, then confirm the newer (offset=40)
      // response is what's actually showing, and stays that way — the
      // stale, late-arriving offset=20 response must never overwrite it.
      await page.waitForTimeout(700);
      await expect(page.locator("#tenants-summary")).toHaveText(`41-${expectedShownTo} of ${total} tenant(s)`);
      await expect(page.locator("#tenants")).not.toContainText(`${label} 20`); // offset=20's data
      await expect(page.locator("#tenants")).toContainText(`${label} 44`); // offset=40's data
    } finally {
      await page.unroute("**/admin/tenants?*");
      for (const id of created) {
        await page.request.delete(`/admin/tenants/${id}`, {
          headers: { Authorization: `Bearer ${ADMIN_KEY}` },
        });
      }
    }
  });

  test("deleting every tenant on the last page falls back to a valid page instead of showing empty", async ({
    page,
  }) => {
    const label = uniqueName("E2E PageDelete");
    const created: string[] = [];
    for (let i = 0; i < 21; i++) {
      const res = await page.request.post("/admin/tenants", {
        headers: { Authorization: `Bearer ${ADMIN_KEY}` },
        data: { name: `${label} ${i}`, timezone: "UTC" },
      });
      expect(res.ok()).toBe(true);
      created.push(((await res.json()) as { id: string }).id);
    }

    try {
      await connect(page);
      await page.click("#tenants-next-btn");
      await expect(page.locator("#tenants-prev-btn")).toBeEnabled();

      // Delete every tenant on this (last) page, one at a time. Fixed number
      // of iterations, not "until the list is empty" — once the final one is
      // deleted the view falls back to page 1, which is non-empty, so an
      // "until empty" loop would keep going and delete page 1 too.
      const page2Count = await page.locator("#tenants .card").count();
      expect(page2Count).toBeGreaterThan(0);
      for (let i = 0; i < page2Count; i++) {
        const card = page.locator("#tenants .card").first();
        page.once("dialog", (d) => d.accept());
        await card.getByRole("button", { name: "Delete" }).click();
        await expect(page.locator("#tenants-summary")).not.toHaveText("");
      }

      // Deleting the last tenant on the last page must not leave the view
      // stuck showing "No tenants yet." while tenants still exist elsewhere —
      // it should fall back to the last valid page.
      await expect(page.locator("#tenants")).not.toContainText("No tenants yet.");
      await expect(page.locator("#tenants .card").first()).toBeVisible();
      await expect(page.locator("#tenants-prev-btn")).toBeDisabled();
    } finally {
      for (const id of created) {
        await page.request.delete(`/admin/tenants/${id}`, {
          headers: { Authorization: `Bearer ${ADMIN_KEY}` },
        });
      }
    }
  });

  test("reconnects automatically on reload using the persisted session", async ({ page }) => {
    await connect(page);
    await page.reload();
    await expect(page.locator("#app")).toBeVisible();
    await expect(page.locator("#auth")).toBeHidden();
  });

  test("disconnect returns to the auth panel and clears the session", async ({ page }) => {
    await connect(page);
    await page.click("#logout-btn");
    await expect(page.locator("#app")).toBeHidden();
    await expect(page.locator("#auth")).toBeVisible();

    await page.reload();
    await expect(page.locator("#auth")).toBeVisible();
  });
});
