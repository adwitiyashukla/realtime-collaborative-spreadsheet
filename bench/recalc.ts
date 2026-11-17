import { loadConfig } from "../server/config.ts";
import { Calc } from "../shared/calc/engine.ts";
import { idMaker } from "../shared/ids.ts";
import { Doc, newDoc } from "../shared/model.ts";
import { machine, ms, save, stats, table } from "./util.ts";

const rows = loadConfig().bench.recalc_rows;
const next = idMaker("bench");
const doc = newDoc(rows, 6, next);
const tab = doc.liveTabs()[0];
const [A, B, C, D] = tab.cols.live;
const ref = (col: string, row: string) => `[|${col}|${row}]`;
const whole = (col: string) => `[|${col}||${col}|]`;

const cells: [string, string, string][] = [];
for (let i = 0; i < rows; i++) {
  const r = tab.rows.idAt(i)!;
  cells.push([r, A, String((i * 37) % 1000)]);
  cells.push([r, B, `=${ref(A, r)}*1.07`]);
  cells.push([r, C, `=${ref(B, r)}+${ref(A, r)}`]);
}
const top = (i: number) => tab.rows.idAt(i)!;
cells.push([top(0), D, `=SUM(${whole(C)})`]);
cells.push([top(1), D, `=AVERAGE(${whole(A)})`]);
cells.push([top(2), D, `=COUNTIF(${whole(A)},">500")`]);
cells.push([top(3), D, `=SUMIF(${whole(A)},">500",${whole(B)})`]);

let t = performance.now();
doc.apply({ t: "set", tab: tab.id, cells });
const loadMs = performance.now() - t;

const calc = new Calc(doc);
t = performance.now();
const formulas = calc.recalc();
const fullMs = performance.now() - t;

const edits: number[] = [];
for (let k = 0; k < 50; k++) {
  const row = top(Math.floor(((k + 1) * rows) / 52));
  t = performance.now();
  const res = doc.apply({ t: "set", tab: tab.id, cells: [[row, A, String(k)]] });
  calc.apply(res.changes);
  calc.recalc();
  edits.push(performance.now() - t);
}

const inserts: number[] = [];
for (let k = 0; k < 10; k++) {
  t = performance.now();
  const res = doc.apply({ t: "insert", tab: tab.id, axis: "row", before: top(Math.floor(rows / 2)), ids: [next()] });
  calc.apply(res.changes);
  calc.recalc();
  inserts.push(performance.now() - t);
}

t = performance.now();
const json = JSON.stringify(doc.toJSON());
const saveMs = performance.now() - t;
t = performance.now();
const copy = new Calc(Doc.fromJSON(JSON.parse(json)));
copy.recalc();
const openMs = performance.now() - t;

const edit = stats(edits);
const insert = stats(inserts);
console.log(`Recalc benchmark on ${machine()}`);
console.log(`${rows} rows, ${formulas} formulas, sheet size ${(json.length / 1e6).toFixed(1)} MB as JSON\n`);
table([
  ["step", "median", "p95"],
  ["load the cells into the model", ms(loadMs), ""],
  ["recalculate every formula", ms(fullMs), ""],
  ["edit one input cell", ms(edit.p50), ms(edit.p95)],
  ["insert a row in the middle", ms(insert.p50), ms(insert.p95)],
  ["save the sheet as JSON", ms(saveMs), ""],
  ["open the sheet from JSON", ms(openMs), ""],
]);
save("recalc", { rows, formulas, loadMs, fullMs, edit, insert, saveMs, openMs, bytes: json.length });
