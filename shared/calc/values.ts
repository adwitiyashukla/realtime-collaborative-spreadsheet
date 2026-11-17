export type ErrorCode =
  | "#NULL!"
  | "#DIV/0!"
  | "#VALUE!"
  | "#REF!"
  | "#NAME?"
  | "#NUM!"
  | "#N/A"
  | "#ERROR!"
  | "#CYCLE!";

export const ERROR_CODES: ErrorCode[] = ["#NULL!", "#DIV/0!", "#VALUE!", "#REF!", "#NAME?", "#NUM!", "#N/A", "#ERROR!", "#CYCLE!"];

export class CellError {
  readonly code: ErrorCode;
  readonly message: string;

  constructor(code: ErrorCode, message = "") {
    this.code = code;
    this.message = message;
  }
}

export type Scalar = number | string | boolean | null | CellError;

export interface Area {
  rows: number;
  cols: number;
  get(r: number, c: number): Scalar;
  top?: number;
  left?: number;
}

export type Value = Scalar | Area;

export const err = {
  div0: (m = "Division by zero") => new CellError("#DIV/0!", m),
  value: (m = "Wrong type of value") => new CellError("#VALUE!", m),
  ref: (m = "Reference does not exist") => new CellError("#REF!", m),
  name: (m = "Unknown function or name") => new CellError("#NAME?", m),
  num: (m = "Number out of range") => new CellError("#NUM!", m),
  na: (m = "Value not available") => new CellError("#N/A", m),
};

export function isArea(v: Value | undefined): v is Area {
  return typeof v === "object" && v !== null && !(v instanceof CellError);
}

export function arrayArea(data: Scalar[][]): Area {
  const rows = data.length;
  const cols = rows ? Math.max(...data.map((r) => r.length)) : 0;
  return { rows, cols, get: (r, c) => data[r]?.[c] ?? null };
}

export function single(v: Value): Scalar {
  if (!isArea(v)) return v;
  if (v.rows === 1 && v.cols === 1) return v.get(0, 0);
  if (v.rows === 0 || v.cols === 0) return err.ref();
  return err.value("Expected a single value but got a range");
}

export function cells(a: Area, cb: (v: Scalar, r: number, c: number) => boolean | void): void {
  for (let r = 0; r < a.rows; r++) {
    for (let c = 0; c < a.cols; c++) {
      if (cb(a.get(r, c), r, c) === false) return;
    }
  }
}

function trimZeros(s: string): string {
  if (!s.includes(".")) return s;
  return s.replace(/\.?0+$/, "");
}

export function numberToText(n: number): string {
  if (n === 0) return "0";
  const abs = Math.abs(n);
  if (abs >= 1e15 || abs < 1e-9) {
    const [m, e] = n.toExponential(14).split("e");
    const exp = Number(e);
    return `${trimZeros(m)}E${exp < 0 ? "-" : "+"}${String(Math.abs(exp)).padStart(2, "0")}`;
  }
  const p = Number(n.toPrecision(15));
  if (abs >= 1e-6) return String(p);
  const digits = Math.min(20, 15 - Math.floor(Math.log10(abs)) - 1);
  return trimZeros(p.toFixed(digits));
}

const DAY_MS = 86400000;
const EPOCH = Date.UTC(1899, 11, 30);

export function dateSerial(y: number, m: number, d: number): number {
  return Math.round((Date.UTC(y, m - 1, d) - EPOCH) / DAY_MS);
}

export function timeSerial(h: number, m: number, s: number): number {
  return (h * 3600 + m * 60 + s) / 86400;
}

export type DateParts = { y: number; m: number; d: number; hh: number; mm: number; ss: number; wd: number };

export function serialParts(serial: number): DateParts {
  let days = Math.floor(serial);
  let secs = Math.round((serial - days) * 86400);
  if (secs >= 86400) {
    days += 1;
    secs -= 86400;
  }
  const date = new Date(EPOCH + days * DAY_MS);
  return {
    y: date.getUTCFullYear(),
    m: date.getUTCMonth() + 1,
    d: date.getUTCDate(),
    hh: Math.floor(secs / 3600),
    mm: Math.floor((secs % 3600) / 60),
    ss: secs % 60,
    wd: date.getUTCDay(),
  };
}

export function localSerial(ms: number): number {
  const d = new Date(ms);
  return dateSerial(d.getFullYear(), d.getMonth() + 1, d.getDate()) + timeSerial(d.getHours(), d.getMinutes(), d.getSeconds());
}

export function daysInMonth(y: number, m: number): number {
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

function rank(v: Scalar): number {
  if (typeof v === "number") return 0;
  if (typeof v === "string") return 1;
  return 2;
}

function blankLike(v: Scalar): Scalar {
  if (typeof v === "string") return "";
  if (typeof v === "boolean") return false;
  return 0;
}

export function compare(a: Scalar, b: Scalar): number {
  if (a === null && b === null) return 0;
  if (a === null) a = blankLike(b);
  if (b === null) b = blankLike(a);
  const ra = rank(a);
  const rb = rank(b);
  if (ra !== rb) return ra < rb ? -1 : 1;
  if (typeof a === "string" && typeof b === "string") {
    const x = a.toLowerCase();
    const y = b.toLowerCase();
    return x < y ? -1 : x > y ? 1 : 0;
  }
  if (typeof a === "number" && typeof b === "number") return a < b ? -1 : a > b ? 1 : 0;
  return a === b ? 0 : a ? 1 : -1;
}
