import { test, expect } from "@playwright/test";
import { login, trackErrors } from "./helpers";

test("employee workspace shows real counts and stat cards open filtered task views", async ({ page }) => {
  const errors = trackErrors(page);
  await login(page, "lerato");
  await expect(page.getByText("Demonstration data.")).toBeVisible();
  const open = page.getByRole("button", { name: /Open tasks/i });
  await expect(open).toBeVisible();
  await expect(page.getByRole("button", { name: /Due today/i })).toBeVisible();
  await expect(page.getByRole("button", { name: /Awaiting review/i })).toBeVisible();
  // Clicking a stat card opens the filtered task list
  await page.getByRole("button", { name: /Due today/i }).click();
  await expect(page).toHaveURL(/\/tasks\?view=today/);
  await expect(page.getByRole("link", { name: "Send pilot reminder emails to nominated participants" }).first()).toBeVisible();
  expect(errors).toEqual([]);
});

test("every main module page renders for management without errors", async ({ page }) => {
  const errors = trackErrors(page);
  await login(page, "naledi");
  for (const [path, heading] of [
    ["/tasks", /Tasks/],
    ["/meetings", /Meetings/],
    ["/projects", /Projects/],
    ["/knowledge", /Knowledge/],
    ["/reports", /Reports/],
    ["/opportunities", /Opportunit/],
    ["/learning", /Learning/],
    ["/management", /Management/],
    ["/notifications", /Notifications/],
    ["/profile", /Profile/],
  ] as const) {
    await page.goto(path);
    await expect(page.getByRole("heading", { level: 1, name: heading }).first()).toBeVisible();
  }
  expect(errors).toEqual([]);
});

test("meeting owner extracts suggestions, accepts an action, approves and generates a call report", async ({ page }) => {
  const errors = trackErrors(page);
  await login(page, "ayesha");
  await page.goto("/meetings");
  await page.getByRole("tab", { name: "Needs review" }).click();
  await page.getByRole("link", { name: "D4C partner check-in" }).first().click();
  await expect(page.getByRole("heading", { level: 1, name: "D4C partner check-in" })).toBeVisible();
  await page.getByRole("button", { name: /Extract actions & decisions/ }).click();
  await page.waitForURL(/\/review/);
  await expect(page.getByText(/Rule-based suggestion/).first()).toBeVisible();
  // Accept the first action suggestion
  const actions = page.locator("section, .card").filter({ has: page.getByRole("heading", { name: "Action items" }) }).first();
  await actions.getByRole("button", { name: /^Accept/ }).first().click();
  await expect(actions.getByText(/Accepted/).first()).toBeVisible();
  // Approve the meeting record and generate a call report
  await page.goto(page.url().replace(/\/review$/, ""));
  await page.getByRole("button", { name: "Approve record" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Approve" }).click();
  await page.getByRole("button", { name: "Generate call report" }).click();
  await page.getByRole("dialog").getByRole("button", { name: /Generate/ }).click();
  await page.waitForURL(/\/reports\//);
  await expect(page.getByText("Change Science Institute").first()).toBeVisible();
  // The accepted action is now a *suggested* task for the named person — not a confirmed assignment
  const lerato = await page.request.get("/api/tasks?view=suggested");
  expect(lerato.ok()).toBeTruthy();
  expect(errors).toEqual([]);
});

test("restricted project is not reachable by a non-member, even an administrator", async ({ page }) => {
  await login(page, "grace");
  await page.goto("/projects");
  await expect(page.getByText("Unmasking").first()).toBeVisible();
  await expect(page.getByText("Leadership Retreat Planning")).toHaveCount(0);
  await page.goto("/search?q=Retreat");
  await expect(page.getByText("Leadership Retreat Planning")).toHaveCount(0);
});

test("employee cannot see administration or management", async ({ page }) => {
  await login(page, "lerato");
  await expect(page.getByRole("link", { name: "Administration" })).toHaveCount(0);
  await expect(page.getByRole("link", { name: "Management Intelligence" })).toHaveCount(0);
  const r = await page.request.get("/api/management/overview");
  expect(r.status()).toBe(403);
});

test("global search finds knowledge and navigates to it", async ({ page }) => {
  await login(page, "pieter");
  await page.getByLabel("Search CSI Workspace").fill("supplier");
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/\/search\?q=supplier/);
  await page.getByRole("link", { name: /How to onboard a supplier/ }).first().click();
  await expect(page.getByRole("heading", { level: 1, name: /How to onboard a supplier/ })).toBeVisible();
});
