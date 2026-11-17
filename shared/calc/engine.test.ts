import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { Doc } from "../model.ts";
import { Sheet } from "../testkit.ts";
import { Calc } from "./engine.ts";
import { cellName } from "./parse.ts";
import { CellError, type Scalar } from "./values.ts";

const plain = (v: Scalar) => (v instanceof CellError ? v.code : v);

describe("recalculation", () => {
  it("updates a chain of dependents", () => {
    const s = new Sheet();
    s.set("A1", 1).set("A2", "=A1+1").set("A3", "=A2*10").set("B1", "=SUM(A1:A3)");
    expect(s.get("B1")).toBe(23);
    s.set("A1", 5);
    expect([s.get("A2"), s.get("A3"), s.get("B1")]).toEqual([6, 60, 71]);
  });

  it("evaluates each cell of a diamond once", () => {
    const s = new Sheet();
    s.set("A1", 2).set("B1", "=A1*2").set("C1", "=A1*3").set("D1", "=B1+C1");
    s.set("A1", 3);
    expect(s.get("D1")).toBe(15);
    const [tab, row, col] = s.ids("A1");
    const { changes } = s.doc.apply({ t: "set", tab, cells: [[row, col, "4"]] });
    s.calc.apply(changes);
    expect(s.calc.recalc()).toBe(3);
    expect(s.get("D1")).toBe(20);
  });

  it("only touches the cells that depend on a change", () => {
    const s = new Sheet(200, 4);
    const rows = Array.from({ length: 200 }, (_, i) => [i + 1, `=A${i + 1}*2`]);
    s.fill(rows);
    const [tab, row, col] = s.ids("A7");
    const { changes } = s.doc.apply({ t: "set", tab, cells: [[row, col, "100"]] });
    s.calc.apply(changes);
    expect(s.calc.recalc()).toBe(1);
    expect(s.get("B7")).toBe(200);
  });

  it("detects a cycle and recovers when it is broken", () => {
    const s = new Sheet();
    s.set("A1", "=B1+1").set("B1", "=A1+1").set("C1", "=A1*2").set("D1", "=IFERROR(C1,0)");
    expect([plain(s.get("A1")), plain(s.get("B1")), plain(s.get("C1")), s.get("D1")]).toEqual(["#CYCLE!", "#CYCLE!", "#CYCLE!", 0]);
    s.set("B1", 5);
    expect([s.get("A1"), s.get("C1"), s.get("D1")]).toEqual([6, 12, 12]);
  });

  it("detects self references and cycles through ranges", () => {
    const s = new Sheet();
    s.set("A1", "=A1+1").set("B5", "=SUM(B1:B10)");
    expect(plain(s.get("A1"))).toBe("#CYCLE!");
    expect(plain(s.get("B5"))).toBe("#CYCLE!");
    s.set("B5", 3);
    s.set("C1", "=SUM(B1:B10)");
    expect(s.get("C1")).toBe(3);
  });

  it("handles a chain 100000 cells deep without recursion", () => {
    const s = new Sheet(100000, 2);
    const tab = s.tab();
    const cells: [string, string, string][] = [[tab.rows.idAt(0)!, tab.cols.idAt(0)!, "1"]];
    for (let i = 1; i < 100000; i++) {
      cells.push([tab.rows.idAt(i)!, tab.cols.idAt(0)!, `=[|${tab.cols.idAt(0)}|${tab.rows.idAt(i - 1)}]+1`]);
    }
    s.apply({ t: "set", tab: tab.id, cells });
    expect(s.get("A100000")).toBe(100000);
    s.set("A1", 11);
    expect(s.get("A100000")).toBe(100010);
  });

  it("recalculates ranges when rows move", () => {
    const s = new Sheet();
    s.fill([[1], [2], [3]]).set("C1", "=SUM(A1:A3)").set("D1", "=ROWS(A1:A3)").set("E1", "=ROW(A3)");
    s.insertRows(1, 2);
    expect([s.get("C1"), s.get("D1"), s.get("E1")]).toEqual([6, 5, 5]);
    s.removeRows(1);
    expect([s.get("C1"), s.get("D1"), s.get("E1")]).toEqual([6, 4, 4]);
  });

  it("follows other sheets and their deletion", () => {
    const s = new Sheet();
    const data = s.addTab("Data");
    s.set("A1", 10, "Data").set("A2", 20, "Data").set("A1", "=SUM(Data!A1:A2)+Data!A1");
    expect(s.get("A1")).toBe(40);
    s.set("A2", 25, "Data");
    expect(s.get("A1")).toBe(45);
    s.apply({ t: "removeTab", id: data.id });
    expect(plain(s.get("A1"))).toBe("#REF!");
    s.apply({ t: "restoreTab", id: data.id });
    expect(s.get("A1")).toBe(45);
  });

  it("gives every client the same random numbers for the same version", () => {
    const s = new Sheet();
    s.set("A1", "=RAND()");
    const copy = new Calc(Doc.fromJSON(s.doc.toJSON()));
    copy.recalc();
    const [tab, row, col] = s.ids("A1");
    expect(copy.value(tab, row, col)).toBe(s.get("A1"));
    s.calc.seed = 7;
    s.set("B1", 1);
    expect(s.get("A1")).not.toBe(copy.value(tab, row, col));
  });
});

const SIZE = 6;

type Step =
  | { kind: "num"; r: number; c: number; v: number }
  | { kind: "clear"; r: number; c: number }
  | { kind: "formula"; r: number; c: number; t: number; refs: number[] }
  | { kind: "insert"; axis: "row" | "col"; at: number }
  | { kind: "remove"; axis: "row" | "col"; at: number }
  | { kind: "restore" };

const cell = fc.integer({ min: 0, max: SIZE - 1 });
const step: fc.Arbitrary<Step> = fc.oneof(
  { weight: 4, arbitrary: fc.record({ kind: fc.constant("num" as const), r: cell, c: cell, v: fc.integer({ min: -9, max: 9 }) }) },
  { weight: 1, arbitrary: fc.record({ kind: fc.constant("clear" as const), r: cell, c: cell }) },
  {
    weight: 6,
    arbitrary: fc.record({
      kind: fc.constant("formula" as const),
      r: cell,
      c: cell,
      t: fc.integer({ min: 0, max: 7 }),
      refs: fc.array(cell, { minLength: 6, maxLength: 6 }),
    }),
  },
  { weight: 1, arbitrary: fc.record({ kind: fc.constant("insert" as const), axis: fc.constantFrom("row" as const, "col" as const), at: cell }) },
  { weight: 1, arbitrary: fc.record({ kind: fc.constant("remove" as const), axis: fc.constantFrom("row" as const, "col" as const), at: cell }) },
  { weight: 1, arbitrary: fc.record({ kind: fc.constant("restore" as const) }) },
);

function formulaText(t: number, refs: number[]): string {
  const ref = (i: number) => cellName(refs[i], refs[i + 1]);
  const range = `${cellName(Math.min(refs[0], refs[2]), Math.min(refs[1], refs[3]))}:${cellName(Math.max(refs[0], refs[2]), Math.max(refs[1], refs[3]))}`;
  switch (t) {
    case 0:
      return `=${ref(0)}+${ref(2)}`;
    case 1:
      return `=${ref(0)}*2-${ref(4)}`;
    case 2:
      return `=SUM(${range})`;
    case 3:
      return `=IF(${ref(0)}>0,${ref(2)},${ref(4)})`;
    case 4:
      return `=COUNTIF(${range},">0")`;
    case 5:
      return `=MAX(${range})+${ref(4)}`;
    case 6:
      return `=IFERROR(${ref(0)},-1)`;
    default:
      return `=ROWS(${range})*${ref(4)}`;
  }
}

describe("incremental recalculation matches a full recalculation", () => {
  it("for random edits, structure changes and cycles", () => {
    fc.assert(
      fc.property(fc.array(step, { minLength: 1, maxLength: 40 }), (steps) => {
        const s = new Sheet(SIZE, SIZE);
        const removed: { axis: "row" | "col"; ids: string[] }[] = [];
        const tab = s.tab();
        for (const st of steps) {
          if (st.kind === "num" || st.kind === "clear" || st.kind === "formula") {
            const r = Math.min(st.r, tab.rows.count - 1);
            const c = Math.min(st.c, tab.cols.count - 1);
            const input = st.kind === "num" ? st.v : st.kind === "clear" ? null : formulaText(st.t, st.refs);
            s.set(cellName(c, r), input);
          } else if (st.kind === "insert") {
            if (st.axis === "row") s.insertRows(Math.min(st.at, tab.rows.count));
            else s.insertCols(Math.min(st.at, tab.cols.count));
          } else if (st.kind === "remove") {
            const axis = st.axis === "row" ? tab.rows : tab.cols;
            if (axis.count <= 2) continue;
            const ids = st.axis === "row" ? s.removeRows(Math.min(st.at, axis.count - 1)) : s.removeCols(Math.min(st.at, axis.count - 1));
            removed.push({ axis: st.axis, ids });
          } else {
            const last = removed.pop();
            if (last) s.apply({ t: "restore", tab: tab.id, axis: last.axis, ids: last.ids });
          }
          const fresh = new Calc(Doc.fromJSON(s.doc.toJSON()));
          fresh.now = s.calc.now;
          fresh.recalc();
          for (const row of tab.rows.live) {
            for (const col of tab.cols.live) {
              expect(plain(s.calc.value(tab.id, row, col))).toEqual(plain(fresh.value(tab.id, row, col)));
            }
          }
        }
      }),
      { numRuns: 300 },
    );
  });
});
