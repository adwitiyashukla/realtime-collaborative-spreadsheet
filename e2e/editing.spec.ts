import { expect, test } from "@playwright/test";
import { cellCenter, enter, expectCell, openBlank, openDemo, select } from "./helpers.ts";

test("autocomplete, pointing at cells and recalculation", async ({ page }) => {
  await openBlank(page);
  for (const [i, v] of ["4", "8", "15", "16"].entries()) await enter(page, `A${i + 1}`, v);
  await select(page, "C1");
  await page.keyboard.type("=su");
  await expect(page.getByRole("listbox").getByRole("option").first()).toHaveText(/^SUM/);
  await page.keyboard.press("Enter");
  await expect(page.getByLabel("Cell editor")).toHaveValue("=SUM(");
  const from = await cellCenter(page, 0, 0);
  const to = await cellCenter(page, 0, 3);
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(to.x, to.y, { steps: 5 });
  await page.mouse.up();
  await expect(page.getByLabel("Cell editor")).toHaveValue("=SUM(A1:A4");
  await page.keyboard.type(")");
  await page.keyboard.press("Enter");
  await expectCell(page, "C1", "43, formula =SUM(A1:A4)");
  await enter(page, "A2", "100");
  await expectCell(page, "C1", "135, formula =SUM(A1:A4)");
});

test("the fill handle continues a series", async ({ page }) => {
  await openBlank(page);
  await enter(page, "B1", "5");
  await enter(page, "B2", "10");
  await select(page, "B1:B2");
  const corner = await cellCenter(page, 1, 1);
  const target = await cellCenter(page, 1, 5);
  await page.mouse.move(corner.x + 49, corner.y + 10);
  await page.mouse.down();
  await page.mouse.move(target.x + 49, target.y, { steps: 6 });
  await page.mouse.up();
  await expectCell(page, "B4", "20");
  await expectCell(page, "B6", "30");
});

test("inserting rows keeps formulas pointing at the same cells", async ({ page }) => {
  await openDemo(page);
  await enter(page, "L2", "=SUM(G2:G21)");
  const header = (await page.getByRole("application").boundingBox())!;
  await page.mouse.click(header.x + 20, header.y + 24 + 4 * 22 + 11, { button: "right" });
  await page.getByRole("menuitem", { name: "Insert 1 row above" }).click();
  await expectCell(page, "L2", "80195, formula =SUM(G2:G22)");
  await expectCell(page, "A5", "empty");
  await page.keyboard.press("Control+z");
  await expectCell(page, "L2", "80195, formula =SUM(G2:G21)");
});

test("copy and paste moves formulas relative to the new cell", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await openDemo(page);
  await select(page, "G2");
  await page.keyboard.press("Control+c");
  await select(page, "G25");
  await page.keyboard.press("Control+v");
  await expectCell(page, "G25", "$0.00, formula =E25*F25");
  await page.keyboard.press("Control+z");
  await expectCell(page, "G25", "empty");
});
