import { describe, expect, it } from "vitest";
import { Sheet } from "../testkit.ts";
import { FUNCTIONS } from "./functions.ts";
import { CellError, type Scalar } from "./values.ts";

const s = new Sheet(40, 10);
s.fill([
  ["Name", "Dept", "Salary", "Start", "Active"],
  ["Ann", "Eng", 120000, "2021-03-15", true],
  ["Bob", "Sales", 80000, "2019-07-01", true],
  ["Cid", "Eng", 95000, "2023-01-09", false],
  ["Dee", "Ops", 70000, "2020-11-30", true],
  ["Eve", "Eng", 135000, "2018-05-20", true],
]);

const plain = (v: Scalar) => (v instanceof CellError ? v.code : v);

const cases: [string, Scalar][] = [
  ["=1+2*3", 7],
  ["=(1+2)*3", 9],
  ["=-2^2", 4],
  ["=2^3^2", 64],
  ["=2^-1", 0.5],
  ["=10/4", 2.5],
  ["=1/0", "#DIV/0!"],
  ['="a"&1+1', "a2"],
  ["=1=1", true],
  ['="A"="a"', true],
  ['=1<"a"', true],
  ["=TRUE>1", true],
  ["=0.1+0.2=0.3", true],
  ["=0.1+0.2-0.3", 0],
  ["=50%", 0.5],
  ['="3"+4', 7],
  ['="x"+1', "#VALUE!"],
  ['=SUM("3",4)', 7],
  ["=SUM(A1)", 0],
  ["=SUM(1/0,1)", "#DIV/0!"],
  ["=A1:A3", "#VALUE!"],
  ['="a"&TRUE', "aTRUE"],
  ['=1/3&""', "0.333333333333333"],
  ["=SUM(C2:C6)", 500000],
  ["=AVERAGE(C2:C6)", 100000],
  ["=COUNT(C:C)", 5],
  ["=COUNTA(A:A)", 6],
  ["=COUNTBLANK(A1:A10)", 4],
  ['=COUNT(1,"2","x",TRUE)', 3],
  ["=MAX(C2:C6)", 135000],
  ["=MIN(C2:C6)", 70000],
  ["=MEDIAN(C2:C6)", 95000],
  ['=SUMIF(B2:B6,"Eng",C2:C6)', 350000],
  ['=SUMIF(C2:C6,">90000")', 350000],
  ['=COUNTIF(B2:B6,"Eng")', 3],
  ['=COUNTIF(B2:B6,"eng")', 3],
  ['=COUNTIF(C2:C6,">=95000")', 3],
  ['=COUNTIF(B2:B6,"<>Eng")', 2],
  ['=COUNTIF(A1:A10,"")', 4],
  ['=COUNTIF(A2:A6,"?e?")', 1],
  ['=COUNTIF({"apple","apricot","banana"},"ap*")', 2],
  ['=SUMIFS(C2:C6,B2:B6,"Eng",E2:E6,TRUE)', 255000],
  ['=COUNTIFS(B2:B6,"Eng",C2:C6,">100000")', 2],
  ['=MAXIFS(C2:C6,B2:B6,"Eng")', 135000],
  ['=MINIFS(C2:C6,B2:B6,"Eng")', 95000],
  ['=ROUND(AVERAGEIF(B2:B6,"Eng",C2:C6),0)', 116667],
  ['=AVERAGEIFS(C2:C6,E2:E6,TRUE)', 101250],
  ['=SUMIFS(C2:C6,B2:B3,"Eng")', "#VALUE!"],
  ['=VLOOKUP("Cid",A2:C6,3,FALSE)', 95000],
  ['=VLOOKUP("cid",A2:C6,3,FALSE)', 95000],
  ['=VLOOKUP("Zed",A2:C6,3,FALSE)', "#N/A"],
  ['=VLOOKUP("Cid",A2:E6,5,FALSE)', false],
  ['=VLOOKUP("Cid",A2:C6,9,FALSE)', "#REF!"],
  ['=VLOOKUP(25,{10,"a";20,"b";30,"c"},2)', "b"],
  ['=VLOOKUP(5,{10,"a";20,"b"},2)', "#N/A"],
  ['=HLOOKUP("b",{"a","b";1,2},2,FALSE)', 2],
  ['=XLOOKUP("Dee",A2:A6,C2:C6)', 70000],
  ['=XLOOKUP("Zed",A2:A6,C2:C6,"none")', "none"],
  ['=XLOOKUP(25,{10;20;30},{"a";"b";"c"},,-1)', "b"],
  ['=XLOOKUP(25,{10;20;30},{"a";"b";"c"},,1)', "c"],
  ['=XLOOKUP("Eng",B2:B6,A2:A6,,0,-1)', "Eve"],
  ["=INDEX(A2:C6,2,3)", 80000],
  ["=INDEX(A2:E2,3)", 120000],
  ["=INDEX(A2:C6,9,1)", "#REF!"],
  ['=MATCH("Eve",A2:A6,0)', 5],
  ["=MATCH(25,{10,20,30,40},1)", 2],
  ["=MATCH(25,{40,30,20,10},-1)", 2],
  ["=MATCH(40,{10,20,30,40})", 4],
  ["=INDEX(A2:A6,MATCH(MAX(C2:C6),C2:C6,0))", "Eve"],
  ["=SUMPRODUCT((B2:B6=\"Eng\")*C2:C6)", 350000],
  ["=SUMPRODUCT({1,2,3},{4,5,6})", 32],
  ["=SUMPRODUCT({1,2},{1,2,3})", "#VALUE!"],
  ["=YEAR(D2)", 2021],
  ["=MONTH(D3)", 7],
  ["=DAY(D5)", 30],
  ['=DATEDIF(D3,D2,"Y")', 1],
  ['=DATEDIF(D3,D2,"M")', 20],
  ['=DATEDIF(D2,D3,"Y")', "#NUM!"],
  ['=TEXT(EDATE(D2,1),"yyyy-mm-dd")', "2021-04-15"],
  ['=TEXT(D2,"yyyy-mm-dd")', "2021-03-15"],
  ['=TEXT(D2,"mmm d, yyyy")', "Mar 15, 2021"],
  ['=TEXT(D2,"dddd")', "Monday"],
  ['=TEXT(C2,"$#,##0")', "$120,000"],
  ['=TEXT(0.256,"0.0%")', "25.6%"],
  ['=TEXT(1234.5,"#,##0.00")', "1,234.50"],
  ['=TEXT(-1234.5,"#,##0.00")', "-1,234.50"],
  ['=TEXT(3.14159,"0.00")', "3.14"],
  ['=TEXT(7,"000")', "007"],
  ['=TEXT(0.5,"#.##")', ".5"],
  ['=TEXT(TIME(13,5,9),"hh:mm:ss")', "13:05:09"],
  ['=TEXT(TIME(13,5,9),"h:mm AM/PM")', "1:05 PM"],
  ['=TEXT(DATE(2026,13,1),"yyyy-mm-dd")', "2027-01-01"],
  ['=TEXT(EOMONTH(DATE(2024,1,15),1),"yyyy-mm-dd")', "2024-02-29"],
  ['=TEXT(TODAY(),"yyyy-mm-dd")', "2026-11-09"],
  ["=WEEKDAY(DATE(2026,11,9))", 2],
  ["=WEEKDAY(DATE(2026,11,9),2)", 1],
  ["=DAYS(DATE(2026,12,25),DATE(2026,11,9))", 46],
  ["=NETWORKDAYS(DATE(2026,11,9),DATE(2026,11,15))", 5],
  ['=DATEVALUE("2026-11-09")=DATE(2026,11,9)', true],
  ["=HOUR(TIME(13,45,10))", 13],
  ["=MINUTE(TIME(13,45,10))", 45],
  ["=SECOND(TIME(13,45,10))", 10],
  ["=LEFT(A2,2)", "An"],
  ["=RIGHT(\"abc\",2)", "bc"],
  ['=MID("spreadsheet",3,4)', "read"],
  ["=UPPER(B3)", "SALES"],
  ['=LOWER("ABC")', "abc"],
  ['=PROPER("hello wORLD")', "Hello World"],
  ["=LEN(A2&B2)", 6],
  ['=CONCATENATE(A2," ",B2)', "Ann Eng"],
  ["=CONCAT(A2:B3)", "AnnEngBobSales"],
  ['=TEXTJOIN(", ",TRUE,A2:A4,A10)', "Ann, Bob, Cid"],
  ['=TRIM("  a   b  ")', "a b"],
  ['=SUBSTITUTE("a-b-c","-","+")', "a+b+c"],
  ['=SUBSTITUTE("a-b-c","-","+",2)', "a-b+c"],
  ['=REPLACE("abcdef",2,3,"X")', "aXef"],
  ['=FIND("b","abcb")', 2],
  ['=FIND("B","abc")', "#VALUE!"],
  ['=SEARCH("B","abc")', 2],
  ['=SEARCH("c*e","abcde")', 3],
  ['=REPT("ab",3)', "ababab"],
  ['=EXACT("a","A")', false],
  ['=VALUE("$1,000")', 1000],
  ['=VALUE("abc")', "#VALUE!"],
  ["=CHAR(65)", "A"],
  ['=CODE("A")', 65],
  ['=IF(E4,"yes","no")', "no"],
  ["=IF(TRUE,1,1/0)", 1],
  ["=IF(FALSE,1)", false],
  ["=AND(E2:E6)", false],
  ["=OR(E2:E6)", true],
  ["=XOR(TRUE,TRUE,TRUE)", true],
  ["=NOT(TRUE)", false],
  ["=IFS(FALSE,1,TRUE,2)", 2],
  ["=IFS(FALSE,1)", "#N/A"],
  ['=SWITCH(2,1,"a",2,"b","c")', "b"],
  ['=SWITCH(9,1,"a","c")', "c"],
  ['=CHOOSE(2,"x","y")', "y"],
  ['=CHOOSE(3,"x","y")', "#VALUE!"],
  ['=IFERROR(1/0,"div")', "div"],
  ['=IFNA(VLOOKUP("Zed",A2:C6,3,FALSE),"missing")', "missing"],
  ['=IFNA(1/0,"x")', "#DIV/0!"],
  ["=ISBLANK(A10)", true],
  ['=ISBLANK("")', false],
  ["=ISNUMBER(C2)", true],
  ["=ISTEXT(A2)", true],
  ["=ISLOGICAL(E2)", true],
  ["=ISERROR(1/0)", true],
  ["=ISNA(NA())", true],
  ["=ISERR(NA())", false],
  ["=ISEVEN(4)", true],
  ["=ISODD(-3)", true],
  ["=ROWS(A2:C6)", 5],
  ["=COLUMNS(A2:C6)", 3],
  ["=ROW(B4)", 4],
  ["=COLUMN(C9)", 3],
  ["=ROW()", 30],
  ["=COLUMN()", 10],
  ["=ROUND(2.5,0)", 3],
  ["=ROUND(-2.5,0)", -3],
  ["=ROUND(1.005,2)", 1.01],
  ["=ROUND(1234,-2)", 1200],
  ["=ROUNDUP(1.21,1)", 1.3],
  ["=ROUNDDOWN(-1.29,1)", -1.2],
  ["=TRUNC(-1.5)", -1],
  ["=INT(-1.5)", -2],
  ["=MOD(-3,2)", 1],
  ["=MOD(3,-2)", -1],
  ["=MOD(1,0)", "#DIV/0!"],
  ["=SQRT(16)", 4],
  ["=SQRT(-1)", "#NUM!"],
  ["=LOG(8,2)", 3],
  ["=LOG10(1000)", 3],
  ["=LN(EXP(2))", 2],
  ["=POWER(2,10)", 1024],
  ["=ABS(-3)", 3],
  ["=CEILING(2.1)", 3],
  ["=CEILING(0.3,0.1)", 0.3],
  ["=FLOOR(2.9)", 2],
  ["=FLOOR(7,5)", 5],
  ["=SIGN(-5)", -1],
  ["=PRODUCT(2,3,4)", 24],
  ["=SUM({1,2;3,4})", 10],
  ["=INDEX({1,2;3,4},2,1)", 3],
  ["=ROWS({1,2;3,4})", 2],
  ["=SUM(TRANSPOSE({1,2,3}))", 6],
  ["=LARGE({5,1,9,3},2)", 5],
  ["=SMALL({5,1,9,3},2)", 3],
  ["=RANK(9,{5,1,9,3})", 1],
  ["=RANK(1,{5,1,9,3},1)", 1],
  ["=ROUND(STDEV({2,4,4,4,5,5,7,9}),4)", 2.1381],
  ["=STDEVP({2,4,4,4,5,5,7,9})", 2],
  ["=VAR.P({2,4,4,4,5,5,7,9})", 4],
  ["=FOO(1)", "#NAME?"],
  ["=foo", "#NAME?"],
  ["=SUM()", "#N/A"],
  ["=IF(1)", "#N/A"],
];

describe("functions and operators", () => {
  it.each(cases)("%s", (formula, expected) => {
    expect(plain(s.eval(formula))).toEqual(expected);
  });

  it("gives RAND and RANDBETWEEN values in range", () => {
    for (let i = 0; i < 20; i++) {
      s.calc.seed = i;
      const r = s.eval("=RAND()") as number;
      expect(r).toBeGreaterThanOrEqual(0);
      expect(r).toBeLessThan(1);
      const d = s.eval("=RANDBETWEEN(1,6)") as number;
      expect(Number.isInteger(d) && d >= 1 && d <= 6).toBe(true);
    }
  });

  it("has a signature and description for every function", () => {
    for (const [name, fn] of Object.entries(FUNCTIONS)) {
      expect(fn.sig.startsWith(name.split(".")[0])).toBe(true);
      expect(fn.desc.length).toBeGreaterThan(5);
    }
    expect(Object.keys(FUNCTIONS).length).toBeGreaterThanOrEqual(90);
  });
});

describe("display formatting", () => {
  const d = new Sheet();
  it.each([
    ["1,234.5", "1,234.5"],
    ["$1,234.5", "$1,234.50"],
    ["-$5", "-$5.00"],
    ["12.5%", "12.5%"],
    ["2026-11-09", "11/9/2026"],
    ["11/9/26", "11/9/2026"],
    ["2026-11-09 14:05", "11/9/2026 14:05:00"],
    ["3:30 PM", "3:30:00 PM"],
    ["'00123", "00123"],
    ["true", "TRUE"],
    ["1e21", "1E+21"],
    ["0.1234567891234", "0.1234567891"],
    ["hello", "hello"],
  ])("shows %s as %s", (input, out) => {
    d.set("A1", input);
    expect(d.show("A1")).toBe(out);
  });

  it("applies explicit number formats", () => {
    d.set("A1", "1234.567");
    const [tab, row, col] = d.ids("A1");
    const fmt = (nf: string) => {
      d.apply({ t: "style", tab, cells: [[row, col, { nf }]] });
      return d.show("A1");
    };
    expect(fmt("number:2")).toBe("1,234.57");
    expect(fmt("currency:0")).toBe("$1,235");
    expect(fmt("percent:1")).toBe("123456.7%");
    expect(fmt("date")).toBe("5/18/1903");
    expect(fmt("general")).toBe("1234.567");
  });

  it("keeps text formatted cells as text", () => {
    d.set("A2", "00123").set("B2", "=ISTEXT(A2)");
    expect(d.get("B2")).toBe(false);
    const [tab, row, col] = d.ids("A2");
    d.apply({ t: "style", tab, cells: [[row, col, { nf: "text" }]] });
    expect(d.get("A2")).toBe("00123");
    expect(d.get("B2")).toBe(true);
  });

  it("formats date formulas as dates", () => {
    d.set("A3", "=DATE(2026,11,9)+7");
    expect(d.show("A3")).toBe("11/16/2026");
  });
});
