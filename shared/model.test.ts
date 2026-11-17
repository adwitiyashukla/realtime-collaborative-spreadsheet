import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { idMaker } from "./ids.ts";
import { Doc, type Op, checkOp, newDoc, validTabName } from "./model.ts";
import { LIMITS, randomOp, rng } from "./testkit.ts";

const json = (d: Doc) => JSON.stringify(d.toJSON());

describe("document model", () => {
  it("undoes any sequence of ops exactly with the returned inverses", () => {
    fc.assert(
      fc.property(fc.integer(), fc.integer({ min: 1, max: 60 }), (seed, count) => {
        const next = idMaker("m");
        const doc = newDoc(4, 4, next);
        const rnd = rng(seed);
        const start = json(doc);
        const inverses: Op[] = [];
        for (let i = 0; i < count; i++) {
          const op = randomOp(doc, rnd, next);
          expect(checkOp(doc, op, LIMITS)).toBeNull();
          const { inverse } = doc.apply(op);
          if (inverse) inverses.push(inverse);
          expect(json(Doc.fromJSON(doc.toJSON()))).toBe(json(doc));
        }
        for (const inv of inverses.reverse()) doc.apply(inv);
        expect(json(doc)).toBe(start);
      }),
      { numRuns: 400 },
    );
  });

  it("keeps live tab names unique", () => {
    const next = idMaker("n");
    const doc = newDoc(2, 2, next);
    const add = (name: string) => {
      const id = next();
      doc.apply({ t: "addTab", id, name, before: null, rows: [next()], cols: [next()] });
      return id;
    };
    const a = add("Data");
    add("data");
    expect(doc.liveTabs().map((t) => t.name)).toEqual(["Sheet1", "Data", "data (2)"]);
    doc.apply({ t: "removeTab", id: a });
    const c = add("Data");
    doc.apply({ t: "restoreTab", id: a });
    expect(doc.tab(c)!.name).toBe("Data");
    expect(doc.tab(a)!.name).toBe("Data (3)");
  });

  it("rejects invalid ops", () => {
    const next = idMaker("v");
    const doc = newDoc(2, 2, next);
    const tab = doc.liveTabs()[0];
    const [r0, r1] = tab.rows.live;
    const [c0] = tab.cols.live;
    expect(checkOp(doc, { t: "set", tab: "nope", cells: [[r0, c0, "1"]] }, LIMITS)).toBe("unknown tab");
    expect(checkOp(doc, { t: "set", tab: tab.id, cells: [["x", c0, "1"]] }, LIMITS)).toBe("unknown cell");
    expect(checkOp(doc, { t: "set", tab: tab.id, cells: [[r0, c0, "x".repeat(2000)]] }, LIMITS)).toBe("cell too long");
    expect(checkOp(doc, { t: "remove", tab: tab.id, axis: "row", ids: [r0, r1] }, LIMITS)).toBe("cannot remove everything");
    expect(checkOp(doc, { t: "insert", tab: tab.id, axis: "row", before: null, ids: [r0] }, LIMITS)).toBe("bad ids");
    expect(checkOp(doc, { t: "insert", tab: tab.id, axis: "row", before: null, ids: ["a b"] }, LIMITS)).toBe("bad ids");
    expect(checkOp(doc, { t: "removeTab", id: tab.id }, LIMITS)).toBe("cannot remove the last tab");
    expect(checkOp(doc, { t: "renameTab", id: tab.id, name: "a/b" }, LIMITS)).toBe("bad name");
    expect(checkOp(doc, { t: "uninsert", tab: tab.id, axis: "row", ids: [r0] }, LIMITS)).toBe("internal op");
    expect(checkOp(doc, { t: "title", title: "  " }, LIMITS)).toBe("bad title");
  });

  it("checks tab names", () => {
    expect(validTabName("Q1 2026")).toBe(true);
    expect(validTabName(" ")).toBe(false);
    expect(validTabName("a:b")).toBe(false);
    expect(validTabName("'quoted'")).toBe(false);
    expect(validTabName("x".repeat(101))).toBe(false);
  });

  it("serializes cells in row and column order", () => {
    const next = idMaker("s");
    const doc = newDoc(3, 3, next);
    const tab = doc.liveTabs()[0];
    const [r0, r1] = tab.rows.live;
    const [c0, c1] = tab.cols.live;
    doc.apply({ t: "set", tab: tab.id, cells: [[r1, c1, "d"], [r0, c1, "b"], [r1, c0, "c"], [r0, c0, "a"]] });
    expect(doc.toJSON().tabs[0].cells.map((c) => c[2])).toEqual(["a", "b", "c", "d"]);
  });
});
