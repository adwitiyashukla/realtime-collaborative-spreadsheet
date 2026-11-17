import type { Cell, Column, Doc } from "../model.ts";
import { FUNCTIONS } from "./functions.ts";
import { isFormula, parseLiteral, toNumber, toText } from "./literal.ts";
import { type BinOp, type Node, type Ref, locate } from "./parse.ts";
import { type Area, CellError, type Scalar, type Value, arrayArea, compare, err, isArea, single } from "./values.ts";

export interface Ctx {
  doc: Doc;
  home: string;
  row: string;
  col: string;
  now: number;
  rand: () => number;
}

export function cellValue(cell: Cell | undefined): Scalar {
  if (!cell || cell.v === undefined) return null;
  if (cell.p !== undefined) return cell.p;
  if (isFormula(cell.v)) return null;
  if (cell.s?.nf === "text") {
    cell.p = cell.v;
    cell.h = null;
    return cell.v;
  }
  const lit = parseLiteral(cell.v);
  cell.p = lit.value;
  cell.h = lit.nf;
  return lit.value;
}

const MAX_ARRAY = 2_000_000;

export function refArea(ref: Ref, ctx: Ctx): Area | CellError {
  const loc = locate(ref, ctx.doc, ctx.home);
  if (!loc) return err.ref();
  const tab = loc.tab;
  const r0 = loc.r0 ?? 0;
  const r1 = loc.r1 ?? tab.rows.count - 1;
  const c0 = loc.c0 ?? 0;
  const c1 = loc.c1 ?? tab.cols.count - 1;
  const nr = r1 - r0 + 1;
  const nc = c1 - c0 + 1;
  if (nr <= 0 || nc <= 0) return err.ref();
  const rowSlots = tab.rows.liveSlots;
  const colSlots = tab.cols.liveSlots;
  const columns: (Column | undefined)[] = [];
  for (let c = c0; c <= c1; c++) columns.push(tab.column(colSlots[c]));
  return {
    rows: nr,
    cols: nc,
    top: r0,
    left: c0,
    get: (r, c) => {
      if (r >= nr || c >= nc) return null;
      const column = columns[c];
      return column ? cellValue(column[rowSlots[r0 + r]]) : null;
    },
  };
}

function refScalar(ref: Ref, ctx: Ctx): Scalar {
  const tab = ctx.doc.tabs.get(ref.tab ?? ctx.home);
  const a = ref.a;
  if (!tab || tab.dead || a.row === null || a.col === null) return err.ref();
  let rs = a.rs;
  if (rs === undefined || tab.rows.idOfSlot(rs) !== a.row) rs = a.rs = tab.rows.slot(a.row);
  let cs = a.cs;
  if (cs === undefined || tab.cols.idOfSlot(cs) !== a.col) cs = a.cs = tab.cols.slot(a.col);
  if (!tab.rows.isLiveSlot(rs) || !tab.cols.isLiveSlot(cs)) return err.ref();
  return cellValue(tab.column(cs)?.[rs]);
}

function operand(v: Value): Value {
  return isArea(v) && v.rows === 1 && v.cols === 1 ? v.get(0, 0) : v;
}

function scalarNode(node: Node, ctx: Ctx): Value {
  if (node.k === "ref" && node.ref.b === null) return refScalar(node.ref, ctx);
  return operand(evaluate(node, ctx));
}

function round15(n: number): number {
  return n === 0 ? 0 : Number(n.toPrecision(15));
}

function scalarOp(op: BinOp, a: Scalar, b: Scalar): Scalar {
  if (a instanceof CellError) return a;
  if (b instanceof CellError) return b;
  switch (op) {
    case "+":
    case "-":
    case "*":
    case "/":
    case "^": {
      const x = toNumber(a);
      if (x instanceof CellError) return x;
      const y = toNumber(b);
      if (y instanceof CellError) return y;
      let r: number;
      if (op === "+" || op === "-") {
        r = op === "+" ? x + y : x - y;
        if (r !== 0 && Math.abs(r) < Math.max(Math.abs(x), Math.abs(y)) * 1e-15) r = 0;
      } else if (op === "*") r = x * y;
      else if (op === "/") {
        if (y === 0) return err.div0();
        r = x / y;
      } else {
        if (x === 0 && y < 0) return err.div0();
        r = Math.pow(x, y);
      }
      return Number.isFinite(r) ? r : err.num();
    }
    case "&": {
      const x = toText(a);
      if (x instanceof CellError) return x;
      const y = toText(b);
      if (y instanceof CellError) return y;
      return x + y;
    }
    default: {
      const c = typeof a === "number" && typeof b === "number" ? compare(round15(a), round15(b)) : compare(a, b);
      switch (op) {
        case "=":
          return c === 0;
        case "<>":
          return c !== 0;
        case "<":
          return c < 0;
        case ">":
          return c > 0;
        case "<=":
          return c <= 0;
        default:
          return c >= 0;
      }
    }
  }
}

function broadcast(a: Value, b: Value, f: (x: Scalar, y: Scalar) => Scalar): Value {
  const ar = isArea(a) ? a.rows : 1;
  const ac = isArea(a) ? a.cols : 1;
  const br = isArea(b) ? b.rows : 1;
  const bc = isArea(b) ? b.cols : 1;
  const rows = Math.max(ar, br);
  const cols = Math.max(ac, bc);
  if (rows * cols > MAX_ARRAY) return err.num("Array is too large");
  const pick = (x: Value, xr: number, xc: number, r: number, c: number): Scalar => {
    if (!isArea(x)) return x;
    const rr = xr === 1 ? 0 : r;
    const cc = xc === 1 ? 0 : c;
    return rr < xr && cc < xc ? x.get(rr, cc) : err.na();
  };
  const data: Scalar[][] = [];
  for (let r = 0; r < rows; r++) {
    const row: Scalar[] = [];
    for (let c = 0; c < cols; c++) row.push(f(pick(a, ar, ac, r, c), pick(b, br, bc, r, c)));
    data.push(row);
  }
  return arrayArea(data);
}

function unary(x: Value, f: (x: Scalar) => Scalar): Value {
  return isArea(x) ? broadcast(x, null, (p) => f(p)) : f(x);
}

export function evaluate(node: Node, ctx: Ctx): Value {
  switch (node.k) {
    case "num":
    case "str":
    case "bool":
      return node.v;
    case "err":
      return new CellError(node.v);
    case "none":
      return null;
    case "name":
      return err.name(`Unknown name ${node.v}`);
    case "ref":
      return refArea(node.ref, ctx);
    case "group":
    case "pos":
      return evaluate(node.a, ctx);
    case "neg":
    case "pct":
      return unary(scalarNode(node.a, ctx), (x) => {
        const n = toNumber(x);
        if (n instanceof CellError) return n;
        return node.k === "neg" ? -n : n / 100;
      });
    case "bin": {
      const a = scalarNode(node.a, ctx);
      const b = scalarNode(node.b, ctx);
      if (!isArea(a) && !isArea(b)) return scalarOp(node.op, a, b);
      return broadcast(a, b, (x, y) => scalarOp(node.op, x, y));
    }
    case "arr":
      return arrayArea(node.rows.map((r) => r.map((n) => single(evaluate(n, ctx)))));
    case "call": {
      const spec = FUNCTIONS[node.name];
      if (!spec) return err.name(`Unknown function ${node.name}`);
      const n = node.args.length;
      if (n < spec.min || n > spec.max) {
        const want = spec.min === spec.max ? `${spec.min}` : spec.max === Infinity ? `at least ${spec.min}` : `${spec.min} to ${spec.max}`;
        return err.na(`${node.name} expects ${want} arguments, got ${n}`);
      }
      if (spec.lazy) return spec.lazy(node.args, (a) => evaluate(a, ctx), ctx);
      return spec.fn!(node.args.map((a) => evaluate(a, ctx)), ctx);
    }
  }
}

export function evaluateCell(node: Node, ctx: Ctx): Scalar {
  const v = single(scalarNode(node, ctx));
  if (typeof v === "number" && !Number.isFinite(v)) return err.num();
  return v;
}
