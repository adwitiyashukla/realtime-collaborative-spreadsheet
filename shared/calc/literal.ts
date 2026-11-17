import {
  CellError,
  ERROR_CODES,
  type ErrorCode,
  type Scalar,
  dateSerial,
  daysInMonth,
  err,
  numberToText,
  timeSerial,
} from "./values.ts";

export type Literal = { value: Scalar; nf: string | null };

const NUM = /^[+-]?(?:\d{1,3}(?:,\d{3})+|\d+)?(?:\.\d*)?(?:[eE][+-]?\d+)?$/;
const ISO_DATE = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?$/;
const US_DATE = /^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*([AaPp][Mm])?)?$/;
const TIME = /^(\d{1,2}):(\d{2})(?::(\d{2}))?\s*([AaPp][Mm])?$/;

export function isFormula(input: string | null | undefined): input is string {
  return typeof input === "string" && input.length > 1 && input[0] === "=";
}

function decimals(s: string): number {
  if (/[eE]/.test(s)) return 2;
  const dot = s.indexOf(".");
  return dot < 0 ? 0 : Math.min(10, s.length - dot - 1);
}

function plainNumber(s: string): number | null {
  if (!NUM.test(s) || !/\d/.test(s)) return null;
  const n = Number(s.replace(/,/g, ""));
  return Number.isFinite(n) ? n : null;
}

function hours(h: number, ampm: string | undefined): number | null {
  if (!ampm) return h < 24 ? h : null;
  if (h < 1 || h > 12) return null;
  const pm = ampm.toLowerCase() === "pm";
  return (h % 12) + (pm ? 12 : 0);
}

function datePart(y: number, m: number, d: number): number | null {
  if (m < 1 || m > 12 || d < 1 || d > daysInMonth(y, m)) return null;
  return dateSerial(y, m, d);
}

function clock(h: string | undefined, m: string | undefined, s: string | undefined, ampm: string | undefined): number | null {
  if (h === undefined || m === undefined) return 0;
  const hh = hours(Number(h), ampm);
  const mm = Number(m);
  const ss = s === undefined ? 0 : Number(s);
  if (hh === null || mm > 59 || ss > 59) return null;
  return timeSerial(hh, mm, ss);
}

export function parseDate(s: string): Literal | null {
  let m = ISO_DATE.exec(s);
  if (m) {
    const day = datePart(Number(m[1]), Number(m[2]), Number(m[3]));
    const time = clock(m[4], m[5], m[6], undefined);
    if (day === null || time === null) return null;
    return { value: day + time, nf: m[4] === undefined ? "date" : "datetime" };
  }
  m = US_DATE.exec(s);
  if (m) {
    let y = Number(m[3]);
    if (m[3].length === 2) y += y < 30 ? 2000 : 1900;
    const day = datePart(y, Number(m[1]), Number(m[2]));
    const time = clock(m[4], m[5], m[6], m[7]);
    if (day === null || time === null) return null;
    return { value: day + time, nf: m[4] === undefined ? "date" : "datetime" };
  }
  m = TIME.exec(s);
  if (m) {
    const time = clock(m[1], m[2], m[3], m[4]);
    if (time === null) return null;
    return { value: time, nf: "time" };
  }
  return null;
}

export function parseNumber(text: string): Literal | null {
  const s = text.trim();
  if (s === "") return null;
  const n = plainNumber(s);
  if (n !== null) return { value: n, nf: s.includes(",") ? `number:${decimals(s)}` : null };
  if (s.endsWith("%")) {
    const inner = s.slice(0, -1).trim();
    const p = plainNumber(inner);
    if (p !== null) return { value: p / 100, nf: `percent:${decimals(inner)}` };
  }
  const cur = /^([+-]?)\$\s*(-?)(.+)$/.exec(s);
  if (cur) {
    const p = plainNumber(cur[3]);
    if (p !== null) {
      const sign = cur[1] === "-" || cur[2] === "-" ? -1 : 1;
      const d = Math.min(10, Math.max(2, decimals(cur[3])));
      return { value: sign * p, nf: `currency:${d}` };
    }
  }
  return parseDate(s);
}

export function parseLiteral(input: string | null | undefined): Literal {
  if (input === null || input === undefined || input === "") return { value: null, nf: null };
  if (input[0] === "'") return { value: input.slice(1), nf: null };
  const s = input.trim();
  const upper = s.toUpperCase();
  if (upper === "TRUE") return { value: true, nf: null };
  if (upper === "FALSE") return { value: false, nf: null };
  if ((ERROR_CODES as string[]).includes(upper)) return { value: new CellError(upper as ErrorCode), nf: null };
  return parseNumber(s) ?? { value: input, nf: null };
}

export function toNumber(v: Scalar): number | CellError {
  if (typeof v === "number") return v;
  if (v === null) return 0;
  if (typeof v === "boolean") return v ? 1 : 0;
  if (v instanceof CellError) return v;
  const lit = parseNumber(v);
  if (lit && typeof lit.value === "number") return lit.value;
  return err.value(`"${v.length > 20 ? v.slice(0, 20) + "..." : v}" is not a number`);
}

export function toText(v: Scalar): string | CellError {
  if (typeof v === "string") return v;
  if (v === null) return "";
  if (typeof v === "boolean") return v ? "TRUE" : "FALSE";
  if (v instanceof CellError) return v;
  return numberToText(v);
}

export function toBool(v: Scalar): boolean | CellError {
  if (typeof v === "boolean") return v;
  if (v === null) return false;
  if (typeof v === "number") return v !== 0;
  if (v instanceof CellError) return v;
  const u = v.trim().toUpperCase();
  if (u === "TRUE") return true;
  if (u === "FALSE") return false;
  return err.value(`"${v}" is not TRUE or FALSE`);
}
