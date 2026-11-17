import { readFile } from "node:fs/promises";
import { expect, test } from "@playwright/test";
import { expectCell, openDemo } from "./helpers.ts";

test("a guest can create an account and keep their sheets", async ({ page }) => {
  await openDemo(page);
  await page.goto("/sheets");
  await expect(page.getByText("You are using a guest account")).toBeVisible();
  await page.getByRole("link", { name: "Create an account" }).click();
  const email = `ada${Date.now()}@example.com`;
  await page.getByLabel("Name").fill("Ada Lovelace");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill("analytical-engine");
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page.getByRole("heading", { name: "Your sheets" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Q3 sales tracker" })).toBeVisible();
  await expect(page.getByText("You are using a guest account")).toBeHidden();

  await page.getByRole("button", { name: "Log out" }).click();
  await page.goto("/login");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill("analytical-engine");
  await page.getByRole("button", { name: "Log in" }).click();
  await expect(page.getByRole("link", { name: "Q3 sales tracker" })).toBeVisible();
});

test("csv files import into a new sheet and export back out", async ({ page }) => {
  await openDemo(page);
  await page.goto("/sheets");
  await page.locator('input[type="file"]').setInputFiles({
    name: "scores.csv",
    mimeType: "text/csv",
    buffer: Buffer.from("name,score\nAda,3\nGrace,5\n=1+1,x\n"),
  });
  await page.waitForURL(/\/s\//);
  await expectCell(page, "A2", "Ada");
  await expectCell(page, "B3", "5");
  await expectCell(page, "A4", "=1+1");

  await page.getByRole("button", { name: "File" }).click();
  const download = page.waitForEvent("download");
  await page.getByRole("menuitem", { name: "Download this sheet as CSV" }).click();
  const text = await readFile((await (await download).path())!, "utf8");
  expect(text).toBe("name,score\r\nAda,3\r\nGrace,5\r\n'=1+1,x\r\n");
});

test("the start page fits on a phone", async ({ browser }) => {
  const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const page = await phone.newPage();
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Spreadsheets you edit together, live." })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
});
