import { type Browser, type Page, expect } from "@playwright/test";

export async function openDemo(page: Page): Promise<string> {
  await page.goto("/");
  await page.getByRole("button", { name: "Try it with a demo sheet" }).click();
  await page.waitForURL(/\/s\//);
  await expect(page.getByText("All changes saved")).toBeVisible();
  return page.url();
}

export async function openBlank(page: Page): Promise<string> {
  const demo = await openDemo(page);
  await page.getByRole("button", { name: "File" }).click();
  await page.getByRole("menuitem", { name: "New spreadsheet" }).click();
  await page.waitForURL((url) => url.href !== demo && url.pathname.startsWith("/s/"));
  await expect(page.getByText("All changes saved")).toBeVisible();
  return page.url();
}

export async function share(page: Page, access: "viewer" | "editor"): Promise<void> {
  await page.getByRole("button", { name: "Share" }).click();
  await page.getByLabel("Anyone with the link").selectOption(access);
  await expect(page.getByLabel("Anyone with the link")).toHaveValue(access);
  await page.getByRole("button", { name: "Close", exact: true }).click();
}

export async function joinAsGuest(browser: Browser, url: string): Promise<Page> {
  const page = await (await browser.newContext()).newPage();
  await page.goto(url);
  await page.getByRole("button", { name: "Continue as a guest" }).click();
  await expect(page.getByRole("application")).toBeVisible();
  return page;
}

export async function select(page: Page, ref: string): Promise<void> {
  const box = page.getByLabel("Cell reference");
  await box.click();
  await box.fill(ref);
  await box.press("Enter");
}

export async function enter(page: Page, ref: string, text: string): Promise<void> {
  await select(page, ref);
  await page.keyboard.type(text);
  await page.keyboard.press("Enter");
}

export async function expectCell(page: Page, ref: string, text: string): Promise<void> {
  await select(page, ref);
  await expect(page.locator(".grid-wrap .sr-only")).toHaveText(`${ref}, ${text}`);
}

export async function cellCenter(page: Page, col: number, row: number): Promise<{ x: number; y: number }> {
  const box = (await page.getByRole("application").boundingBox())!;
  return { x: box.x + 46 + col * 100 + 50, y: box.y + 24 + row * 22 + 11 };
}
