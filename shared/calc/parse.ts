import type { Doc, Tab } from "../model.ts";
import { isFormula } from "./literal.ts";
import { ERROR_CODES, type ErrorCode } from "./values.ts";

export type End = { col: string | null; row: string | null; ca: boolean; ra: boolean; rs?: number; cs?: number };
export type Ref = { tab: string | null; a: End; b: End | null };

export type BinOp = "+" | "-" | "*" | "/" | "^" | "&" | "=" | "<>" | "<" | ">" | "<=" | ">=";

export type Node =
  | { k: "num"; v: number }
  | { k: "str"; v: string }
  | { k: "bool"; v: boolean }
  | { k: "err"; v: ErrorCode }
  | { k: "ref"; ref: Ref }
  | { k: "neg"; a: Node }
  | { k: "pos"; a: Node }
  | { k: "pct"; a: Node }
  | { k: "group"; a: Node }
  | { k: "bin"; op: BinOp; a: Node; b: Node }
  | { k: "call"; name: string; args: Node[] }
  | { k: "arr"; rows: Node[][] }
  | { k: "none" }
  | { k: "name"; v: string };

export class FormulaError extends Error {}

type RawEnd = { col: number | null; row: number | null; ca: boolean; ra: boolean };
export type RawRef = { sheet: string | null; a: RawEnd; b: RawEnd | null };

export type Tok =
  | { t: "num"; v: number; at: number; end: number }
  | { t: "str"; v: string; at: number; end: number }
  | { t: "err"; v: ErrorCode; at: number; end: number }
  | { t: "a1"; v: RawRef; at: number; end: number }
  | { t: "ids"; v: Ref; at: number; end: number }
  | { t: "id"; v: string; at: number; end: number }
  | { t: "op"; v: string; at: number; end: number }
  | { t: "punct"; v: string; at: number; end: number }
  | { t: "end"; at: number; end: number };

const isDigit = (c: string | undefined) => c !== undefined && c >= "0" && c <= "9";
const isLetter = (c: string | undefined) => c !== undefined && ((c >= "a" && c <= "z") || (c >= "A" && c <= "Z"));

export function colIndex(letters: string): number {
  let n = 0;
  for (const ch of letters.toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

export function colName(index: number): string {
  let s = "";
  let n = index + 1;
  while (n > 0) {
    const r = (n - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

export function cellName(col: number, row: number): string {
  return colName(col) + (row + 1);
}

const END_RE = /(\$?)([A-Za-z]{1,3})?(\$?)(\d{1,7})?/y;
const SHEET_RE = /[A-Za-z_][A-Za-z0-9_.]*!/y;
const NUM_RE = /(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/y;
const IDENT_RE = /[A-Za-z_][A-Za-z0-9_.]*/y;

type Scanned = RawEnd & { end: number };

function scanEnd(src: string, j: number): Scanned | null {
  END_RE.lastIndex = j;
  const m = END_RE.exec(src);
  if (!m || m[0].length === 0) return null;
  const [, d1, letters, d2, digits] = m;
  if (!letters && !digits) return null;
  if (letters && !digits && d2) return null;
  const row = digits ? Number(digits) - 1 : null;
  if (row !== null && row < 0) return null;
  return {
    col: letters ? colIndex(letters) : null,
    row,
    ca: !!letters && d1 === "$",
    ra: !!digits && (letters ? d2 === "$" : d1 === "$" || d2 === "$"),
    end: j + m[0].length,
  };
}

function scanRef(src: string, i: number): { ref: RawRef; end: number } | null {
  let j = i;
  let sheet: string | null = null;
  if (src[j] === "'") {
    let name = "";
    j++;
    for (;;) {
      if (j >= src.length) return null;
      if (src[j] === "'") {
        if (src[j + 1] === "'") {
          name += "'";
          j += 2;
          continue;
        }
        j++;
        break;
      }
      name += src[j++];
    }
    if (src[j] !== "!") return null;
    sheet = name;
    j++;
  } else {
    SHEET_RE.lastIndex = j;
    const m = SHEET_RE.exec(src);
    if (m) {
      sheet = m[0].slice(0, -1);
      j += m[0].length;
    }
  }
  const a = scanEnd(src, j);
  if (!a) return null;
  j = a.end;
  let b: Scanned | null = null;
  if (src[j] === ":") {
    b = scanEnd(src, j + 1);
    if (b) j = b.end;
  }
  if (/[A-Za-z0-9_.(!$:']/.test(src[j] ?? "")) return null;
  const strip = (e: Scanned): RawEnd => ({ col: e.col, row: e.row, ca: e.ca, ra: e.ra });
  const cellA = a.col !== null && a.row !== null;
  if (!b) return cellA ? { ref: { sheet, a: strip(a), b: null }, end: j } : null;
  const ok =
    (cellA && b.col !== null) ||
    (a.col !== null && a.row === null && b.col !== null && b.row === null) ||
    (a.col === null && a.row !== null && b.col === null && b.row !== null);
  return ok ? { ref: { sheet, a: strip(a), b: strip(b) }, end: j } : null;
}

function idEnd(col: string, row: string): End {
  return {
    col: col ? col.replace("$", "") : null,
    row: row ? row.replace("$", "") : null,
    ca: col.startsWith("$"),
    ra: row.startsWith("$"),
  };
}

export function lex(src: string, canonical: boolean): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (ch === " " || ch === "\t" || ch === "\n" || ch === "\r") {
      i++;
      continue;
    }
    const at = i;
    if (ch === '"') {
      let s = "";
      i++;
      for (;;) {
        if (i >= src.length) throw new FormulaError("Missing closing quote");
        if (src[i] === '"') {
          if (src[i + 1] === '"') {
            s += '"';
            i += 2;
            continue;
          }
          i++;
          break;
        }
        s += src[i++];
      }
      out.push({ t: "str", v: s, at, end: i });
      continue;
    }
    if (ch === "#") {
      const rest = src.slice(i, i + 8).toUpperCase();
      const code = ERROR_CODES.filter((c) => rest.startsWith(c)).sort((x, y) => y.length - x.length)[0];
      if (!code) throw new FormulaError("Unknown error value");
      i += code.length;
      out.push({ t: "err", v: code, at, end: i });
      continue;
    }
    if (ch === "[") {
      if (!canonical) throw new FormulaError("Unexpected [");
      const close = src.indexOf("]", i);
      if (close < 0) throw new FormulaError("Bad reference");
      const parts = src.slice(i + 1, close).split("|");
      if (parts.length !== 3 && parts.length !== 5) throw new FormulaError("Bad reference");
      const ref: Ref = { tab: parts[0] || null, a: idEnd(parts[1], parts[2]), b: parts.length === 5 ? idEnd(parts[3], parts[4]) : null };
      i = close + 1;
      out.push({ t: "ids", v: ref, at, end: i });
      continue;
    }
    if (!canonical && (ch === "'" || ch === "$" || ch === "_" || isLetter(ch) || isDigit(ch))) {
      const r = scanRef(src, i);
      if (r) {
        i = r.end;
        out.push({ t: "a1", v: r.ref, at, end: i });
        continue;
      }
    }
    if (isDigit(ch) || (ch === "." && isDigit(src[i + 1]))) {
      NUM_RE.lastIndex = i;
      const m = NUM_RE.exec(src)!;
      i += m[0].length;
      out.push({ t: "num", v: Number(m[0]), at, end: i });
      continue;
    }
    if (isLetter(ch) || ch === "_") {
      IDENT_RE.lastIndex = i;
      const m = IDENT_RE.exec(src)!;
      i += m[0].length;
      out.push({ t: "id", v: m[0], at, end: i });
      continue;
    }
    const two = src.slice(i, i + 2);
    if (two === "<>" || two === "<=" || two === ">=") {
      i += 2;
      out.push({ t: "op", v: two, at, end: i });
      continue;
    }
    if ("+-*/^&=<>%".includes(ch)) {
      i++;
      out.push({ t: "op", v: ch, at, end: i });
      continue;
    }
    if ("(),{};".includes(ch)) {
      i++;
      out.push({ t: "punct", v: ch, at, end: i });
      continue;
    }
    throw new FormulaError(`Unexpected "${ch}"`);
  }
  out.push({ t: "end", at: src.length, end: src.length });
  return out;
}

const BIN: Record<string, number> = { "=": 10, "<>": 10, "<": 10, ">": 10, "<=": 10, ">=": 10, "&": 20, "+": 30, "-": 30, "*": 40, "/": 40, "^": 50 };
const PCT = 60;
const UNARY = 70;

type Resolve = (raw: RawRef) => Ref | null;

class Parser {
  private toks: Tok[];
  private i = 0;
  private resolve: Resolve | null;

  constructor(toks: Tok[], resolve: Resolve | null) {
    this.toks = toks;
    this.resolve = resolve;
  }

  private peek(): Tok {
    return this.toks[this.i];
  }

  private next(): Tok {
    return this.toks[this.i++];
  }

  private isPunct(v: string): boolean {
    const t = this.peek();
    return t.t === "punct" && t.v === v;
  }

  parse(): Node {
    const node = this.expr(0);
    const t = this.peek();
    if (t.t !== "end") throw new FormulaError("Unexpected text after the formula");
    return node;
  }

  private expr(min: number): Node {
    let lhs = this.prefix();
    for (;;) {
      const t = this.peek();
      if (t.t !== "op") break;
      if (t.v === "%") {
        if (PCT < min) break;
        this.i++;
        lhs = { k: "pct", a: lhs };
        continue;
      }
      const bp = BIN[t.v];
      if (bp === undefined || bp < min) break;
      this.i++;
      const rhs = this.expr(bp + 1);
      lhs = { k: "bin", op: t.v as BinOp, a: lhs, b: rhs };
    }
    return lhs;
  }

  private prefix(): Node {
    const t = this.next();
    switch (t.t) {
      case "num":
        return { k: "num", v: t.v };
      case "str":
        return { k: "str", v: t.v };
      case "err":
        return { k: "err", v: t.v };
      case "ids":
        return { k: "ref", ref: t.v };
      case "a1": {
        const ref = this.resolve ? this.resolve(t.v) : null;
        return ref ? { k: "ref", ref } : { k: "err", v: "#REF!" };
      }
      case "id": {
        const name = t.v.toUpperCase();
        if (this.isPunct("(")) {
          this.i++;
          return { k: "call", name, args: this.args() };
        }
        if (name === "TRUE" || name === "FALSE") return { k: "bool", v: name === "TRUE" };
        return { k: "name", v: t.v };
      }
      case "op":
        if (t.v === "-" || t.v === "+") {
          const a = this.expr(UNARY);
          return t.v === "-" ? { k: "neg", a } : { k: "pos", a };
        }
        break;
      case "punct":
        if (t.v === "(") {
          const a = this.expr(0);
          if (!this.isPunct(")")) throw new FormulaError("Missing closing parenthesis");
          this.i++;
          return { k: "group", a };
        }
        if (t.v === "{") return this.array();
        break;
      case "end":
        throw new FormulaError("Formula ends too early");
    }
    throw new FormulaError(`Unexpected "${"v" in t ? t.v : ""}"`);
  }

  private args(): Node[] {
    const args: Node[] = [];
    if (this.isPunct(")")) {
      this.i++;
      return args;
    }
    for (;;) {
      args.push(this.isPunct(",") || this.isPunct(")") ? { k: "none" } : this.expr(0));
      const t = this.next();
      if (t.t === "punct" && t.v === ",") continue;
      if (t.t === "punct" && t.v === ")") return args;
      throw new FormulaError(t.t === "end" ? "Missing closing parenthesis" : "Expected , or )");
    }
  }

  private array(): Node {
    const rows: Node[][] = [[]];
    for (;;) {
      const item = this.expr(0);
      const ok = item.k === "num" || item.k === "str" || item.k === "bool" || item.k === "err" || (item.k === "neg" && item.a.k === "num");
      if (!ok) throw new FormulaError("Arrays can only hold constants");
      rows[rows.length - 1].push(item);
      const t = this.next();
      if (t.t === "punct" && t.v === ",") continue;
      if (t.t === "punct" && t.v === ";") {
        rows.push([]);
        continue;
      }
      if (t.t === "punct" && t.v === "}") break;
      throw new FormulaError("Bad array");
    }
    if (rows.some((r) => r.length !== rows[0].length)) throw new FormulaError("Array rows must be the same length");
    return { k: "arr", rows };
  }
}

function resolver(doc: Doc, home: string): Resolve {
  return (raw) => {
    const tab = raw.sheet === null ? doc.tab(home) : doc.findTab(raw.sheet);
    if (!tab || tab.dead) return null;
    const end = (e: RawEnd): End | null => {
      const col = e.col === null ? null : tab.cols.idAt(e.col);
      const row = e.row === null ? null : tab.rows.idAt(e.row);
      if (col === undefined || row === undefined) return null;
      return { col, row, ca: e.ca, ra: e.ra };
    };
    const a = end(raw.a);
    if (!a) return null;
    let b: End | null = null;
    if (raw.b) {
      b = end(raw.b);
      if (!b) return null;
    }
    return { tab: raw.sheet === null ? null : tab.id, a, b };
  };
}

export function parseA1(src: string, doc: Doc, home: string): Node {
  return new Parser(lex(src, false), resolver(doc, home)).parse();
}

export function parseCanonical(src: string): Node {
  return new Parser(lex(src, true), null).parse();
}

function numText(v: number): string {
  return String(v).toUpperCase();
}

function print(node: Node, ref: (r: Ref) => string): string {
  const p = (n: Node) => print(n, ref);
  switch (node.k) {
    case "num":
      return numText(node.v);
    case "str":
      return '"' + node.v.replace(/"/g, '""') + '"';
    case "bool":
      return node.v ? "TRUE" : "FALSE";
    case "err":
      return node.v;
    case "ref":
      return ref(node.ref);
    case "neg":
      return "-" + p(node.a);
    case "pos":
      return "+" + p(node.a);
    case "pct":
      return p(node.a) + "%";
    case "group":
      return "(" + p(node.a) + ")";
    case "bin":
      return p(node.a) + node.op + p(node.b);
    case "call":
      return node.name + "(" + node.args.map(p).join(",") + ")";
    case "arr":
      return "{" + node.rows.map((r) => r.map(p).join(",")).join(";") + "}";
    case "none":
      return "";
    case "name":
      return node.v;
  }
}

const idPart = (id: string | null, abs: boolean) => (id === null ? "" : (abs ? "$" : "") + id);

export function canonicalRef(r: Ref): string {
  const a = idPart(r.a.col, r.a.ca) + "|" + idPart(r.a.row, r.a.ra);
  const b = r.b ? "|" + idPart(r.b.col, r.b.ca) + "|" + idPart(r.b.row, r.b.ra) : "";
  return "[" + (r.tab ?? "") + "|" + a + b + "]";
}

export function toCanonical(node: Node): string {
  return print(node, canonicalRef);
}

export type Located = {
  tab: Tab;
  single: boolean;
  c0: number | null;
  c1: number | null;
  r0: number | null;
  r1: number | null;
};

export function locate(ref: Ref, doc: Doc, home: string): Located | null {
  const tab = doc.tab(ref.tab ?? home);
  if (!tab || tab.dead) return null;
  const { a, b } = ref;
  if (!b) {
    if (a.col === null || a.row === null) return null;
    const c = tab.cols.indexOf(a.col);
    const r = tab.rows.indexOf(a.row);
    if (c < 0 || r < 0) return null;
    return { tab, single: true, c0: c, c1: c, r0: r, r1: r };
  }
  let c0: number | null = null;
  let c1: number | null = null;
  let r0: number | null = null;
  let r1: number | null = null;
  if (a.col !== null && b.col !== null) {
    const span = tab.cols.span(a.col, b.col);
    if (!span) return null;
    [c0, c1] = [span[0], span[1] - 1];
  } else if (a.col !== null || b.col !== null) return null;
  if (a.row !== null) {
    const span = tab.rows.span(a.row, b.row);
    if (!span) return null;
    r0 = span[0];
    r1 = b.row === null ? null : span[1] - 1;
  } else if (b.row !== null) return null;
  if (c0 === null && r0 === null) return null;
  return { tab, single: false, c0, c1, r0, r1 };
}

export function quoteSheet(name: string): string {
  if (/^[A-Za-z_][A-Za-z0-9_.]*$/.test(name) && !scanRef(name + "+", 0)) return name;
  return "'" + name.replace(/'/g, "''") + "'";
}

function a1Ref(r: Ref, doc: Doc, home: string): string {
  const loc = locate(r, doc, home);
  if (!loc) return "#REF!";
  const prefix = r.tab !== null ? quoteSheet(loc.tab.name) + "!" : "";
  const col = (i: number | null, abs: boolean) => (i === null ? "" : (abs ? "$" : "") + colName(i));
  const row = (i: number | null, abs: boolean) => (i === null ? "" : (abs ? "$" : "") + (i + 1));
  const start = col(loc.c0, r.a.ca) + row(loc.r0, r.a.ra);
  if (loc.single || !r.b) return prefix + start;
  return prefix + start + ":" + col(loc.c1, r.b.ca) + row(loc.r1, r.b.ra);
}

export function toA1(node: Node, doc: Doc, home: string): string {
  return print(node, (r) => a1Ref(r, doc, home));
}

export function shiftRef(r: Ref, doc: Doc, srcHome: string, dstHome: string, dr: number, dc: number): Ref | null {
  const loc = locate(r, doc, srcHome);
  if (!loc) return null;
  const dst = doc.tab(r.tab ?? dstHome);
  if (!dst || dst.dead) return null;
  const move = (i: number | null, abs: boolean, d: number) => (i === null ? null : abs ? i : i + d);
  const colId = (i: number | null): string | null | undefined => (i === null ? null : dst.cols.idAt(i));
  const rowId = (i: number | null): string | null | undefined => (i === null ? null : dst.rows.idAt(i));
  const ac = colId(move(loc.c0, r.a.ca, dc));
  const ar = rowId(move(loc.r0, r.a.ra, dr));
  if (ac === undefined || ar === undefined) return null;
  const a: End = { col: ac, row: ar, ca: r.a.ca, ra: r.a.ra };
  if (!r.b) return { tab: r.tab, a, b: null };
  const bc = colId(move(loc.c1, r.b.ca, dc));
  const br = r.b.row === null ? null : rowId(move(loc.r1, r.b.ra, dr));
  if (bc === undefined || br === undefined) return null;
  return { tab: r.tab, a, b: { col: bc, row: br, ca: r.b.ca, ra: r.b.ra } };
}

function mapRefs(node: Node, fn: (r: Ref) => Node): Node {
  const m = (n: Node) => mapRefs(n, fn);
  switch (node.k) {
    case "ref":
      return fn(node.ref);
    case "neg":
    case "pos":
    case "pct":
    case "group":
      return { ...node, a: m(node.a) };
    case "bin":
      return { ...node, a: m(node.a), b: m(node.b) };
    case "call":
      return { ...node, args: node.args.map(m) };
    default:
      return node;
  }
}

export function walk(node: Node, fn: (n: Node) => void): void {
  fn(node);
  switch (node.k) {
    case "neg":
    case "pos":
    case "pct":
    case "group":
      walk(node.a, fn);
      break;
    case "bin":
      walk(node.a, fn);
      walk(node.b, fn);
      break;
    case "call":
      for (const a of node.args) walk(a, fn);
      break;
    case "arr":
      for (const row of node.rows) for (const a of row) walk(a, fn);
      break;
  }
}

export function compileInput(input: string, doc: Doc, home: string): string {
  if (!isFormula(input)) return input;
  try {
    return "=" + toCanonical(parseA1(input.slice(1), doc, home));
  } catch {
    return input;
  }
}

export function displayInput(input: string | null, doc: Doc, home: string): string {
  if (input === null) return "";
  if (!isFormula(input)) return input;
  try {
    return "=" + toA1(parseCanonical(input.slice(1)), doc, home);
  } catch {
    return input;
  }
}

export function shiftInput(input: string, doc: Doc, srcHome: string, dstHome: string, dr: number, dc: number): string {
  if (!isFormula(input)) return input;
  try {
    const node = parseCanonical(input.slice(1));
    const moved = mapRefs(node, (r): Node => {
      const s = shiftRef(r, doc, srcHome, dstHome, dr, dc);
      return s ? { k: "ref", ref: s } : { k: "err", v: "#REF!" };
    });
    return "=" + toCanonical(moved);
  } catch {
    return input;
  }
}
