import { expect, type Page } from "@playwright/test";

export const PASSWORD = "E2e-demo-pass-1";

export async function login(page: Page, user: string) {
  await page.goto("/login");
  await page.getByLabel("Email").fill(`${user}@demo.csi.example`);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("heading", { name: "My CSI Workspace" })).toBeVisible();
}

/** Fail the test on any uncaught page error. */
export function trackErrors(page: Page) {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  return errors;
}
