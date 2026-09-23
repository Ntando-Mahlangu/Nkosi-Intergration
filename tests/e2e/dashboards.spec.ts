import { test, expect } from "@playwright/test";

// Both dashboards share the same connect flow: base URL (defaults to the
// current origin) + tenant API key, stored in localStorage as
// "leadrecovery.session". The demo server (no DATABASE_URL) seeds a "demo"
// tenant with API key "demo-key" over data/sample-leads.json (16 leads).

test.describe("Command Center (public/index.html, the default landing page)", () => {
  test("connects with a valid API key and renders live category nodes", async ({ page }) => {
    await page.goto("/");

    // Gate is visible until connected.
    await expect(page.locator("#gate")).toBeVisible();
    await expect(page.locator("#tenant-label")).toHaveText("NOT CONNECTED");

    await page.fill("#api-key", "demo-key");
    await page.click("#connect-btn");

    await expect(page.locator("#gate")).toBeHidden();
    await expect(page.locator("#tenant-label")).toHaveText("NKOSI INTEGRATIONS (DEMO)");

    // The scene renders one <g class="node"> per category, each with a
    // live count derived from the real /leads response.
    const nodes = page.locator("g.node");
    await expect(nodes).toHaveCount(8);

    const counts = await page.locator("g.node .node-count").allTextContents();
    const total = counts.reduce((sum, c) => sum + Number(c), 0);
    expect(total).toBeGreaterThan(0);
  });

  test("the one-click 'Explore the bundled demo' button connects without typing anything", async ({ page }) => {
    // Regression test for a UX friction point: a first-time visitor with no
    // account saw an empty "lr_..."-hinted API key field and had no way to
    // tell it should be "demo-key" instead. This button removes that guess.
    await page.goto("/");
    await expect(page.locator("#gate")).toBeVisible();
    await expect(page.locator("#api-key")).toHaveValue("");

    await page.click("#demo-btn");

    await expect(page.locator("#gate")).toBeHidden();
    await expect(page.locator("#tenant-label")).toHaveText("NKOSI INTEGRATIONS (DEMO)");
  });

  test("disconnect returns to the access gate and clears the persisted session", async ({ page }) => {
    await page.goto("/");
    await page.click("#demo-btn");
    await expect(page.locator("#gate")).toBeHidden();

    await page.click("#disconnect-btn");

    await expect(page.locator("#gate")).toBeVisible();
    await expect(page.locator("#tenant-label")).toHaveText("NOT CONNECTED");

    // A reload must land back on the gate too, not silently reconnect —
    // confirms the session was actually cleared, not just the UI hidden.
    await page.reload();
    await expect(page.locator("#gate")).toBeVisible();
    await expect(page.locator("#tenant-label")).toHaveText("NOT CONNECTED");
  });

  test("clicking a node opens the detail panel with its leads", async ({ page }) => {
    await page.goto("/");
    await page.fill("#api-key", "demo-key");
    await page.click("#connect-btn");
    await expect(page.locator("#gate")).toBeHidden();

    // Find a category node with a non-zero count and open it.
    const nodes = page.locator("g.node");
    const count = await nodes.count();
    let opened = false;
    for (let i = 0; i < count; i++) {
      const node = nodes.nth(i);
      const text = await node.locator(".node-count").textContent();
      if (Number(text) > 0) {
        // The scene is continuously animated (breathing/idle motion), so the
        // node never satisfies Playwright's "stable for 2 frames" actionability
        // check — force the click instead of waiting for stillness.
        await node.click({ force: true });
        opened = true;
        break;
      }
    }
    expect(opened).toBe(true);

    const detail = page.locator("#detail");
    await expect(detail).toHaveClass(/open/);
    await expect(page.locator("#detail-count")).toContainText("lead(s)");
    await expect(page.locator("#detail-list")).not.toBeEmpty();

    await page.click("#detail-close");
    await expect(detail).not.toHaveClass(/open/);
  });

  test("category nodes are keyboard-operable: Enter opens, Escape closes and returns focus", async ({ page }) => {
    await page.goto("/");
    await page.fill("#api-key", "demo-key");
    await page.click("#connect-btn");
    await expect(page.locator("#gate")).toBeHidden();

    const nodes = page.locator("g.node");
    const count = await nodes.count();
    let targetIndex = -1;
    for (let i = 0; i < count; i++) {
      const text = await nodes.nth(i).locator(".node-count").textContent();
      if (Number(text) > 0) {
        targetIndex = i;
        break;
      }
    }
    expect(targetIndex).toBeGreaterThanOrEqual(0);
    const target = nodes.nth(targetIndex);

    // Each node is a real tab stop (tabindex="0", role="button") — focus it
    // directly rather than tabbing through every preceding node.
    await target.focus();
    await expect(target).toBeFocused();

    const detail = page.locator("#detail");
    await page.keyboard.press("Enter");
    await expect(detail).toHaveClass(/open/);
    await expect(page.locator("#detail-close")).toBeFocused();

    await page.keyboard.press("Escape");
    await expect(detail).not.toHaveClass(/open/);
    await expect(target).toBeFocused();
  });

  test("shows an error and stays on the gate for a bad API key", async ({ page }) => {
    await page.goto("/");
    await page.fill("#api-key", "not-a-real-key");
    await page.click("#connect-btn");

    await expect(page.locator("#gate")).toBeVisible();
    await expect(page.locator("#gate-err")).toContainText("Link failed");
  });

  test("reconnects automatically on reload using the persisted session", async ({ page }) => {
    await page.goto("/");
    await page.fill("#api-key", "demo-key");
    await page.click("#connect-btn");
    await expect(page.locator("#gate")).toBeHidden();

    await page.reload();
    await expect(page.locator("#gate")).toBeHidden();
    await expect(page.locator("#tenant-label")).toHaveText("NKOSI INTEGRATIONS (DEMO)");
  });
});

test.describe("List dashboard (public/dashboard.html, secondary working view)", () => {
  test("connects and renders the recovery plan and skipped leads", async ({ page }) => {
    await page.goto("/dashboard.html");

    await expect(page.locator("#auth")).toBeVisible();
    await expect(page.locator("#app")).toBeHidden();

    await page.fill("#api-key", "demo-key");
    await page.click("#connect-btn");

    await expect(page.locator("#auth")).toBeHidden();
    await expect(page.locator("#app")).toBeVisible();
    await expect(page.locator("#tenant-name")).toHaveText("Nkosi Integrations (Demo)");
    await expect(page.locator("#summary")).toContainText("queued");
    await expect(page.locator("#summary")).toContainText("skipped");
  });

  test("shows an error for a bad API key", async ({ page }) => {
    await page.goto("/dashboard.html");
    await page.fill("#api-key", "not-a-real-key");
    await page.click("#connect-btn");

    await expect(page.locator("#app")).toBeHidden();
    await expect(page.locator("#auth-error")).toContainText("Could not connect");
  });

  test("disconnect returns to the auth panel and clears the session", async ({ page }) => {
    await page.goto("/dashboard.html");
    await page.fill("#api-key", "demo-key");
    await page.click("#connect-btn");
    await expect(page.locator("#app")).toBeVisible();

    await page.click("#logout-btn");
    await expect(page.locator("#app")).toBeHidden();
    await expect(page.locator("#auth")).toBeVisible();

    await page.reload();
    await expect(page.locator("#auth")).toBeVisible();
  });

  test("links back to the Command Center", async ({ page }) => {
    await page.goto("/dashboard.html");
    await page.fill("#api-key", "demo-key");
    await page.click("#connect-btn");
    await expect(page.locator("#app")).toBeVisible();

    await page.click("text=Command Center");
    await expect(page).toHaveURL(/\/index\.html$/);
  });

  test("renders the All leads list after connecting", async ({ page }) => {
    await page.goto("/dashboard.html");
    await page.fill("#api-key", "demo-key");
    await page.click("#connect-btn");
    await expect(page.locator("#app")).toBeVisible();

    const rows = page.locator("#all-leads .lead-row");
    await expect(rows.first()).toBeVisible();
    expect(await rows.count()).toBeGreaterThan(0);
  });

  test("clicking a lead row opens the detail dialog with its conversation", async ({ page }) => {
    await page.goto("/dashboard.html");
    await page.fill("#api-key", "demo-key");
    await page.click("#connect-btn");
    await expect(page.locator("#app")).toBeVisible();

    const firstRow = page.locator("#all-leads .lead-row").first();
    const name = await firstRow.locator(".name").textContent();
    await firstRow.click();

    await expect(page.locator("#overlay")).toHaveClass(/open/);
    await expect(page.locator("#lead-detail")).not.toHaveAttribute("aria-hidden", "true");
    await expect(page.locator("#detail-name")).toHaveText(name || "");

    // The thread starts as "Loading…" and then resolves (empty or with bubbles).
    await expect(page.locator("#detail-thread")).not.toContainText("Loading");

    await page.click("#detail-close-btn");
    await expect(page.locator("#overlay")).not.toHaveClass(/open/);
    await expect(page.locator("#lead-detail")).toHaveAttribute("aria-hidden", "true");
  });

  test("keyboard users can open a lead row with Enter and close the dialog with Escape, returning focus", async ({
    page,
  }) => {
    await page.goto("/dashboard.html");
    await page.fill("#api-key", "demo-key");
    await page.click("#connect-btn");
    await expect(page.locator("#app")).toBeVisible();

    const firstRow = page.locator("#all-leads .lead-row").first();
    await firstRow.focus();
    await expect(firstRow).toBeFocused();

    await page.keyboard.press("Enter");
    await expect(page.locator("#overlay")).toHaveClass(/open/);
    await expect(page.locator("#detail-close-btn")).toBeFocused();

    await page.keyboard.press("Escape");
    await expect(page.locator("#overlay")).not.toHaveClass(/open/);
    await expect(firstRow).toBeFocused();
  });

  test("saving an appointment shows a success message and the appt badge in the list", async ({ page }) => {
    await page.goto("/dashboard.html");
    await page.fill("#api-key", "demo-key");
    await page.click("#connect-btn");
    await expect(page.locator("#app")).toBeVisible();

    const firstRow = page.locator("#all-leads .lead-row").first();
    await firstRow.click();
    await expect(page.locator("#overlay")).toHaveClass(/open/);

    await page.selectOption("#detail-appt-status", "booked");
    await page.fill("#detail-appt-at", "2030-06-15T14:30");
    await page.click("#detail-appt-save");

    await expect(page.locator("#detail-appt-status-msg")).toHaveText("Saved.");
    await expect(page.locator("#detail-appt-status-msg")).toHaveClass(/ok/);

    await page.click("#detail-close-btn");
    await expect(page.locator("#overlay")).not.toHaveClass(/open/);
    await expect(firstRow.locator(".appt-tag")).toBeVisible();

    // Re-opening the same lead confirms the save actually persisted server-side,
    // not just optimistic local UI state.
    await firstRow.click();
    await expect(page.locator("#detail-appt-status")).toHaveValue("booked");
    await expect(page.locator("#detail-appt-at")).toHaveValue("2030-06-15T14:30");
  });

  test("imports leads from an uploaded CSV file", async ({ page }) => {
    await page.goto("/dashboard.html");
    await page.fill("#api-key", "demo-key");
    await page.click("#connect-btn");
    await expect(page.locator("#app")).toBeVisible();

    const rowsBefore = await page.locator("#all-leads .lead-row").count();

    const csv = "name,phone,email,source\nImported Test Lead,+15551234567,imported@example.com,web";
    await page.setInputFiles("#import-file", {
      name: "leads.csv",
      mimeType: "text/csv",
      buffer: Buffer.from(csv),
    });
    await page.click("#import-btn");

    await expect(page.locator("#import-status")).toContainText("Imported 1");
    await expect(page.locator("#import-status")).toHaveClass(/ok/);

    const rowsAfter = page.locator("#all-leads .lead-row");
    await expect(rowsAfter).toHaveCount(rowsBefore + 1);
    await expect(page.locator("#all-leads")).toContainText("Imported Test Lead");
  });
});

test.describe("Reports (public/reports.html, ROI/activity view)", () => {
  test("connects and renders the pipeline snapshot and message activity", async ({ page }) => {
    await page.goto("/reports.html");

    await expect(page.locator("#auth")).toBeVisible();
    await expect(page.locator("#app")).toBeHidden();

    await page.click("#demo-btn");

    await expect(page.locator("#auth")).toBeHidden();
    await expect(page.locator("#app")).toBeVisible();
    await expect(page.locator("#tenant-name")).toHaveText("Nkosi Integrations (Demo)");

    // The demo tenant's data file is shared across this whole test run (other
    // tests in this file import/mutate leads), so assert shape, not an exact
    // count: a real, positive pipeline total rather than a specific number.
    await expect(page.locator("#lead-stats")).toContainText("Total leads");
    const total = await page.locator("#lead-stats .stat-card").first().locator(".stat-value").textContent();
    expect(Number(total)).toBeGreaterThan(0);
    await expect(page.locator("#message-stats")).toContainText("Outbound sent");
    await expect(page.locator("#message-stats")).toContainText("Inbound replies");
  });

  test("shows an error for a bad API key", async ({ page }) => {
    await page.goto("/reports.html");
    await page.fill("#api-key", "not-a-real-key");
    await page.click("#connect-btn");

    await expect(page.locator("#app")).toBeHidden();
    await expect(page.locator("#auth-error")).toContainText("Could not connect");
  });

  test("running the recovery workflow is reflected in the report's message activity", async ({ page }) => {
    // Run the workflow from the list dashboard first so there's outbound
    // activity to report on, then confirm the reports page picks it up.
    await page.goto("/dashboard.html");
    await page.fill("#api-key", "demo-key");
    await page.click("#connect-btn");
    await expect(page.locator("#app")).toBeVisible();
    await page.click("#run-btn");
    await expect(page.locator("#run-btn")).toHaveText("Run recovery workflow", { timeout: 15000 });

    await page.goto("/reports.html");
    await expect(page.locator("#app")).toBeVisible();
    await expect(page.locator("#outbound-breakdown")).toContainText("campaign");
    // Outbound sent is the first stat card in #message-stats — the workflow
    // run above must have moved it above zero.
    const outboundSent = await page.locator("#message-stats .stat-card").first().locator(".stat-value").textContent();
    expect(Number(outboundSent)).toBeGreaterThan(0);
  });

  test("date range shortcuts (this month / all time) reload the report without error", async ({ page }) => {
    await page.goto("/reports.html");
    await page.click("#demo-btn");
    await expect(page.locator("#app")).toBeVisible();

    await page.click("#this-month-btn");
    await expect(page.locator("#since")).not.toHaveValue("");
    await expect(page.locator("#until")).not.toHaveValue("");
    await expect(page.locator("#report-error")).toBeEmpty();
    await expect(page.locator("#lead-stats")).toContainText("Total leads");

    await page.click("#all-time-btn");
    await expect(page.locator("#since")).toHaveValue("");
    await expect(page.locator("#until")).toHaveValue("");
    await expect(page.locator("#report-error")).toBeEmpty();
  });

  test("links back to the Command Center and other views", async ({ page }) => {
    await page.goto("/reports.html");
    await page.click("#demo-btn");
    await expect(page.locator("#app")).toBeVisible();

    await page.click("text=Command Center");
    await expect(page).toHaveURL(/\/index\.html$/);
  });
});
