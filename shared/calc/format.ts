import { CellError, type Scalar, serialParts } from "./values.ts";

export const NUMBER_FORMATS = ["general", "number", "percent", "currency", "date", "time", "datetime", "text"] as const;

export type FormatKind = (typeof NUMBER_FORMATS)[number];

export const FORMAT_PATTERN = /^(general|date|time|datetime|text|(number|percent|currency):(10|[0-9]))$/;

export function parseFormat(nf: string | null | undefined): { kind: FormatKind; decimals: number } {
  if (!nf || !FORMAT_PATTERN.test(nf)) return { kind: "general", decimals: 0 };
  const [kind, d] = nf.split(":");
  return { kind: kind as FormatKind, decimals: d === undefined ? 0 : Number(d) };
}

function trimZeros(s: string): string {
  if (!s.includes(".")) return s;
  return s.replace(/\.?0+$/, "");
}

export function generalNumber(n: number): string {
  if (!Number.isFinite(n)) return "#NUM!";
  if (n === 0) return "0";
  const abs = Math.abs(n);
  if (Number.isInteger(n) && abs < 1e15) return String(n);
  if (abs >= 1e15 || abs < 1e-9) {
    const [m, e] = n.toExponential(5).split("e");
    const exp = Number(e);
    return `${trimZeros(m)}E${exp < 0 ? "-" : "+"}${String(Math.abs(exp)).padStart(2, "0")}`;
  }
  const p = Number(n.toPrecision(10));
  if (abs >= 1e-6) return String(p);
  return trimZeros(p.toFixed(Math.min(20, 10 - Math.floor(Math.log10(abs)) - 1)));
}

export function grouped(n: number, decimals: number): string {
  const fixed = Math.abs(n).toFixed(decimals);
  const [int, frac] = fixed.split(".");
  const withCommas = int.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const sign = n < 0 && Number(fixed) !== 0 ? "-" : "";
  return sign + withCommas + (frac ? "." + frac : "");
}

const pad2 = (n: number) => String(n).padStart(2, "0");

function clock12(hh: number, mm: number, ss: number): string {
  const h = hh % 12 === 0 ? 12 : hh % 12;
  return `${h}:${pad2(mm)}:${pad2(ss)} ${hh < 12 ? "AM" : "PM"}`;
}

export function formatDate(n: number, kind: "date" | "time" | "datetime"): string {
  if (n < -657435 || n > 2958465) return "#NUM!";
  const p = serialParts(n);
  const date = `${p.m}/${p.d}/${p.y}`;
  if (kind === "date") return date;
  if (kind === "time") return clock12(p.hh, p.mm, p.ss);
  return `${date} ${p.hh}:${pad2(p.mm)}:${pad2(p.ss)}`;
}

export function formatValue(v: Scalar, nf: string | null | undefined): string {
  if (v === null) return "";
  if (v instanceof CellError) return v.code;
  if (typeof v === "boolean") return v ? "TRUE" : "FALSE";
  if (typeof v === "string") return v;
  const { kind, decimals } = parseFormat(nf);
  switch (kind) {
    case "number":
      return grouped(v, decimals);
    case "percent":
      return (v * 100).toFixed(decimals) + "%";
    case "currency": {
      const s = grouped(v, decimals);
      return s.startsWith("-") ? "-$" + s.slice(1) : "$" + s;
    }
    case "date":
    case "time":
    case "datetime":
      return formatDate(v, kind);
    default:
      return generalNumber(v);
  }
}

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

function dateCode(n: number, code: string): string {
  const p = serialParts(n);
  const ampm = /am\/pm|a\/p/i.test(code);
  const tokens = code.match(/yyyy|yy|mmmm|mmm|mm|m|dddd|ddd|dd|d|hh|h|ss|s|am\/pm|a\/p|"[^"]*"|./gi) ?? [];
  const lower = tokens.map((t) => t.toLowerCase());
  const isTime = (t: string | undefined) => t === "h" || t === "hh" || t === "s" || t === "ss";
  const near = (i: number, step: number) => {
    for (let j = i + step; j >= 0 && j < lower.length; j += step) {
      if (lower[j] === ":" || lower[j] === " ") continue;
      return lower[j];
    }
    return undefined;
  };
  let out = "";
  tokens.forEach((raw, i) => {
    const t = lower[i];
    if (t === "yyyy") out += String(p.y);
    else if (t === "yy") out += pad2(p.y % 100);
    else if (t === "mmmm") out += MONTHS[p.m - 1];
    else if (t === "mmm") out += MONTHS[p.m - 1].slice(0, 3);
    else if (t === "mm" || t === "m") {
      const minute = isTime(near(i, -1)) || isTime(near(i, 1));
      const value = minute ? p.mm : p.m;
      out += t === "mm" ? pad2(value) : String(value);
    } else if (t === "dddd") out += DAYS[p.wd];
    else if (t === "ddd") out += DAYS[p.wd].slice(0, 3);
    else if (t === "dd") out += pad2(p.d);
    else if (t === "d") out += String(p.d);
    else if (t === "hh" || t === "h") {
      const h = ampm ? (p.hh % 12 === 0 ? 12 : p.hh % 12) : p.hh;
      out += t === "hh" ? pad2(h) : String(h);
    } else if (t === "ss") out += pad2(p.ss);
    else if (t === "s") out += String(p.ss);
    else if (t === "am/pm") out += p.hh < 12 ? "AM" : "PM";
    else if (t === "a/p") out += p.hh < 12 ? "A" : "P";
    else if (raw.startsWith('"')) out += raw.slice(1, -1);
    else out += raw;
  });
  return out;
}

function numberCode(n: number, code: string): string {
  const plain = code.replace(/"([^"]*)"/g, "$1");
  const m = /[#0,.]*[#0][#0,.]*/.exec(plain);
  if (!m) return plain;
  const prefix = plain.slice(0, m.index);
  const suffix = plain.slice(m.index + m[0].length);
  const [intPart, fracPart = ""] = m[0].split(".");
  const percent = (prefix + suffix).includes("%");
  const value = percent ? n * 100 : n;
  const decimals = fracPart.replace(/[^#0]/g, "").length;
  const mandatory = (fracPart.match(/0/g) ?? []).length;
  const minInt = (intPart.match(/0/g) ?? []).length;
  const fixed = Math.abs(value).toFixed(decimals);
  let [int, frac = ""] = fixed.split(".");
  while (frac.length > mandatory && frac.endsWith("0")) frac = frac.slice(0, -1);
  if (minInt === 0 && int === "0") int = "";
  int = int.padStart(minInt, "0");
  if (intPart.includes(",")) int = int.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const body = int + (frac ? "." + frac : "");
  const sign = value < 0 && /[1-9]/.test(body) ? "-" : "";
  return sign + prefix + body + suffix;
}

export function formatCode(v: Scalar, code: string): string {
  if (typeof v !== "number") return formatValue(v, null);
  if (code === "") return "";
  if (/^general$/i.test(code)) return generalNumber(v);
  const stripped = code.replace(/"[^"]*"/g, "");
  if (/[#0]/.test(stripped)) return numberCode(v, code);
  if (/[ymdhs]/i.test(stripped)) return dateCode(v, code);
  return code.replace(/"/g, "");
}
