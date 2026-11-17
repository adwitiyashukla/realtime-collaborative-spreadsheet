import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { detectDelimiter, parseCsv, toCsv } from "./csv.ts";

describe("csv", () => {
  it("parses quotes, escaped quotes and line breaks inside fields", () => {
    expect(parseCsv('a,"b ""x"" c",d\r\n1,"2\n3",\n')).toEqual([
      ["a", 'b "x" c', "d"],
      ["1", "2\n3", ""],
    ]);
  });

  it("handles a byte order mark, empty lines and a missing final newline", () => {
    expect(parseCsv("\uFEFFname,age\n\nann,30")).toEqual([["name", "age"], [""], ["ann", "30"]]);
    expect(parseCsv("")).toEqual([]);
    expect(parseCsv("x")).toEqual([["x"]]);
    expect(parseCsv(",")).toEqual([["", ""]]);
  });

  it("detects the delimiter from the first line", () => {
    expect(detectDelimiter("a;b;c\n1,2;3")).toBe(";");
    expect(detectDelimiter("a\tb\n")).toBe("\t");
    expect(detectDelimiter('"x,y";z\n')).toBe(";");
    expect(parseCsv("a;b\n1;2")).toEqual([["a", "b"], ["1", "2"]]);
  });

  it("round trips any table", () => {
    const field = fc.string({ unit: fc.constantFrom("a", "b", ",", '"', "\n", "\r", " ", ";", "\t", "x") });
    fc.assert(
      fc.property(fc.array(fc.array(field, { minLength: 1, maxLength: 5 }), { minLength: 1, maxLength: 6 }), (rows) => {
        expect(parseCsv(toCsv(rows), ",")).toEqual(rows);
      }),
      { numRuns: 1000 },
    );
  });
});
