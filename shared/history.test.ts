import { describe, expect, it } from "vitest";
import { History, describe as describeOp } from "./history.ts";
import { idMaker } from "./ids.ts";
import { type Op, newDoc } from "./model.ts";

function setup() {
  const doc = newDoc(3, 3, idMaker("h"));
  const tab = doc.liveTabs()[0];
  const history = new History();
  const mine = (op: Op) => {
    const item = describeOp(doc, op);
    doc.apply(op);
    if (item) history.push([item]);
  };
  const apply = (op: Op) => {
    doc.apply(op);
  };
  const [r0, r1] = tab.rows.live;
  const [c0, c1] = tab.cols.live;
  return { doc, tab, history, mine, apply, r0, r1, c0, c1 };
}

describe("undo and redo", () => {
  it("restores values both ways", () => {
    const { tab, history, mine, apply, doc, r0, c0 } = setup();
    mine({ t: "set", tab: tab.id, cells: [[r0, c0, "1"]] });
    mine({ t: "set", tab: tab.id, cells: [[r0, c0, "2"]] });
    expect(history.undo(doc, apply)).toBe(true);
    expect(tab.input(r0, c0)).toBe("1");
    history.undo(doc, apply);
    expect(tab.input(r0, c0)).toBeNull();
    expect(history.undo(doc, apply)).toBe(false);
    history.redo(doc, apply);
    history.redo(doc, apply);
    expect(tab.input(r0, c0)).toBe("2");
  });

  it("leaves cells alone that someone else changed afterwards", () => {
    const { tab, history, mine, apply, doc, r0, r1, c0 } = setup();
    mine({ t: "set", tab: tab.id, cells: [[r0, c0, "mine"], [r1, c0, "mine too"]] });
    apply({ t: "set", tab: tab.id, cells: [[r0, c0, "theirs"]] });
    history.undo(doc, apply);
    expect(tab.input(r0, c0)).toBe("theirs");
    expect(tab.input(r1, c0)).toBeNull();
  });

  it("undoes structure, styles, sizes and tabs", () => {
    const { tab, history, mine, apply, doc, r0, c0, c1 } = setup();
    mine({ t: "insert", tab: tab.id, axis: "row", before: r0, ids: ["new1"] });
    mine({ t: "style", tab: tab.id, cells: [[r0, c0, { b: true, bg: "#ff0000" }]] });
    mine({ t: "resize", tab: tab.id, axis: "col", sizes: [[c1, 240]] });
    mine({ t: "addTab", id: "tab2", name: "Two", before: null, rows: ["x1"], cols: ["y1"] });
    mine({ t: "renameTab", id: "tab2", name: "Renamed" });
    mine({ t: "title", title: "Budget" });
    for (let i = 0; i < 6; i++) history.undo(doc, apply);
    expect(doc.title).toBe("Untitled spreadsheet");
    expect(doc.tab("tab2")!.dead).toBe(true);
    expect(doc.tab("tab2")!.name).toBe("Two");
    expect(tab.cols.sizes.has(c1)).toBe(false);
    expect(tab.cell(r0, c0)).toBeUndefined();
    expect(tab.rows.isLive("new1")).toBe(false);
    for (let i = 0; i < 6; i++) history.redo(doc, apply);
    expect(doc.title).toBe("Budget");
    expect(doc.tab("tab2")!.name).toBe("Renamed");
    expect(tab.cell(r0, c0)!.s).toEqual({ b: true, bg: "#ff0000" });
    expect(tab.rows.isLive("new1")).toBe(true);
  });

  it("forgets the redo stack after a new edit", () => {
    const { tab, history, mine, apply, doc, r0, c0 } = setup();
    mine({ t: "set", tab: tab.id, cells: [[r0, c0, "1"]] });
    history.undo(doc, apply);
    mine({ t: "set", tab: tab.id, cells: [[r0, c0, "3"]] });
    expect(history.canRedo).toBe(false);
  });
});
