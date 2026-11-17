import { type WebSocketRoute, expect, test } from "@playwright/test";
import { enter, expectCell, joinAsGuest, openDemo, select, share } from "./helpers.ts";

test("two people see each other's edits", async ({ page, browser }) => {
  const url = await openDemo(page);
  await share(page, "editor");
  const other = await joinAsGuest(browser, url);
  await expect(page.locator('[aria-label="People in this sheet"] .avatar')).toHaveCount(1);

  await enter(page, "J2", "=SUM(G2:G21)");
  await expectCell(page, "J2", "80195, formula =SUM(G2:G21)");
  await expectCell(other, "J2", "80195, formula =SUM(G2:G21)");

  await enter(other, "E2", "10");
  await expectCell(page, "G2", "$12,500.00, formula =E2*F2");
  await expectCell(page, "J2", "87695, formula =SUM(G2:G21)");
  await page.getByRole("tab", { name: "Summary" }).click();
  await expectCell(page, "B2", "$87,695.00, formula =SUM(Sales!G2:G21)");
});

test("a viewer can look but not change anything", async ({ page, browser }) => {
  const url = await openDemo(page);
  await share(page, "viewer");
  const viewer = await joinAsGuest(browser, url);
  await expect(viewer.getByText("View only")).toBeVisible();
  await select(viewer, "B2");
  await viewer.keyboard.type("x");
  await expect(viewer.getByRole("status").filter({ hasText: "This sheet is view only" })).toBeVisible();
  await expectCell(viewer, "B2", "East");

  await enter(page, "B2", "Central");
  await expectCell(viewer, "B2", "Central");
});

test("edits made while offline are saved after reconnecting", async ({ page, browser }) => {
  const url = await openDemo(page);
  await share(page, "editor");
  const context = await browser.newContext();
  let online = true;
  let socket: WebSocketRoute | null = null;
  await context.routeWebSocket(/\/api\/live\//, (ws) => {
    if (!online) return void ws.close();
    socket = ws;
    ws.connectToServer();
  });
  const other = await context.newPage();
  await other.goto(url);
  await other.getByRole("button", { name: "Continue as a guest" }).click();
  await expect(other.getByText("All changes saved")).toBeVisible();

  online = false;
  await socket!.close();
  await expect(other.getByText(/Offline/)).toBeVisible();
  await enter(other, "B3", "Moved");
  await expect(other.getByText(/1 unsaved edit/)).toBeVisible();
  await expectCell(page, "B3", "West");

  online = true;
  await other.evaluate(() => window.dispatchEvent(new Event("online")));
  await expect(other.getByText("All changes saved")).toBeVisible();
  await expectCell(page, "B3", "Moved");
});
