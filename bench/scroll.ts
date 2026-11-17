import type { AddressInfo } from "node:net";
import { chromium } from "@playwright/test";
import { build } from "vite";
import { buildApp } from "../server/app.ts";
import { loadConfig } from "../server/config.ts";
import { migrate, openDatabase } from "../server/db.ts";
import { compileInput } from "../shared/calc/parse.ts";
import { idMaker, randomId } from "../shared/ids.ts";
import { newDoc } from "../shared/model.ts";
import type { User } from "../shared/protocol.ts";
import { machine, ms, save, stats, table } from "./util.ts";

const config = loadConfig();
const { scroll_rows: rows, scroll_seconds: seconds } = config.bench;
await build({ logLevel: "warn" });
const database = await openDatabase(config.database.url, "memory://");
await migrate(database);
const { app, store } = await buildApp(config, database, false);
await app.listen({ host: "127.0.0.1", port: 0 });
const base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;

const res = await fetch(`${base}/api/auth/guest`, { method: "POST", headers: { "content-type": "application/json", origin: base }, body: "{}" });
const [name, value] = res.headers.getSetCookie()[0].split(";")[0].split("=");
const { user } = (await res.json()) as { user: User };

const doc = newDoc(rows, 10, idMaker("scroll"), "Scroll test");
const tab = doc.liveTabs()[0];
const products = ["Laptop", "Monitor", "Dock", "Headset", "Keyboard"];
const cells: [string, string, string][] = [];
for (let i = 0; i < rows; i++) {
  const r = tab.rows.idAt(i)!;
  const n = i + 1;
  const line = [String(n), products[i % products.length], String(1 + ((i * 7) % 40)), String(10 + ((i * 13) % 500)), `=C${n}*D${n}`, `=E${n}*0.2`, `=IF(E${n}>5000,"big","small")`];
  line.forEach((v, c) => cells.push([r, tab.cols.idAt(c)!, compileInput(v, doc, tab.id)]));
}
doc.apply({ t: "set", tab: tab.id, cells });
const id = randomId(12);
await store.createSheet(id, user.id, doc.toJSON(), "create");

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
await context.addCookies([{ name, value, url: base }]);
await context.addInitScript(() => {
  const w = window as unknown as { raf: typeof requestAnimationFrame; work: number[] };
  const raf = window.requestAnimationFrame.bind(window);
  w.raf = raf;
  w.work = [];
  window.requestAnimationFrame = (cb) =>
    raf((t) => {
      const start = performance.now();
      cb(t);
      w.work.push(performance.now() - start);
    });
});
const page = await context.newPage();
await page.goto(`${base}/s/${id}`);
await page.getByText("All changes saved").waitFor({ timeout: 120000 });
const { frames, work, scrolled } = await page.evaluate(async (seconds) => {
  const w = window as unknown as { raf: typeof requestAnimationFrame; work: number[] };
  const box = document.querySelector<HTMLElement>(".grid-scroller")!;
  const frames: number[] = [];
  w.work = [];
  let scrolled = 0;
  await new Promise<void>((resolve) => {
    const end = performance.now() + seconds * 1000;
    let last = 0;
    const tick = (now: number) => {
      if (last) frames.push(now - last);
      last = now;
      const before = box.scrollTop;
      box.scrollTop = before + 120 >= box.scrollHeight - box.clientHeight ? 0 : before + 120;
      scrolled += Math.abs(box.scrollTop - before);
      if (now < end) w.raf(tick);
      else resolve();
    };
    w.raf(tick);
  });
  return { frames, work: w.work, scrolled };
}, seconds);
await browser.close();
await app.close();
await database.close();

const frame = stats(frames);
const paint = stats(work);
const slow = frames.filter((f) => f > 1000 / 60 + 2).length / frames.length;
console.log(`Scroll benchmark on ${machine()}, headless Chromium at 1440x900 and 2x pixel density`);
console.log(`${rows} rows with 3 formulas each, scrolled ${Math.round(scrolled / 22)} rows in ${seconds} s\n`);
table([
  ["", "median", "p95", "p99"],
  ["time between frames", ms(frame.p50), ms(frame.p95), ms(frame.p99)],
  ["redraw of the visible cells", ms(paint.p50), ms(paint.p95), ms(paint.p99)],
]);
console.log(`\n${frames.length} frames, ${(frames.length / seconds).toFixed(0)} per second, ${(slow * 100).toFixed(1)}% slower than 60 fps`);
save("scroll", { rows, seconds, frame, paint, frames: frames.length, slow });
