import { describe, expect, it } from "vitest";
import { Sheet } from "../testkit.ts";
import {
  FormulaError,
  colIndex,
  colName,
  displayInput,
  parseA1,
  parseCanonical,
  shiftInput,
  toA1,
  toCanonical,
} from "./parse.ts";

describe("column names", () => {
  it("converts both ways", () => {
    expect(colName(0)).toBe("A");
    expect(colName(25)).toBe("Z");
    expect(colName(26)).toBe("AA");
    expect(colName(701)).toBe("ZZ");
    expect(colName(702)).toBe("AAA");
    for (let i = 0; i < 3000; i++) expect(colIndex(colName(i))).toBe(i);
  });
});

describe("parser", () => {
  const s = new Sheet();
  s.addTab("Data");
  s.addTab("My Sheet");
  s.addTab("Q1");
  const home = s.tab().id;
  const roundTrip = (src: string) => toA1(parseCanonical(toCanonical(parseA1(src, s.doc, home))), s.doc, home);

  it.each([
    ["A1+B2*3", "A1+B2*3"],
    ["sum(a1:b10)", "SUM(A1:B10)"],
    ["$A$1+A$1+$A1", "$A$1+A$1+$A1"],
    ["SUM(A:A)", "SUM(A:A)"],
    ["SUM($B:C)", "SUM($B:C)"],
    ["SUM(2:4)", "SUM(2:4)"],
    ["SUM(A2:B)", "SUM(A2:B)"],
    ["Data!A1", "Data!A1"],
    ["data!a1", "Data!A1"],
    ["'My Sheet'!B2:C3", "'My Sheet'!B2:C3"],
    ["'Q1'!A1", "'Q1'!A1"],
    ['"a""b"&C1', '"a""b"&C1'],
    ["IF(A1>0,,1)", "IF(A1>0,,1)"],
    ["-2^2", "-2^2"],
    ["(1+2)*3", "(1+2)*3"],
    ["{1,2;3,-4}", "{1,2;3,-4}"],
    ["50%", "50%"],
    ["1E+21+0.5", "1E+21+0.5"],
    ["#N/A", "#N/A"],
    ["LOG10(100)", "LOG10(100)"],
    ["STDEV.S(A1:A3)", "STDEV.S(A1:A3)"],
    ["  A1  +  1 ", "A1+1"],
    ["A1<>B1", "A1<>B1"],
    ["TRUE", "TRUE"],
    ["true()", "TRUE()"],
  ])("round trips %s", (src, out) => {
    expect(roundTrip(src)).toBe(out);
  });

  it("turns missing cells and sheets into #REF!", () => {
    expect(roundTrip("A100")).toBe("#REF!");
    expect(roundTrip("Nope!A1")).toBe("#REF!");
    expect(roundTrip("SUM(A1:K1)")).toBe("SUM(#REF!)");
  });

  it.each(["SUM(", "1+", "A1 B1", '"abc', "#WHAT", "{A1}", "1+*2", "SUM(1,2", "{1,2;3}", "[x|y|z]", "A1:"])("rejects %s", (src) => {
    expect(() => parseA1(src, s.doc, home)).toThrow(FormulaError);
  });

  it("stores references by id, not by position", () => {
    const canonical = toCanonical(parseA1("A1+Data!B2", s.doc, home));
    expect(canonical).not.toContain("A1");
    expect(canonical).toMatch(/^\[\|[0-9a-z]+\|[0-9a-z]+\]\+\[[0-9a-z]+\|[0-9a-z]+\|[0-9a-z]+\]$/);
  });
});

describe("references follow the structure", () => {
  it("keeps pointing at the same cell when rows are inserted above", () => {
    const s = new Sheet();
    s.set("A5", 10).set("B1", "=A5*2");
    s.insertRows(0, 2);
    expect(s.formula("B3")).toBe("=A7*2");
    expect(s.get("B3")).toBe(20);
  });

  it("grows a range when rows are inserted inside it", () => {
    const s = new Sheet();
    s.fill([[1], [2], [3]]).set("C1", "=SUM(A1:A3)");
    s.insertRows(1);
    expect(s.formula("C1")).toBe("=SUM(A1:A4)");
    s.set("A2", 10);
    expect(s.get("C1")).toBe(16);
  });

  it("shrinks a range when its end row is deleted", () => {
    const s = new Sheet();
    s.fill([[1], [2], [3]]).set("C5", "=SUM(A1:A3)");
    s.removeRows(2);
    expect(s.formula("C4")).toBe("=SUM(A1:A2)");
    expect(s.get("C4")).toBe(3);
  });

  it("shows #REF! for a deleted cell and recovers when it is restored", () => {
    const s = new Sheet();
    s.set("A2", 7).set("B5", "=A2+1");
    const ids = s.removeRows(1);
    expect(s.formula("B4")).toBe("=#REF!+1");
    expect(s.get("B4")).toMatchObject({ code: "#REF!" });
    s.apply({ t: "restore", tab: s.tab().id, axis: "row", ids });
    expect(s.formula("B5")).toBe("=A2+1");
    expect(s.get("B5")).toBe(8);
  });

  it("follows inserted and deleted columns", () => {
    const s = new Sheet();
    s.fill([[1, 2, 3]]).set("E3", "=SUM(A1:C1)*C1");
    s.insertCols(1);
    expect(s.formula("F3")).toBe("=SUM(A1:D1)*D1");
    s.removeCols(0);
    expect(s.formula("E3")).toBe("=SUM(A1:C1)*C1");
    expect(s.get("E3")).toBe(15);
  });

  it("renders a renamed sheet in formulas", () => {
    const s = new Sheet();
    const data = s.addTab("Data");
    s.set("A1", 4, "Data").set("A1", "=Data!A1*2");
    s.apply({ t: "renameTab", id: data.id, name: "Numbers 2026" });
    expect(s.formula("A1")).toBe("='Numbers 2026'!A1*2");
    expect(s.get("A1")).toBe(8);
  });
});

describe("shifting formulas for copy and fill", () => {
  it("moves relative parts and keeps absolute parts", () => {
    const s = new Sheet();
    s.set("C1", "=A1+$B$1+A$1+$A1");
    const [tab, row, col] = s.ids("C1");
    const input = s.doc.tab(tab)!.input(row, col)!;
    expect(displayInput(shiftInput(input, s.doc, tab, tab, 2, 1), s.doc, tab)).toBe("=B3+$B$1+B$1+$A3");
    expect(displayInput(shiftInput(input, s.doc, tab, tab, -1, 0), s.doc, tab)).toBe("=#REF!+$B$1+A$1+#REF!");
  });

  it("shifts both ends of a range", () => {
    const s = new Sheet();
    s.set("D1", "=SUM(A1:B2)+SUM($A$1:A1)+SUM(A:A)");
    const [tab, row, col] = s.ids("D1");
    const input = s.doc.tab(tab)!.input(row, col)!;
    expect(displayInput(shiftInput(input, s.doc, tab, tab, 3, 1), s.doc, tab)).toBe("=SUM(B4:C5)+SUM($A$1:B4)+SUM(B:B)");
  });

  it("points same sheet references at the destination sheet", () => {
    const s = new Sheet();
    const other = s.addTab("Other");
    s.set("B1", "=A1*2");
    const [tab, row, col] = s.ids("B1");
    const input = s.doc.tab(tab)!.input(row, col)!;
    const moved = shiftInput(input, s.doc, tab, other.id, 0, 0);
    expect(displayInput(moved, s.doc, other.id)).toBe("=A1*2");
    const [, orow, ocol] = s.ids("A1", "Other");
    s.apply({ t: "set", tab: other.id, cells: [[orow, ocol, "21"], [s.ids("B1", "Other")[1], s.ids("B1", "Other")[2], moved]] });
    expect(s.get("B1", "Other")).toBe(42);
  });
});
