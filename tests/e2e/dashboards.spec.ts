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
});
