import type { Ctx } from "./evaluate.ts";
import { formatCode } from "./format.ts";
import { parseDate, parseNumber, toBool, toNumber, toText } from "./literal.ts";
import type { Node } from "./parse.ts";
import {
  type Area,
  CellError,
  type Scalar,
  type Value,
  arrayArea,
  compare,
  dateSerial,
  daysInMonth,
  err,
  isArea,
  localSerial,
  serialParts,
  single,
  timeSerial,
} from "./values.ts";

export type Fn = {
  min: number;
  max: number;
  fn?: (args: Value[], ctx: Ctx) => Value;
  lazy?: (args: Node[], ev: (n: Node) => Value, ctx: Ctx) => Value;
  volatile?: boolean;
  position?: boolean;
  sig: string;
  desc: string;
};

type R<T> = T | CellError;

const num = (v: Value): R<number> => toNumber(single(v));
const int = (v: Value): R<number> => {
  const n = num(v);
  return n instanceof CellError ? n : Math.trunc(n);
};
const txt = (v: Value): R<string> => toText(single(v));
const bool = (v: Value): R<boolean> => toBool(single(v));
const area = (v: Value): Area => (isArea(v) ? v : { rows: 1, cols: 1, get: () => v });
const isErr = (v: unknown): v is CellError => v instanceof CellError;

function eachNumber(args: Value[], cb: (n: number) => void): CellError | null {
  for (const a of args) {
    if (isArea(a)) {
      for (let r = 0; r < a.rows; r++) {
        for (let c = 0; c < a.cols; c++) {
          const v = a.get(r, c);
          if (typeof v === "number") cb(v);
          else if (v instanceof CellError) return v;
        }
      }
    } else if (a !== null) {
      const n = toNumber(a);
      if (n instanceof CellError) return n;
      cb(n);
    }
  }
  return null;
}

function numbers(args: Value[]): R<number[]> {
  const out: number[] = [];
  const e = eachNumber(args, (n) => out.push(n));
  return e ?? out;
}

function eachCell(a: Area, cb: (v: Scalar, r: number, c: number) => void): void {
  for (let r = 0; r < a.rows; r++) for (let c = 0; c < a.cols; c++) cb(a.get(r, c), r, c);
}

function wildcard(pattern: string): RegExp | null {
  if (!/[*?]/.test(pattern)) return null;
  let src = "";
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];
    if (ch === "~" && i + 1 < pattern.length) src += pattern[++i].replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    else if (ch === "*") src += "[\\s\\S]*";
    else if (ch === "?") src += "[\\s\\S]";
    else src += ch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp("^" + src + "$", "i");
}

function equals(key: Scalar): (v: Scalar) => boolean {
  if (typeof key === "string") {
    const re = wildcard(key);
    if (re) return (v) => typeof v === "string" && re.test(v);
    const k = key.toLowerCase();
    return (v) => typeof v === "string" && v.toLowerCase() === k;
  }
  if (key === null) return (v) => v === null;
  return (v) => v === key;
}

function cmpOk(op: string, c: number): boolean {
  switch (op) {
    case "<":
      return c < 0;
    case ">":
      return c > 0;
    case "<=":
      return c <= 0;
    case ">=":
      return c >= 0;
    case "<>":
      return c !== 0;
    default:
      return c === 0;
  }
}

export function criteria(crit: Scalar): (v: Scalar) => boolean {
  if (crit instanceof CellError) return (v) => v instanceof CellError && v.code === crit.code;
  if (typeof crit === "boolean") return (v) => v === crit;
  if (typeof crit === "number") {
    return (v) => (typeof v === "number" ? v === crit : typeof v === "string" && parseNumber(v)?.value === crit);
  }
  if (crit === null) return (v) => v === null || v === "";
  const m = /^(<=|>=|<>|<|>|=)?([\s\S]*)$/.exec(crit)!;
  const op = m[1] ?? "=";
  const rest = m[2];
  if (rest === "") {
    if (op === "=") return (v) => v === null || v === "";
    if (op === "<>") return (v) => v !== null && v !== "";
  }
  const lit = parseNumber(rest);
  if (lit && typeof lit.value === "number") {
    const x = lit.value;
    if (op === "=") return (v) => (typeof v === "number" ? v === x : typeof v === "string" && parseNumber(v)?.value === x);
    if (op === "<>") return (v) => !(typeof v === "number" ? v === x : typeof v === "string" && parseNumber(v)?.value === x);
    return (v) => typeof v === "number" && cmpOk(op, compare(v, x));
  }
  const upper = rest.toUpperCase();
  if (upper === "TRUE" || upper === "FALSE") {
    const b = upper === "TRUE";
    return (v) => (op === "<>" ? v !== b : typeof v === "boolean" && cmpOk(op, compare(v, b)));
  }
  if (op === "=" || op === "<>") {
    const eq = equals(rest);
    return op === "=" ? eq : (v) => !eq(v);
  }
  return (v) => typeof v === "string" && cmpOk(op, compare(v, rest));
}

function sameShape(areas: Area[]): boolean {
  return areas.every((a) => a.rows === areas[0].rows && a.cols === areas[0].cols);
}

function ifsMask(args: Value[], from: number, shape: Area | null): R<boolean[][]> {
  const pairs: [Area, (v: Scalar) => boolean][] = [];
  for (let i = from; i < args.length; i += 2) {
    const c = single(args[i + 1] ?? null);
    pairs.push([area(args[i]), criteria(c)]);
  }
  const areas = pairs.map(([a]) => a);
  if (shape) areas.push(shape);
  if (!sameShape(areas)) return err.value("Ranges must be the same size");
  const first = areas[0];
  const mask: boolean[][] = [];
  for (let r = 0; r < first.rows; r++) {
    const row: boolean[] = [];
    for (let c = 0; c < first.cols; c++) row.push(pairs.every(([a, test]) => test(a.get(r, c))));
    mask.push(row);
  }
  return mask;
}

function masked(target: Area, mask: boolean[][]): R<number[]> {
  const out: number[] = [];
  for (let r = 0; r < mask.length; r++) {
    for (let c = 0; c < mask[r].length; c++) {
      if (!mask[r][c]) continue;
      const v = target.get(r, c);
      if (typeof v === "number") out.push(v);
      else if (v instanceof CellError) return v;
    }
  }
  return out;
}

const sum = (xs: number[]) => xs.reduce((s, x) => s + x, 0);

function variance(args: Value[], sample: boolean): R<number> {
  const xs = numbers(args);
  if (isErr(xs)) return xs;
  const n = xs.length;
  if (n < (sample ? 2 : 1)) return err.div0();
  const mean = sum(xs) / n;
  return xs.reduce((s, x) => s + (x - mean) ** 2, 0) / (sample ? n - 1 : n);
}

function roundTo(x: number, digits: number, mode: "round" | "up" | "down"): number {
  if (digits > 15) return x;
  const f = mode === "round" ? Math.round : mode === "up" ? Math.ceil : Math.floor;
  const sign = x < 0 ? -1 : 1;
  const abs = Math.abs(x);
  const s = String(abs);
  if (!s.includes("e")) {
    const r = Number(String(f(Number(s + "e" + digits))) + "e" + -digits);
    if (Number.isFinite(r)) return sign * r;
  }
  const p = Math.pow(10, digits);
  return (sign * f(abs * p)) / p;
}

function vector(a: Area): { n: number; at: (i: number) => Scalar } | null {
  if (a.cols === 1) return { n: a.rows, at: (i) => a.get(i, 0) };
  if (a.rows === 1) return { n: a.cols, at: (i) => a.get(0, i) };
  return null;
}

function approx(n: number, at: (i: number) => Scalar, key: Scalar, descending: boolean): number {
  let lo = 0;
  let hi = n - 1;
  let ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const v = at(mid);
    const c = v === null ? (descending ? 1 : -1) : compare(v, key);
    if (descending ? c >= 0 : c <= 0) {
      ans = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return ans;
}

function mapText(args: Value[], f: (s: string) => string): Value {
  const s = txt(args[0]);
  return isErr(s) ? s : f(s);
}

function parts(v: Value): R<ReturnType<typeof serialParts>> {
  const n = num(v);
  if (isErr(n)) return n;
  if (n < 0) return err.num("Dates before 12/30/1899 are not supported");
  return serialParts(n);
}

function rowSlice(a: Area, r: number): Area {
  return { rows: 1, cols: a.cols, get: (_, c) => a.get(r, c), top: (a.top ?? 0) + r, left: a.left };
}

function colSlice(a: Area, c: number): Area {
  return { rows: a.rows, cols: 1, get: (r) => a.get(r, c), top: a.top, left: (a.left ?? 0) + c };
}

const F: Record<string, Fn> = {};

function def(name: string, min: number, max: number, sig: string, desc: string, fn: Fn["fn"], extra: Partial<Fn> = {}): void {
  F[name] = { min, max, fn, sig, desc, ...extra };
}

function lazy(name: string, min: number, max: number, sig: string, desc: string, fn: Fn["lazy"]): void {
  F[name] = { min, max, lazy: fn, sig, desc };
}

def("SUM", 1, Infinity, "SUM(value1, [value2, ...])", "Adds numbers", (a) => {
  let s = 0;
  return eachNumber(a, (n) => (s += n)) ?? s;
});
def("AVERAGE", 1, Infinity, "AVERAGE(value1, [value2, ...])", "Arithmetic mean", (a) => {
  let s = 0;
  let n = 0;
  const e = eachNumber(a, (x) => {
    s += x;
    n++;
  });
  return e ?? (n ? s / n : err.div0());
});
def("COUNT", 1, Infinity, "COUNT(value1, [value2, ...])", "Counts numbers", (args) => {
  let n = 0;
  for (const a of args) {
    if (isArea(a)) eachCell(a, (v) => typeof v === "number" && n++);
    else if (typeof a === "number" || typeof a === "boolean" || (typeof a === "string" && parseNumber(a))) n++;
  }
  return n;
});
def("COUNTA", 1, Infinity, "COUNTA(value1, [value2, ...])", "Counts non-empty values", (args) => {
  let n = 0;
  for (const a of args) {
    if (isArea(a)) eachCell(a, (v) => v !== null && n++);
    else if (a !== null) n++;
  }
  return n;
});
def("COUNTBLANK", 1, 1, "COUNTBLANK(range)", "Counts empty cells", ([a]) => {
  let n = 0;
  eachCell(area(a), (v) => (v === null || v === "") && n++);
  return n;
});
def("MAX", 1, Infinity, "MAX(value1, [value2, ...])", "Largest number", (a) => {
  let m = -Infinity;
  const e = eachNumber(a, (x) => (m = Math.max(m, x)));
  return e ?? (m === -Infinity ? 0 : m);
});
def("MIN", 1, Infinity, "MIN(value1, [value2, ...])", "Smallest number", (a) => {
  let m = Infinity;
  const e = eachNumber(a, (x) => (m = Math.min(m, x)));
  return e ?? (m === Infinity ? 0 : m);
});
def("PRODUCT", 1, Infinity, "PRODUCT(value1, [value2, ...])", "Multiplies numbers", (a) => {
  let p = 1;
  let n = 0;
  const e = eachNumber(a, (x) => {
    p *= x;
    n++;
  });
  return e ?? (n ? p : 0);
});
def("MEDIAN", 1, Infinity, "MEDIAN(value1, [value2, ...])", "Middle value", (a) => {
  const xs = numbers(a);
  if (isErr(xs)) return xs;
  if (!xs.length) return err.num();
  xs.sort((x, y) => x - y);
  const m = xs.length >> 1;
  return xs.length % 2 ? xs[m] : (xs[m - 1] + xs[m]) / 2;
});
def("STDEV", 1, Infinity, "STDEV(value1, [value2, ...])", "Sample standard deviation", (a) => {
  const v = variance(a, true);
  return isErr(v) ? v : Math.sqrt(v);
});
F["STDEV.S"] = F.STDEV;
def("STDEVP", 1, Infinity, "STDEVP(value1, [value2, ...])", "Population standard deviation", (a) => {
  const v = variance(a, false);
  return isErr(v) ? v : Math.sqrt(v);
});
F["STDEV.P"] = F.STDEVP;
def("VAR", 1, Infinity, "VAR(value1, [value2, ...])", "Sample variance", (a) => variance(a, true));
F["VAR.S"] = F.VAR;
def("VARP", 1, Infinity, "VARP(value1, [value2, ...])", "Population variance", (a) => variance(a, false));
F["VAR.P"] = F.VARP;
def("LARGE", 2, 2, "LARGE(range, k)", "k-th largest value", ([a, k]) => {
  const xs = numbers([a]);
  const n = int(k);
  if (isErr(xs)) return xs;
  if (isErr(n)) return n;
  xs.sort((x, y) => y - x);
  return n >= 1 && n <= xs.length ? xs[n - 1] : err.num();
});
def("SMALL", 2, 2, "SMALL(range, k)", "k-th smallest value", ([a, k]) => {
  const xs = numbers([a]);
  const n = int(k);
  if (isErr(xs)) return xs;
  if (isErr(n)) return n;
  xs.sort((x, y) => x - y);
  return n >= 1 && n <= xs.length ? xs[n - 1] : err.num();
});
def("RANK", 2, 3, "RANK(value, range, [ascending])", "Rank of a number in a list", ([v, a, o]) => {
  const x = num(v);
  const xs = numbers([a]);
  if (isErr(x)) return x;
  if (isErr(xs)) return xs;
  const asc = o === undefined ? false : bool(o);
  if (isErr(asc)) return asc;
  if (!xs.includes(x)) return err.na();
  return 1 + xs.filter((y) => (asc ? y < x : y > x)).length;
});
def("SUMPRODUCT", 1, Infinity, "SUMPRODUCT(array1, [array2, ...])", "Sum of element-wise products", (args) => {
  const areas = args.map(area);
  if (!sameShape(areas)) return err.value("Arrays must be the same size");
  let s = 0;
  for (let r = 0; r < areas[0].rows; r++) {
    for (let c = 0; c < areas[0].cols; c++) {
      let p = 1;
      for (const a of areas) {
        const v = a.get(r, c);
        if (v instanceof CellError) return v;
        p *= typeof v === "number" ? v : 0;
      }
      s += p;
    }
  }
  return s;
});
def("SUMIF", 2, 3, "SUMIF(range, criterion, [sum_range])", "Sums cells that meet a condition", ([a, c, s]) => {
  const range = area(a);
  const target = s === undefined ? range : area(s);
  const test = criteria(single(c));
  let total = 0;
  for (let r = 0; r < range.rows; r++) {
    for (let col = 0; col < range.cols; col++) {
      if (!test(range.get(r, col))) continue;
      const v = target.get(r, col);
      if (typeof v === "number") total += v;
      else if (v instanceof CellError) return v;
    }
  }
  return total;
});
def("SUMIFS", 3, Infinity, "SUMIFS(sum_range, range1, criterion1, ...)", "Sums cells that meet all conditions", (args) => {
  if (args.length % 2 === 0) return err.na("SUMIFS needs range and criterion pairs");
  const target = area(args[0]);
  const mask = ifsMask(args, 1, target);
  if (isErr(mask)) return mask;
  const xs = masked(target, mask);
  return isErr(xs) ? xs : sum(xs);
});
def("COUNTIF", 2, 2, "COUNTIF(range, criterion)", "Counts cells that meet a condition", ([a, c]) => {
  const test = criteria(single(c));
  let n = 0;
  eachCell(area(a), (v) => test(v) && n++);
  return n;
});
def("COUNTIFS", 2, Infinity, "COUNTIFS(range1, criterion1, ...)", "Counts cells that meet all conditions", (args) => {
  if (args.length % 2) return err.na("COUNTIFS needs range and criterion pairs");
  const mask = ifsMask(args, 0, null);
  if (isErr(mask)) return mask;
  return mask.reduce((n, row) => n + row.filter(Boolean).length, 0);
});
def("AVERAGEIF", 2, 3, "AVERAGEIF(range, criterion, [average_range])", "Average of cells that meet a condition", ([a, c, s]) => {
  const range = area(a);
  const target = s === undefined ? range : area(s);
  const test = criteria(single(c));
  const mask = Array.from({ length: range.rows }, (_, r) => Array.from({ length: range.cols }, (_, col) => test(range.get(r, col))));
  const xs = masked(target, mask);
  if (isErr(xs)) return xs;
  return xs.length ? sum(xs) / xs.length : err.div0();
});
def("AVERAGEIFS", 3, Infinity, "AVERAGEIFS(average_range, range1, criterion1, ...)", "Average of cells that meet all conditions", (args) => {
  if (args.length % 2 === 0) return err.na("AVERAGEIFS needs range and criterion pairs");
  const target = area(args[0]);
  const mask = ifsMask(args, 1, target);
  if (isErr(mask)) return mask;
  const xs = masked(target, mask);
  if (isErr(xs)) return xs;
  return xs.length ? sum(xs) / xs.length : err.div0();
});
def("MAXIFS", 3, Infinity, "MAXIFS(max_range, range1, criterion1, ...)", "Largest value that meets all conditions", (args) => {
  if (args.length % 2 === 0) return err.na("MAXIFS needs range and criterion pairs");
  const target = area(args[0]);
  const mask = ifsMask(args, 1, target);
  if (isErr(mask)) return mask;
  const xs = masked(target, mask);
  if (isErr(xs)) return xs;
  return xs.length ? Math.max(...xs) : 0;
});
def("MINIFS", 3, Infinity, "MINIFS(min_range, range1, criterion1, ...)", "Smallest value that meets all conditions", (args) => {
  if (args.length % 2 === 0) return err.na("MINIFS needs range and criterion pairs");
  const target = area(args[0]);
  const mask = ifsMask(args, 1, target);
  if (isErr(mask)) return mask;
  const xs = masked(target, mask);
  if (isErr(xs)) return xs;
  return xs.length ? Math.min(...xs) : 0;
});

def("ABS", 1, 1, "ABS(number)", "Absolute value", ([x]) => {
  const n = num(x);
  return isErr(n) ? n : Math.abs(n);
});
for (const [name, mode] of [
  ["ROUND", "round"],
  ["ROUNDUP", "up"],
  ["ROUNDDOWN", "down"],
] as const) {
  def(name, 1, 2, `${name}(number, [places])`, mode === "round" ? "Rounds to a number of decimal places" : `Rounds ${mode === "up" ? "away from" : "toward"} zero`, ([x, d]) => {
    const n = num(x);
    const p = d === undefined ? 0 : int(d);
    if (isErr(n)) return n;
    if (isErr(p)) return p;
    return roundTo(n, p, mode);
  });
}
def("INT", 1, 1, "INT(number)", "Rounds down to an integer", ([x]) => {
  const n = num(x);
  return isErr(n) ? n : Math.floor(n);
});
def("TRUNC", 1, 2, "TRUNC(number, [places])", "Cuts off decimal places", ([x, d]) => {
  const n = num(x);
  const p = d === undefined ? 0 : int(d);
  if (isErr(n)) return n;
  if (isErr(p)) return p;
  return roundTo(n, p, "down");
});
def("MOD", 2, 2, "MOD(dividend, divisor)", "Remainder after division", ([x, y]) => {
  const a = num(x);
  const b = num(y);
  if (isErr(a)) return a;
  if (isErr(b)) return b;
  if (b === 0) return err.div0();
  const m = a - b * Math.floor(a / b);
  return Math.abs(m) < 1e-12 ? 0 : m;
});
def("SQRT", 1, 1, "SQRT(number)", "Square root", ([x]) => {
  const n = num(x);
  if (isErr(n)) return n;
  return n < 0 ? err.num("SQRT of a negative number") : Math.sqrt(n);
});
def("POWER", 2, 2, "POWER(base, exponent)", "Raises a number to a power", ([x, y]) => {
  const a = num(x);
  const b = num(y);
  if (isErr(a)) return a;
  if (isErr(b)) return b;
  const r = Math.pow(a, b);
  return Number.isFinite(r) ? r : err.num();
});
def("EXP", 1, 1, "EXP(number)", "e raised to a power", ([x]) => {
  const n = num(x);
  return isErr(n) ? n : Math.exp(n);
});
def("LN", 1, 1, "LN(number)", "Natural logarithm", ([x]) => {
  const n = num(x);
  if (isErr(n)) return n;
  return n <= 0 ? err.num() : Math.log(n);
});
def("LOG", 1, 2, "LOG(number, [base])", "Logarithm, base 10 by default", ([x, b]) => {
  const n = num(x);
  const base = b === undefined ? 10 : num(b);
  if (isErr(n)) return n;
  if (isErr(base)) return base;
  if (n <= 0 || base <= 0 || base === 1) return err.num();
  return Math.log(n) / Math.log(base);
});
def("LOG10", 1, 1, "LOG10(number)", "Base 10 logarithm", ([x]) => {
  const n = num(x);
  if (isErr(n)) return n;
  return n <= 0 ? err.num() : Math.log10(n);
});
def("PI", 0, 0, "PI()", "The number pi", () => Math.PI);
def("SIGN", 1, 1, "SIGN(number)", "1, 0 or -1 depending on the sign", ([x]) => {
  const n = num(x);
  return isErr(n) ? n : Math.sign(n);
});
def("CEILING", 1, 2, "CEILING(number, [significance])", "Rounds up to a multiple", ([x, s]) => {
  const n = num(x);
  const m = s === undefined ? 1 : num(s);
  if (isErr(n)) return n;
  if (isErr(m)) return m;
  if (m === 0) return 0;
  return roundTo(Math.ceil(roundTo(n / m, 10, "round")) * m, 10, "round");
});
def("FLOOR", 1, 2, "FLOOR(number, [significance])", "Rounds down to a multiple", ([x, s]) => {
  const n = num(x);
  const m = s === undefined ? 1 : num(s);
  if (isErr(n)) return n;
  if (isErr(m)) return m;
  if (m === 0) return err.div0();
  return roundTo(Math.floor(roundTo(n / m, 10, "round")) * m, 10, "round");
});
def("RAND", 0, 0, "RAND()", "Random number between 0 and 1", (_, ctx) => ctx.rand(), { volatile: true });
def("RANDBETWEEN", 2, 2, "RANDBETWEEN(low, high)", "Random integer in a range", ([a, b], ctx) => {
  const lo = num(a);
  const hi = num(b);
  if (isErr(lo)) return lo;
  if (isErr(hi)) return hi;
  const l = Math.ceil(lo);
  const h = Math.floor(hi);
  if (l > h) return err.num();
  return l + Math.floor(ctx.rand() * (h - l + 1));
}, { volatile: true });

lazy("IF", 2, 3, "IF(condition, value_if_true, [value_if_false])", "Picks a value based on a condition", (args, ev) => {
  const c = bool(ev(args[0]));
  if (isErr(c)) return c;
  if (c) return ev(args[1]);
  return args[2] === undefined ? false : ev(args[2]);
});
lazy("IFS", 2, Infinity, "IFS(condition1, value1, ...)", "First value whose condition is true", (args, ev) => {
  if (args.length % 2) return err.na("IFS needs condition and value pairs");
  for (let i = 0; i < args.length; i += 2) {
    const c = bool(ev(args[i]));
    if (isErr(c)) return c;
    if (c) return ev(args[i + 1]);
  }
  return err.na("No condition was true");
});
lazy("IFERROR", 2, 2, "IFERROR(value, value_if_error)", "Replaces errors with another value", (args, ev) => {
  const v = single(ev(args[0]));
  return v instanceof CellError ? ev(args[1]) : v;
});
lazy("IFNA", 2, 2, "IFNA(value, value_if_na)", "Replaces #N/A with another value", (args, ev) => {
  const v = single(ev(args[0]));
  return v instanceof CellError && v.code === "#N/A" ? ev(args[1]) : v;
});
lazy("SWITCH", 3, Infinity, "SWITCH(expression, case1, value1, ..., [default])", "Matches a value against cases", (args, ev) => {
  const x = single(ev(args[0]));
  if (isErr(x)) return x;
  let i = 1;
  for (; i + 1 < args.length; i += 2) {
    const c = single(ev(args[i]));
    if (!isErr(c) && compare(x, c) === 0 && typeof x === typeof c) return ev(args[i + 1]);
  }
  return i < args.length ? ev(args[i]) : err.na("No case matched");
});
lazy("CHOOSE", 2, Infinity, "CHOOSE(index, value1, [value2, ...])", "Picks a value by position", (args, ev) => {
  const i = int(ev(args[0]));
  if (isErr(i)) return i;
  if (i < 1 || i >= args.length) return err.value("Index out of range");
  return ev(args[i]);
});

function logical(args: Value[], combine: (bs: boolean[]) => boolean): Value {
  const bs: boolean[] = [];
  for (const a of args) {
    if (isArea(a)) {
      let bad: CellError | null = null;
      eachCell(a, (v) => {
        if (v instanceof CellError) bad ??= v;
        else if (typeof v === "boolean") bs.push(v);
        else if (typeof v === "number") bs.push(v !== 0);
      });
      if (bad) return bad;
    } else if (a !== null) {
      const b = toBool(a);
      if (isErr(b)) return b;
      bs.push(b);
    }
  }
  return bs.length ? combine(bs) : err.value("No logical values");
}

def("AND", 1, Infinity, "AND(logical1, [logical2, ...])", "TRUE if all values are true", (a) => logical(a, (bs) => bs.every(Boolean)));
def("OR", 1, Infinity, "OR(logical1, [logical2, ...])", "TRUE if any value is true", (a) => logical(a, (bs) => bs.some(Boolean)));
def("XOR", 1, Infinity, "XOR(logical1, [logical2, ...])", "TRUE if an odd number of values are true", (a) =>
  logical(a, (bs) => bs.filter(Boolean).length % 2 === 1),
);
def("NOT", 1, 1, "NOT(logical)", "Flips TRUE and FALSE", ([x]) => {
  const b = bool(x);
  return isErr(b) ? b : !b;
});
def("TRUE", 0, 0, "TRUE()", "The value TRUE", () => true);
def("FALSE", 0, 0, "FALSE()", "The value FALSE", () => false);

function joinText(args: Value[], delim: string, skipEmpty: boolean): R<string> {
  const out: string[] = [];
  for (const a of args) {
    for (const v of isArea(a) ? Array.from({ length: a.rows * a.cols }, (_, i) => a.get(Math.floor(i / a.cols), i % a.cols)) : [a]) {
      const s = toText(v);
      if (isErr(s)) return s;
      if (skipEmpty && s === "") continue;
      out.push(s);
    }
  }
  return out.join(delim);
}

def("CONCATENATE", 1, Infinity, "CONCATENATE(text1, [text2, ...])", "Joins text together", (a) => joinText(a, "", false));
def("CONCAT", 1, Infinity, "CONCAT(text1, [text2, ...])", "Joins text together", (a) => joinText(a, "", false));
def("TEXTJOIN", 3, Infinity, "TEXTJOIN(delimiter, ignore_empty, text1, ...)", "Joins text with a delimiter", ([d, skip, ...rest]) => {
  const delim = txt(d);
  const s = bool(skip);
  if (isErr(delim)) return delim;
  if (isErr(s)) return s;
  return joinText(rest, delim, s);
});
def("LEN", 1, 1, "LEN(text)", "Number of characters", ([x]) => {
  const s = txt(x);
  return isErr(s) ? s : s.length;
});
def("LEFT", 1, 2, "LEFT(text, [count])", "First characters of text", ([x, n]) => {
  const s = txt(x);
  const k = n === undefined ? 1 : int(n);
  if (isErr(s)) return s;
  if (isErr(k)) return k;
  return k < 0 ? err.value() : s.slice(0, k);
});
def("RIGHT", 1, 2, "RIGHT(text, [count])", "Last characters of text", ([x, n]) => {
  const s = txt(x);
  const k = n === undefined ? 1 : int(n);
  if (isErr(s)) return s;
  if (isErr(k)) return k;
  return k < 0 ? err.value() : k === 0 ? "" : s.slice(-k);
});
def("MID", 3, 3, "MID(text, start, count)", "Characters from the middle of text", ([x, a, n]) => {
  const s = txt(x);
  const st = int(a);
  const k = int(n);
  if (isErr(s)) return s;
  if (isErr(st)) return st;
  if (isErr(k)) return k;
  if (st < 1 || k < 0) return err.value();
  return s.slice(st - 1, st - 1 + k);
});
def("UPPER", 1, 1, "UPPER(text)", "Converts to upper case", (a) => mapText(a, (s) => s.toUpperCase()));
def("LOWER", 1, 1, "LOWER(text)", "Converts to lower case", (a) => mapText(a, (s) => s.toLowerCase()));
def("PROPER", 1, 1, "PROPER(text)", "Capitalizes each word", (a) =>
  mapText(a, (s) => s.toLowerCase().replace(/(^|[^a-z])([a-z])/g, (_, p: string, c: string) => p + c.toUpperCase())),
);
def("TRIM", 1, 1, "TRIM(text)", "Removes extra spaces", (a) => mapText(a, (s) => s.trim().replace(/ {2,}/g, " ")));
def("SUBSTITUTE", 3, 4, "SUBSTITUTE(text, old, new, [occurrence])", "Replaces text", ([x, o, n, k]) => {
  const s = txt(x);
  const old = txt(o);
  const rep = txt(n);
  if (isErr(s)) return s;
  if (isErr(old)) return old;
  if (isErr(rep)) return rep;
  if (old === "") return s;
  if (k === undefined) return s.split(old).join(rep);
  const which = int(k);
  if (isErr(which)) return which;
  if (which < 1) return err.value();
  let at = -1;
  for (let i = 0; i < which; i++) {
    at = s.indexOf(old, at + 1);
    if (at < 0) return s;
  }
  return s.slice(0, at) + rep + s.slice(at + old.length);
});
def("REPLACE", 4, 4, "REPLACE(text, start, count, new)", "Replaces part of text by position", ([x, a, n, r]) => {
  const s = txt(x);
  const st = int(a);
  const k = int(n);
  const rep = txt(r);
  if (isErr(s)) return s;
  if (isErr(st)) return st;
  if (isErr(k)) return k;
  if (isErr(rep)) return rep;
  if (st < 1 || k < 0) return err.value();
  return s.slice(0, st - 1) + rep + s.slice(st - 1 + k);
});
def("FIND", 2, 3, "FIND(search_for, text, [start])", "Position of text, case sensitive", ([f, x, a]) => {
  const needle = txt(f);
  const s = txt(x);
  const st = a === undefined ? 1 : int(a);
  if (isErr(needle)) return needle;
  if (isErr(s)) return s;
  if (isErr(st)) return st;
  if (st < 1 || st > s.length + 1) return err.value();
  const i = s.indexOf(needle, st - 1);
  return i < 0 ? err.value(`"${needle}" was not found`) : i + 1;
});
def("SEARCH", 2, 3, "SEARCH(search_for, text, [start])", "Position of text, ignores case", ([f, x, a]) => {
  const needle = txt(f);
  const s = txt(x);
  const st = a === undefined ? 1 : int(a);
  if (isErr(needle)) return needle;
  if (isErr(s)) return s;
  if (isErr(st)) return st;
  if (st < 1 || st > s.length + 1) return err.value();
  const re = wildcard(needle);
  if (re) {
    const loose = new RegExp(re.source.slice(1, -1), "i");
    const m = loose.exec(s.slice(st - 1));
    return m ? m.index + st : err.value(`"${needle}" was not found`);
  }
  const i = s.toLowerCase().indexOf(needle.toLowerCase(), st - 1);
  return i < 0 ? err.value(`"${needle}" was not found`) : i + 1;
});
def("REPT", 2, 2, "REPT(text, times)", "Repeats text", ([x, n]) => {
  const s = txt(x);
  const k = int(n);
  if (isErr(s)) return s;
  if (isErr(k)) return k;
  if (k < 0 || s.length * k > 32767) return err.value();
  return s.repeat(k);
});
def("EXACT", 2, 2, "EXACT(text1, text2)", "TRUE if two texts are identical", ([a, b]) => {
  const x = txt(a);
  const y = txt(b);
  if (isErr(x)) return x;
  if (isErr(y)) return y;
  return x === y;
});
def("TEXT", 2, 2, "TEXT(value, format)", "Formats a number as text", ([v, f]) => {
  const code = txt(f);
  if (isErr(code)) return code;
  let x = single(v);
  if (isErr(x)) return x;
  if (typeof x === "string") {
    const n = parseNumber(x);
    if (n && typeof n.value === "number") x = n.value;
    else return x;
  }
  return formatCode(x, code);
});
def("VALUE", 1, 1, "VALUE(text)", "Converts text to a number", ([x]) => {
  const v = single(x);
  if (typeof v === "number" || isErr(v)) return v;
  return toNumber(v);
});
def("CHAR", 1, 1, "CHAR(number)", "Character for a character code", ([x]) => {
  const n = int(x);
  if (isErr(n)) return n;
  return n >= 1 && n <= 65535 ? String.fromCharCode(n) : err.value();
});
def("CODE", 1, 1, "CODE(text)", "Code of the first character", ([x]) => {
  const s = txt(x);
  if (isErr(s)) return s;
  return s.length ? s.charCodeAt(0) : err.value();
});

def("VLOOKUP", 3, 4, "VLOOKUP(key, range, column, [is_sorted])", "Looks up a value in the first column", ([k, a, i, s]) => {
  const key = single(k);
  if (isErr(key)) return key;
  if (!isArea(a)) return err.value("VLOOKUP needs a range");
  const idx = int(i);
  if (isErr(idx)) return idx;
  if (idx < 1) return err.value();
  if (idx > a.cols) return err.ref("Column is outside the range");
  const sorted = s === undefined ? true : bool(s);
  if (isErr(sorted)) return sorted;
  if (sorted) {
    const r = approx(a.rows, (r) => a.get(r, 0), key, false);
    return r < 0 ? err.na() : a.get(r, idx - 1);
  }
  const eq = equals(key);
  for (let r = 0; r < a.rows; r++) if (eq(a.get(r, 0))) return a.get(r, idx - 1);
  return err.na(`Did not find ${String(key)}`);
});
def("HLOOKUP", 3, 4, "HLOOKUP(key, range, row, [is_sorted])", "Looks up a value in the first row", ([k, a, i, s]) => {
  const key = single(k);
  if (isErr(key)) return key;
  if (!isArea(a)) return err.value("HLOOKUP needs a range");
  const idx = int(i);
  if (isErr(idx)) return idx;
  if (idx < 1) return err.value();
  if (idx > a.rows) return err.ref("Row is outside the range");
  const sorted = s === undefined ? true : bool(s);
  if (isErr(sorted)) return sorted;
  if (sorted) {
    const c = approx(a.cols, (c) => a.get(0, c), key, false);
    return c < 0 ? err.na() : a.get(idx - 1, c);
  }
  const eq = equals(key);
  for (let c = 0; c < a.cols; c++) if (eq(a.get(0, c))) return a.get(idx - 1, c);
  return err.na(`Did not find ${String(key)}`);
});
def("XLOOKUP", 3, 6, "XLOOKUP(key, lookup_range, result_range, [if_not_found], [match_mode], [search_mode])", "Modern lookup in any direction", (args) => {
  const [k, l, ret, nf, mm, sm] = args;
  const key = single(k);
  if (isErr(key)) return key;
  const look = area(l);
  const vec = vector(look);
  if (!vec) return err.value("Lookup range must be one row or one column");
  const result = area(ret);
  const vertical = look.cols === 1 && look.rows !== 1 ? true : look.rows === 1 && look.cols !== 1 ? false : result.rows >= result.cols;
  if ((vertical ? result.rows : result.cols) !== vec.n) return err.value("Ranges must be the same length");
  const mode = mm === undefined ? 0 : int(mm);
  const search = sm === undefined ? 1 : int(sm);
  if (isErr(mode)) return mode;
  if (isErr(search)) return search;
  const eq = mode === 2 ? equals(key) : (v: Scalar) => v !== null && compare(v, key) === 0 && typeof v === typeof key;
  let hit = -1;
  let best = -1;
  const order = search < 0 ? Array.from({ length: vec.n }, (_, i) => vec.n - 1 - i) : Array.from({ length: vec.n }, (_, i) => i);
  for (const i of order) {
    const v = vec.at(i);
    if (eq(v)) {
      hit = i;
      break;
    }
    if ((mode === -1 || mode === 1) && v !== null && typeof v === typeof key) {
      const c = compare(v, key);
      if (mode === -1 && c < 0 && (best < 0 || compare(v, vec.at(best)) > 0)) best = i;
      if (mode === 1 && c > 0 && (best < 0 || compare(v, vec.at(best)) < 0)) best = i;
    }
  }
  if (hit < 0) hit = best;
  if (hit < 0) return nf === undefined ? err.na(`Did not find ${String(key)}`) : single(nf);
  return vertical ? rowSlice(result, hit) : colSlice(result, hit);
});
def("INDEX", 2, 3, "INDEX(range, row, [column])", "Value at a row and column of a range", ([a, r, c]) => {
  const range = area(a);
  let row = int(r);
  let col = c === undefined ? 1 : int(c);
  if (isErr(row)) return row;
  if (isErr(col)) return col;
  if (c === undefined && range.rows === 1 && range.cols > 1) {
    col = row;
    row = 1;
  }
  if (row < 0 || col < 0) return err.value();
  if (row > range.rows || col > range.cols) return err.ref("Index is outside the range");
  if (row === 0 && col === 0) return range;
  if (row === 0) return colSlice(range, col - 1);
  if (col === 0) return rowSlice(range, row - 1);
  return range.get(row - 1, col - 1);
});
def("MATCH", 2, 3, "MATCH(key, range, [match_type])", "Position of a value in a range", ([k, a, t]) => {
  const key = single(k);
  if (isErr(key)) return key;
  const vec = vector(area(a));
  if (!vec) return err.na("MATCH needs one row or one column");
  const type = t === undefined ? 1 : int(t);
  if (isErr(type)) return type;
  if (type === 0) {
    const eq = equals(key);
    for (let i = 0; i < vec.n; i++) if (eq(vec.at(i))) return i + 1;
    return err.na(`Did not find ${String(key)}`);
  }
  const i = approx(vec.n, vec.at, key, type < 0);
  return i < 0 ? err.na() : i + 1;
});
def("ROW", 0, 1, "ROW([cell])", "Row number of a cell", ([a], ctx) => {
  if (a === undefined) return ctx.doc.tab(ctx.home)!.rows.indexOf(ctx.row) + 1;
  if (!isArea(a) || a.top === undefined) return err.value("ROW needs a reference");
  return a.top + 1;
}, { position: true });
def("COLUMN", 0, 1, "COLUMN([cell])", "Column number of a cell", ([a], ctx) => {
  if (a === undefined) return ctx.doc.tab(ctx.home)!.cols.indexOf(ctx.col) + 1;
  if (!isArea(a) || a.left === undefined) return err.value("COLUMN needs a reference");
  return a.left + 1;
}, { position: true });
def("ROWS", 1, 1, "ROWS(range)", "Number of rows in a range", ([a]) => area(a).rows, { position: true });
def("COLUMNS", 1, 1, "COLUMNS(range)", "Number of columns in a range", ([a]) => area(a).cols, { position: true });

def("TODAY", 0, 0, "TODAY()", "Today's date", (_, ctx) => Math.floor(localSerial(ctx.now)), { volatile: true });
def("NOW", 0, 0, "NOW()", "Current date and time", (_, ctx) => localSerial(ctx.now), { volatile: true });
def("DATE", 3, 3, "DATE(year, month, day)", "Builds a date", ([y, m, d]) => {
  let yy = int(y);
  const mm = int(m);
  const dd = int(d);
  if (isErr(yy)) return yy;
  if (isErr(mm)) return mm;
  if (isErr(dd)) return dd;
  if (yy >= 0 && yy < 1900) yy += 1900;
  if (yy < 0 || yy > 9999) return err.num();
  const s = dateSerial(yy, mm, dd);
  return s < 0 ? err.num() : s;
});
def("TIME", 3, 3, "TIME(hour, minute, second)", "Builds a time of day", ([h, m, s]) => {
  const hh = int(h);
  const mm = int(m);
  const ss = int(s);
  if (isErr(hh)) return hh;
  if (isErr(mm)) return mm;
  if (isErr(ss)) return ss;
  const total = hh * 3600 + mm * 60 + ss;
  if (total < 0) return err.num();
  return timeSerial(0, 0, total % 86400);
});
def("YEAR", 1, 1, "YEAR(date)", "Year of a date", ([x]) => {
  const p = parts(x);
  return isErr(p) ? p : p.y;
});
def("MONTH", 1, 1, "MONTH(date)", "Month of a date", ([x]) => {
  const p = parts(x);
  return isErr(p) ? p : p.m;
});
def("DAY", 1, 1, "DAY(date)", "Day of the month", ([x]) => {
  const p = parts(x);
  return isErr(p) ? p : p.d;
});
def("HOUR", 1, 1, "HOUR(time)", "Hour of a time", ([x]) => {
  const p = parts(x);
  return isErr(p) ? p : p.hh;
});
def("MINUTE", 1, 1, "MINUTE(time)", "Minute of a time", ([x]) => {
  const p = parts(x);
  return isErr(p) ? p : p.mm;
});
def("SECOND", 1, 1, "SECOND(time)", "Second of a time", ([x]) => {
  const p = parts(x);
  return isErr(p) ? p : p.ss;
});
def("WEEKDAY", 1, 2, "WEEKDAY(date, [type])", "Day of the week as a number", ([x, t]) => {
  const p = parts(x);
  const type = t === undefined ? 1 : int(t);
  if (isErr(p)) return p;
  if (isErr(type)) return type;
  if (type === 1) return p.wd + 1;
  if (type === 2) return ((p.wd + 6) % 7) + 1;
  if (type === 3) return (p.wd + 6) % 7;
  return err.num();
});
function addMonths(x: Value, n: Value, end: boolean): Value {
  const p = parts(x);
  const k = int(n);
  if (isErr(p)) return p;
  if (isErr(k)) return k;
  const total = p.y * 12 + (p.m - 1) + k;
  const y = Math.floor(total / 12);
  const m = (total % 12) + 1;
  const last = daysInMonth(y, m);
  return dateSerial(y, m, end ? last : Math.min(p.d, last));
}
def("EDATE", 2, 2, "EDATE(start, months)", "Date some months before or after", ([x, n]) => addMonths(x, n, false));
def("EOMONTH", 2, 2, "EOMONTH(start, months)", "Last day of a month before or after", ([x, n]) => addMonths(x, n, true));
def("DAYS", 2, 2, "DAYS(end, start)", "Days between two dates", ([a, b]) => {
  const e = num(a);
  const s = num(b);
  if (isErr(e)) return e;
  if (isErr(s)) return s;
  return Math.trunc(e) - Math.trunc(s);
});
def("DATEDIF", 3, 3, "DATEDIF(start, end, unit)", "Difference between dates in Y, M or D", ([a, b, u]) => {
  const s = parts(a);
  const e = parts(b);
  const unit = txt(u);
  if (isErr(s)) return s;
  if (isErr(e)) return e;
  if (isErr(unit)) return unit;
  const sd = dateSerial(s.y, s.m, s.d);
  const ed = dateSerial(e.y, e.m, e.d);
  if (sd > ed) return err.num("Start date is after end date");
  let months = (e.y - s.y) * 12 + (e.m - s.m);
  if (e.d < s.d) months--;
  switch (unit.toUpperCase()) {
    case "D":
      return ed - sd;
    case "M":
      return months;
    case "Y":
      return Math.floor(months / 12);
    case "YM":
      return months % 12;
    case "MD": {
      const day = e.d - s.d;
      return day >= 0 ? day : daysInMonth(e.m === 1 ? e.y - 1 : e.y, e.m === 1 ? 12 : e.m - 1) + day;
    }
    default:
      return err.num("Unit must be Y, M, D, YM or MD");
  }
});
def("NETWORKDAYS", 2, 2, "NETWORKDAYS(start, end)", "Working days between two dates", ([a, b]) => {
  const s = num(a);
  const e = num(b);
  if (isErr(s)) return s;
  if (isErr(e)) return e;
  const lo = Math.trunc(Math.min(s, e));
  const hi = Math.trunc(Math.max(s, e));
  let n = 0;
  for (let d = lo; d <= hi; d++) {
    const wd = serialParts(d).wd;
    if (wd !== 0 && wd !== 6) n++;
  }
  return s <= e ? n : -n;
});
def("DATEVALUE", 1, 1, "DATEVALUE(text)", "Converts text to a date", ([x]) => {
  const s = txt(x);
  if (isErr(s)) return s;
  const d = parseDate(s.trim());
  return d && typeof d.value === "number" ? Math.floor(d.value) : err.value(`"${s}" is not a date`);
});

const isType = (name: string, desc: string, test: (v: Scalar) => boolean) =>
  def(name, 1, 1, `${name}(value)`, desc, ([x]) => test(single(x)));
isType("ISBLANK", "TRUE if the cell is empty", (v) => v === null);
isType("ISNUMBER", "TRUE if the value is a number", (v) => typeof v === "number");
isType("ISTEXT", "TRUE if the value is text", (v) => typeof v === "string");
isType("ISLOGICAL", "TRUE if the value is TRUE or FALSE", (v) => typeof v === "boolean");
isType("ISERROR", "TRUE if the value is any error", (v) => v instanceof CellError);
isType("ISERR", "TRUE if the value is an error other than #N/A", (v) => v instanceof CellError && v.code !== "#N/A");
isType("ISNA", "TRUE if the value is #N/A", (v) => v instanceof CellError && v.code === "#N/A");
def("ISEVEN", 1, 1, "ISEVEN(number)", "TRUE if the number is even", ([x]) => {
  const n = num(x);
  return isErr(n) ? n : Math.trunc(n) % 2 === 0;
});
def("ISODD", 1, 1, "ISODD(number)", "TRUE if the number is odd", ([x]) => {
  const n = num(x);
  return isErr(n) ? n : Math.abs(Math.trunc(n) % 2) === 1;
});
def("NA", 0, 0, "NA()", "The #N/A error", () => err.na());

def("TRANSPOSE", 1, 1, "TRANSPOSE(range)", "Swaps rows and columns", ([a]) => {
  const src = area(a);
  return arrayArea(Array.from({ length: src.cols }, (_, c) => Array.from({ length: src.rows }, (_, r) => src.get(r, c))));
});

export const FUNCTIONS: Readonly<Record<string, Fn>> = F;
export const FUNCTION_NAMES = Object.keys(F).sort();
