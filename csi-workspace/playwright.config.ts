import { defineConfig, devices } from "@playwright/test";

const PORT = 4321;
export default defineConfig({
  testDir: "e2e",
  timeout: 30000,
  retries: 0,
  workers: 1,
  use: { baseURL: `http://localhost:${PORT}`, trace: "off" },
  projects: [
    { name: "desktop", use: { ...devices["Desktop Chrome"] }, testIgnore: /mobile\.spec\.ts/ },
    { name: "mobile", use: { ...devices["Pixel 7"] }, testMatch: /mobile\.spec\.ts/ },
  ],
  webServer: {
    command: `rm -f data/e2e.db* && npm run build && DATABASE_PATH=./data/e2e.db SEED_DEMO_DATA=true DEMO_PASSWORD=E2e-demo-pass-1 PORT=${PORT} NODE_ENV=development npm start`,
    url: `http://localhost:${PORT}/health`,
    timeout: 120000,
    reuseExistingServer: false,
  },
});
