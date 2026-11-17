import { compileInput } from "../shared/calc/parse.ts";
import { type Doc, type Style, newDoc } from "../shared/model.ts";

const SALES: [string, string, string, string, number, number][] = [
  ["2026-07-02", "East", "Priya", "Laptop", 4, 1250],
  ["2026-07-05", "West", "Marcus", "Monitor", 12, 310],
  ["2026-07-09", "North", "Elena", "Dock", 25, 95],
  ["2026-07-14", "South", "Jamal", "Laptop", 3, 1250],
  ["2026-07-18", "East", "Priya", "Headset", 40, 60],
  ["2026-07-23", "West", "Sofia", "Laptop", 6, 1250],
  ["2026-07-28", "North", "Elena", "Monitor", 9, 310],
  ["2026-08-03", "South", "Jamal", "Dock", 30, 95],
  ["2026-08-07", "East", "Chen", "Monitor", 15, 310],
  ["2026-08-12", "West", "Marcus", "Headset", 55, 60],
  ["2026-08-16", "North", "Elena", "Laptop", 5, 1250],
  ["2026-08-21", "South", "Sofia", "Monitor", 7, 310],
  ["2026-08-26", "East", "Chen", "Laptop", 8, 1250],
  ["2026-09-01", "West", "Marcus", "Dock", 18, 95],
  ["2026-09-04", "North", "Priya", "Headset", 35, 60],
  ["2026-09-10", "South", "Jamal", "Laptop", 2, 1250],
  ["2026-09-15", "East", "Chen", "Dock", 22, 95],
  ["2026-09-19", "West", "Sofia", "Monitor", 11, 310],
  ["2026-09-24", "North", "Elena", "Laptop", 7, 1250],
  ["2026-09-29", "South", "Jamal", "Headset", 48, 60],
];

function fill(doc: Doc, tabName: string, rows: (string | number)[][], start = 0): void {
  const tab = doc.findTab(tabName)!;
  const cells: [string, string, string | null][] = [];
  rows.forEach((line, r) =>
    line.forEach((v, c) => {
      if (v === "") return;
      const input = typeof v === "number" ? String(v) : compileInput(v, doc, tab.id);
      cells.push([tab.rows.idAt(start + r)!, tab.cols.idAt(c)!, input]);
    }),
  );
  doc.apply({ t: "set", tab: tab.id, cells });
}

function style(doc: Doc, tabName: string, rows: [number, number], cols: [number, number], s: Style): void {
  const tab = doc.findTab(tabName)!;
  const cells: [string, string, Style][] = [];
  for (let r = rows[0]; r <= rows[1]; r++) {
    for (let c = cols[0]; c <= cols[1]; c++) cells.push([tab.rows.idAt(r)!, tab.cols.idAt(c)!, s]);
  }
  doc.apply({ t: "style", tab: tab.id, cells });
}

function widths(doc: Doc, tabName: string, px: number[]): void {
  const tab = doc.findTab(tabName)!;
  doc.apply({ t: "resize", tab: tab.id, axis: "col", sizes: px.map((w, i): [string, number] => [tab.cols.idAt(i)!, w]) });
}

export function demoDoc(nextId: () => string, rows: number, cols: number): Doc {
  const doc = newDoc(rows, cols, nextId, "Q3 sales tracker");
  const first = doc.liveTabs()[0];
  doc.apply({ t: "renameTab", id: first.id, name: "Sales" });
  doc.apply({
    t: "addTab",
    id: nextId(),
    name: "Summary",
    before: null,
    rows: Array.from({ length: 100 }, nextId),
    cols: Array.from({ length: 12 }, nextId),
  });

  const n = SALES.length + 1;
  fill(doc, "Sales", [
    ["Date", "Region", "Rep", "Product", "Units", "Unit price", "Revenue", "Commission"],
    ...SALES.map(([date, region, rep, product, units, price], i) => [
      date,
      region,
      rep,
      product,
      units,
      price,
      `=E${i + 2}*F${i + 2}`,
      `=IF(G${i + 2}>=5000,G${i + 2}*6%,G${i + 2}*4%)`,
    ]),
  ]);
  style(doc, "Sales", [0, 0], [0, 7], { b: true, bg: "#e6f4ea" });
  style(doc, "Sales", [1, n - 1], [5, 7], { nf: "currency:2" });
  widths(doc, "Sales", [110, 90, 90, 100, 70, 100, 110, 110]);

  const range = (col: string) => `Sales!${col}2:${col}${n}`;
  fill(doc, "Summary", [
    ["Q3 summary", ""],
    ["Total revenue", `=SUM(${range("G")})`],
    ["Units sold", `=SUM(${range("E")})`],
    ["Average order", `=AVERAGE(${range("G")})`],
    ["Largest order", `=MAX(${range("G")})`],
    ["Orders over $5,000", `=COUNTIF(${range("G")},">=5000")`],
    ["Top order by", `=INDEX(${range("C")},MATCH(MAX(${range("G")}),${range("G")},0))`],
    ["", ""],
    ["Region", "Revenue", "Share", "Orders"],
    ...["East", "West", "North", "South"].map((region, i) => [
      region,
      `=SUMIF(${range("B")},A${10 + i},${range("G")})`,
      `=B${10 + i}/$B$2`,
      `=COUNTIF(${range("B")},A${10 + i})`,
    ]),
    ["", ""],
    ["Price lookup", "Laptop"],
    ["Unit price", `=XLOOKUP(B15,${range("D")},${range("F")},"not found")`],
    ["Product units sold", `=SUMIF(${range("D")},B15,${range("E")})`],
  ]);
  style(doc, "Summary", [0, 0], [0, 0], { b: true });
  style(doc, "Summary", [8, 8], [0, 3], { b: true, bg: "#e6f4ea" });
  style(doc, "Summary", [1, 1], [1, 1], { nf: "currency:2", b: true });
  style(doc, "Summary", [3, 4], [1, 1], { nf: "currency:2" });
  style(doc, "Summary", [9, 12], [1, 1], { nf: "currency:0" });
  style(doc, "Summary", [9, 12], [2, 2], { nf: "percent:1" });
  style(doc, "Summary", [15, 15], [1, 1], { nf: "currency:2" });
  style(doc, "Summary", [14, 14], [1, 1], { bg: "#fef7e0" });
  widths(doc, "Summary", [150, 120, 90, 80]);
  return doc;
}
