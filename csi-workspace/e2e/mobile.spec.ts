import { test, expect } from "@playwright/test";
import { login } from "./helpers";

test("mobile: bottom navigation, tasks and no horizontal scroll", async ({ page }) => {
  await login(page, "lerato");
  await expect(page.getByRole("navigation", { name: "Quick navigation" })).toBeVisible();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(1);
  await page.getByRole("navigation", { name: "Quick navigation" }).getByRole("link", { name: "Tasks" }).click();
  await expect(page).toHaveURL(/\/tasks/);
  await page.getByRole("button", { name: "Open navigation" }).click();
  await expect(page.locator(".sidebar.open").getByRole("link", { name: "Knowledge Hub" })).toBeVisible();
});
