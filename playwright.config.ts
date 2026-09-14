import { defineConfig, devices } from "@playwright/test";

// Separate from the vitest unit suite (`npm test`) — these exercise the two
// static dashboards (public/index.html, public/dashboard.html) against a
// real running server in a real browser. Run with `npm run test:e2e`.
export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: "list",
  use: {
    baseURL: "http://127.0.0.1:4173",
    trace: "on-first-retry",
    // This sandbox/CI pins a pre-fetched Chromium build rather than letting
    // Playwright download its preferred revision at install time; other
    // environments can leave this unset to use Playwright's own managed browser.
    launchOptions: process.env.PLAYWRIGHT_CHROMIUM_PATH
      ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH }
      : undefined,
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: "npm run dev",
    url: "http://127.0.0.1:4173/health",
    reuseExistingServer: !process.env.CI,
    env: { PORT: "4173" },
    timeout: 30_000,
  },
});
