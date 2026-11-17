import { expect, test } from "@playwright/test";
import { enter, expectCell, joinAsGuest, openDemo, share } from "./helpers.ts";

test("restoring a named version changes the sheet for everyone", async ({ page, browser }) => {
  const url = await openDemo(page);
  await share(page, "editor");
  const other = await joinAsGuest(browser, url);

  await page.getByRole("button", { name: "Version history" }).click();
  await page.getByLabel("Version name").fill("Before the reorg");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  const named = page.getByRole("button", { name: /Before the reorg/ });
  await expect(named).toBeVisible();

  await enter(page, "B2", "Central");
  await expectCell(other, "B2", "Central");

  await named.click();
  await expect(page.getByText(/Viewing the version from/)).toBeVisible();
  await page.getByRole("button", { name: "Restore this version" }).click();
  await expect(page.getByText(/Viewing the version from/)).toBeHidden();
  await expectCell(page, "B2", "East");
  await expectCell(other, "B2", "East");
  await expect(other.getByRole("status").filter({ hasText: "restored an earlier version" })).toBeVisible();
});
