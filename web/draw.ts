import type { Calc } from "../shared/calc/engine.ts";
import { colName, lex } from "../shared/calc/parse.ts";
import { CellError } from "../shared/calc/values.ts";
import type { Doc, Tab } from "../shared/model.ts";
import type { Peer } from "../shared/protocol.ts";
import type { Rect } from "./sheet.ts";

export const HEADER_H = 24;
export const ROW_H = 22;
export const COL_W = 100;
export const FONT = '"Segoe UI", system-ui, -apple-system, Roboto, "Helvetica Neue", Arial, sans-serif';
const REF_COLORS = ["#1a73e8", "#d93025", "#7b1fa2", "#188038", "#e37400", "#00838f"];

export class Layout {
  rowPos: Float64Array;
  colPos: Float64Array;
  headerW: number;

  constructor(tab: Tab) {
    const rows = tab.rows.live;
    const cols = tab.cols.live;
    this.rowPos = new Float64Array(rows.length + 1);
    this.colPos = new Float64Array(cols.length + 1);
    const rs = tab.rows.sizes;
    const cs = tab.cols.sizes;
    for (let i = 0; i < rows.length; i++) this.rowPos[i + 1] = this.rowPos[i] + (rs.size ? (rs.get(rows[i]) ?? ROW_H) : ROW_H);
    for (let i = 0; i < cols.length; i++) this.colPos[i + 1] = this.colPos[i] + (cs.get(cols[i]) ?? COL_W);
    this.headerW = Math.max(42, 14 + 8 * String(rows.length).length);
  }

  get rows(): number {
    return this.rowPos.length - 1;
  }

  get cols(): number {
    return this.colPos.length - 1;
  }

  get width(): number {
    return this.headerW + this.colPos[this.cols];
  }

  get height(): number {
    return HEADER_H + this.rowPos[this.rows];
  }

  private static find(pos: Float64Array, v: number): number {
    let lo = 0;
    let hi = pos.length - 2;
    if (hi < 0) return 0;
    if (v <= 0) return 0;
    if (v >= pos[hi + 1]) return hi;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (pos[mid] <= v) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  }

  rowAt(y: number): number {
    return Layout.find(this.rowPos, y);
  }

  colAt(x: number): number {
    return Layout.find(this.colPos, x);
  }

  top(r: number): number {
    return HEADER_H + this.rowPos[r];
  }

  left(c: number): number {
    return this.headerW + this.colPos[c];
  }

  rowH(r: number): number {
    return this.rowPos[r + 1] - this.rowPos[r];
  }

  colW(c: number): number {
    return this.colPos[c + 1] - this.colPos[c];
  }
}

export type Theme = {
  dark: boolean;
  paper: string;
  desk: string;
  ink: string;
  pencil: string;
  rule: string;
  ruleStrong: string;
  ledger: string;
  band: string;
  bandStrong: string;
  mark: string;
  selFill: string;
};

let theme: Theme | null = null;
let probe: CanvasRenderingContext2D | null = null;
const shades = new Map<string, string>();

function normalize(color: string): string {
  probe ??= document.createElement("canvas").getContext("2d");
  if (!probe) return color;
  probe.fillStyle = "#000000";
  probe.fillStyle = color;
  return String(probe.fillStyle);
}

function rgb(hex: string): number[] {
  const n = parseInt(hex.slice(1, 7), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function toHex(c: number[]): string {
  return "#" + c.map((v) => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, "0")).join("");
}

function mix(a: string, b: string, t: number): string {
  const x = rgb(a);
  const y = rgb(b);
  return toHex(x.map((v, i) => v + (y[i] - v) * t));
}

function luminance(hex: string): number {
  const [r, g, b] = rgb(hex).map((v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a: string, b: string): number {
  const x = luminance(a);
  const y = luminance(b);
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

function shade(hex: string): string {
  const [r, g, b] = rgb(hex).map((v) => v / 255);
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  const s = d === 0 ? 0 : d / (1 - Math.abs(max + min - 1));
  let h = 0;
  if (d) h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  h = (h * 60 + 360) % 360;
  const l = 0.2;
  const c = (1 - Math.abs(2 * l - 1)) * Math.min(s, 0.45);
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const parts = h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x] : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
  return toHex(parts.map((v) => (v + l - c / 2) * 255));
}

export function fillColor(bg: string): string {
  if (!readTheme().dark) return bg;
  let v = shades.get(bg);
  if (!v) {
    v = shade(bg);
    shades.set(bg, v);
  }
  return v;
}

export function textColor(fg: string | undefined, bg: string | undefined): string {
  const th = readTheme();
  const base = fg ?? th.ink;
  const back = bg ? fillColor(bg) : th.paper;
  const key = `${base}${back}`;
  let v = shades.get(key);
  if (v) return v;
  v = base;
  if (contrast(base, back) < 3) {
    const toward = luminance(back) > 0.18 ? "#000000" : "#ffffff";
    v = toward;
    for (let k = 1; k < 10; k++) {
      const c = mix(base, toward, k / 10);
      if (contrast(c, back) >= 3) {
        v = c;
        break;
      }
    }
  }
  shades.set(key, v);
  return v;
}

export function readTheme(): Theme {
  if (theme) return theme;
  const css = getComputedStyle(document.documentElement);
  const v = (name: string) => normalize(css.getPropertyValue(name).trim());
  const paper = v("--paper");
  theme = {
    dark: luminance(paper) < 0.2,
    paper,
    desk: v("--desk"),
    ink: v("--ink"),
    pencil: v("--pencil"),
    rule: v("--rule"),
    ruleStrong: v("--rule-strong"),
    ledger: v("--ledger"),
    band: v("--band"),
    bandStrong: v("--band-strong"),
    mark: v("--mark"),
    selFill: v("--sel-fill"),
  };
  return theme;
}

export function resetTheme(): void {
  theme = null;
  shades.clear();
}

export type RefMark = { rect: Rect; color: string };

export function formulaRefs(draft: string, doc: Doc, tab: Tab): RefMark[] {
  if (!draft.startsWith("=")) return [];
  let toks;
  try {
    toks = lex(draft.slice(1), false);
  } catch {
    return [];
  }
  const out: RefMark[] = [];
  for (const t of toks) {
    if (t.t !== "a1") continue;
    const ref = t.v;
    if (ref.sheet !== null && doc.findTab(ref.sheet)?.id !== tab.id) continue;
    const maxR = tab.rows.count - 1;
    const maxC = tab.cols.count - 1;
    const a = ref.a;
    const b = ref.b ?? ref.a;
    const r0 = a.row ?? 0;
    const r1 = ref.b ? (b.row ?? maxR) : (a.row ?? 0);
    const c0 = a.col ?? 0;
    const c1 = ref.b ? (b.col ?? maxC) : (a.col ?? 0);
    out.push({
      rect: { r0: Math.min(r0, r1), r1: Math.min(maxR, Math.max(r0, r1)), c0: Math.min(c0, c1), c1: Math.min(maxC, Math.max(c0, c1)) },
      color: REF_COLORS[out.length % REF_COLORS.length],
    });
  }
  return out;
}

export type Paint = {
  ctx: CanvasRenderingContext2D;
  width: number;
  height: number;
  dpr: number;
  tab: Tab;
  calc: Calc;
  layout: Layout;
  x: number;
  y: number;
  sel: Rect;
  active: { r: number; c: number };
  editing: boolean;
  fillTarget: Rect | null;
  clip: Rect | null;
  peers: Peer[];
  refs: RefMark[];
  focused: boolean;
};

function textFor(calc: Calc, tab: Tab, row: string, col: string): { text: string; kind: "num" | "text" | "center" | "error" } | null {
  const cell = tab.cell(row, col);
  if (!cell || cell.v === undefined) return null;
  const value = calc.value(tab.id, row, col);
  const text = calc.display(tab.id, row, col);
  if (value instanceof CellError) return { text, kind: "error" };
  if (typeof value === "number") return { text, kind: "num" };
  if (typeof value === "boolean") return { text, kind: "center" };
  return { text, kind: "text" };
}

export function paint(p: Paint): void {
  const { ctx, layout, tab, calc } = p;
  const th = readTheme();
  ctx.setTransform(p.dpr, 0, 0, p.dpr, 0, 0);
  ctx.fillStyle = th.paper;
  ctx.fillRect(0, 0, p.width, p.height);
  if (layout.rows === 0 || layout.cols === 0) return;
  const hw = layout.headerW;
  const r0 = layout.rowAt(p.y);
  const r1 = layout.rowAt(p.y + p.height - HEADER_H);
  const c0 = layout.colAt(p.x);
  const c1 = layout.colAt(p.x + p.width - hw);
  const rows = tab.rows.live;
  const cols = tab.cols.live;
  const X = (c: number) => layout.left(c) - p.x;
  const Y = (r: number) => layout.top(r) - p.y;

  ctx.save();
  ctx.beginPath();
  ctx.rect(hw, HEADER_H, p.width - hw, p.height - HEADER_H);
  ctx.clip();

  for (let r = r0; r <= r1; r++) {
    const row = rows[r];
    for (let c = c0; c <= c1; c++) {
      const bg = tab.cell(row, cols[c])?.s?.bg;
      if (!bg) continue;
      ctx.fillStyle = fillColor(bg);
      ctx.fillRect(X(c), Y(r), layout.colW(c), layout.rowH(r));
    }
  }

  ctx.strokeStyle = th.rule;
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let r = r0; r <= r1 + 1; r++) {
    const y = Math.round(Y(r)) - 0.5;
    ctx.moveTo(hw, y);
    ctx.lineTo(p.width, y);
  }
  for (let c = c0; c <= c1 + 1; c++) {
    const x = Math.round(X(c)) - 0.5;
    ctx.moveTo(x, HEADER_H);
    ctx.lineTo(x, p.height);
  }
  ctx.stroke();

  ctx.textBaseline = "middle";
  for (let r = r0; r <= r1; r++) {
    const row = rows[r];
    const y = Y(r);
    const h = layout.rowH(r);
    for (let c = c0; c <= c1; c++) {
      const col = cols[c];
      const shown = textFor(calc, tab, row, col);
      if (!shown || shown.text === "") continue;
      const s = tab.cell(row, col)?.s;
      const x = X(c);
      const w = layout.colW(c);
      const align = s?.al ?? (shown.kind === "num" ? "right" : shown.kind === "text" ? "left" : "center");
      ctx.font = `${s?.i ? "italic " : ""}${s?.b ? "bold " : ""}13px ${FONT}`;
      ctx.fillStyle = textColor(s?.fg ?? (shown.kind === "error" ? th.mark : undefined), s?.bg);
      let clipW = w;
      if (align === "left" && shown.kind === "text") {
        const need = ctx.measureText(shown.text).width + 8;
        let k = c + 1;
        while (need > clipW && k < cols.length && k <= c1 + 20 && !tab.cell(row, cols[k])?.v) {
          clipW += layout.colW(k);
          k++;
        }
      }
      ctx.save();
      ctx.beginPath();
      ctx.rect(x + 1, y + 1, clipW - 2, h - 2);
      ctx.clip();
      const tx = align === "left" ? x + 4 : align === "right" ? x + w - 4 : x + w / 2;
      ctx.textAlign = align;
      const ty = y + h / 2 + 1;
      ctx.fillText(shown.text, tx, ty);
      if (s?.u || s?.st) {
        const tw = ctx.measureText(shown.text).width;
        const sx = align === "left" ? tx : align === "right" ? tx - tw : tx - tw / 2;
        ctx.fillRect(sx, s.u ? ty + 7 : ty, tw, 1);
        if (s.u && s.st) ctx.fillRect(sx, ty, tw, 1);
      }
      ctx.restore();
    }
  }

  const box = (rect: Rect) => {
    const x = X(rect.c0);
    const y = Y(rect.r0);
    return { x, y, w: X(rect.c1 + 1) - x, h: Y(rect.r1 + 1) - y };
  };
  const visible = (rect: Rect) => rect.r1 >= r0 && rect.r0 <= r1 && rect.c1 >= c0 && rect.c0 <= c1;

  for (const ref of p.refs) {
    if (!visible(ref.rect)) continue;
    const b = box(ref.rect);
    ctx.fillStyle = ref.color + "1f";
    ctx.fillRect(b.x, b.y, b.w, b.h);
    ctx.strokeStyle = ref.color;
    ctx.lineWidth = 2;
    ctx.setLineDash([]);
    ctx.strokeRect(b.x + 1, b.y + 1, b.w - 2, b.h - 2);
  }

  for (const peer of p.peers) {
    if (!peer.sel || peer.tab !== tab.id) continue;
    const [ar, ac, fr, fc] = peer.sel;
    if (!tab.rows.has(ar) || !tab.cols.has(ac)) continue;
    const a = { r: tab.rows.nearest(ar), c: tab.cols.nearest(ac) };
    const f = tab.rows.has(fr) && tab.cols.has(fc) ? { r: tab.rows.nearest(fr), c: tab.cols.nearest(fc) } : a;
    const range = { r0: Math.min(a.r, f.r), r1: Math.max(a.r, f.r), c0: Math.min(a.c, f.c), c1: Math.max(a.c, f.c) };
    if (!visible(range)) continue;
    const b = box(range);
    ctx.fillStyle = peer.color + "14";
    ctx.fillRect(b.x, b.y, b.w, b.h);
    const cellBox = box({ r0: a.r, r1: a.r, c0: a.c, c1: a.c });
    ctx.strokeStyle = peer.color;
    ctx.lineWidth = 2;
    ctx.setLineDash(peer.editing ? [4, 3] : []);
    ctx.strokeRect(cellBox.x + 1, cellBox.y + 1, cellBox.w - 2, cellBox.h - 2);
    ctx.setLineDash([]);
    ctx.font = `600 11px ${FONT}`;
    const label = peer.name;
    const lw = ctx.measureText(label).width + 10;
    const lx = cellBox.x + cellBox.w - lw;
    const ly = cellBox.y - 16;
    ctx.fillStyle = peer.color;
    ctx.beginPath();
    ctx.roundRect(lx, ly, lw, 16, [3, 3, 0, 3]);
    ctx.fill();
    ctx.fillStyle = "#ffffff";
    ctx.textAlign = "left";
    ctx.fillText(label, lx + 5, ly + 8.5);
  }

  if (p.clip && visible(p.clip)) {
    const b = box(p.clip);
    ctx.strokeStyle = th.ledger;
    ctx.lineWidth = 1.5;
    ctx.setLineDash([5, 4]);
    ctx.strokeRect(b.x + 1, b.y + 1, b.w - 2, b.h - 2);
    ctx.setLineDash([]);
  }

  if (visible(p.sel)) {
    const b = box(p.sel);
    const single = p.sel.r0 === p.sel.r1 && p.sel.c0 === p.sel.c1;
    if (!single) {
      ctx.fillStyle = th.selFill;
      ctx.fillRect(b.x, b.y, b.w, b.h);
      const ab = box({ r0: p.active.r, r1: p.active.r, c0: p.active.c, c1: p.active.c });
      ctx.fillStyle = th.paper;
      const bg = tab.cell(rows[p.active.r], cols[p.active.c])?.s?.bg;
      if (bg) ctx.fillStyle = fillColor(bg);
      ctx.fillRect(ab.x + 1, ab.y + 1, ab.w - 2, ab.h - 2);
      const shown = textFor(calc, tab, rows[p.active.r], cols[p.active.c]);
      if (shown && !p.editing) {
        const s = tab.cell(rows[p.active.r], cols[p.active.c])?.s;
        const align = s?.al ?? (shown.kind === "num" ? "right" : shown.kind === "text" ? "left" : "center");
        ctx.font = `${s?.i ? "italic " : ""}${s?.b ? "bold " : ""}13px ${FONT}`;
        ctx.fillStyle = textColor(s?.fg ?? (shown.kind === "error" ? th.mark : undefined), s?.bg);
        ctx.textAlign = align;
        ctx.save();
        ctx.beginPath();
        ctx.rect(ab.x + 1, ab.y + 1, ab.w - 2, ab.h - 2);
        ctx.clip();
        ctx.fillText(shown.text, align === "left" ? ab.x + 4 : align === "right" ? ab.x + ab.w - 4 : ab.x + ab.w / 2, ab.y + ab.h / 2 + 1);
        ctx.restore();
      }
      ctx.strokeStyle = th.ledger;
      ctx.lineWidth = 1;
      ctx.strokeRect(b.x + 0.5, b.y + 0.5, b.w - 1, b.h - 1);
    }
    const ab = box({ r0: p.active.r, r1: p.active.r, c0: p.active.c, c1: p.active.c });
    ctx.strokeStyle = p.focused || p.editing ? th.ledger : th.pencil;
    ctx.lineWidth = 2;
    ctx.strokeRect(ab.x + 1, ab.y + 1, ab.w - 2, ab.h - 2);
    if (!p.editing) {
      ctx.fillStyle = th.ledger;
      ctx.fillRect(b.x + b.w - 4, b.y + b.h - 4, 7, 7);
      ctx.strokeStyle = th.paper;
      ctx.lineWidth = 1;
      ctx.strokeRect(b.x + b.w - 4.5, b.y + b.h - 4.5, 8, 8);
    }
  }

  if (p.fillTarget && visible(p.fillTarget)) {
    const b = box(p.fillTarget);
    ctx.strokeStyle = th.pencil;
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 3]);
    ctx.strokeRect(b.x + 0.5, b.y + 0.5, b.w - 1, b.h - 1);
    ctx.setLineDash([]);
  }
  ctx.restore();

  const fullCols = p.sel.r0 === 0 && p.sel.r1 === layout.rows - 1;
  const fullRows = p.sel.c0 === 0 && p.sel.c1 === layout.cols - 1;
  ctx.fillStyle = th.desk;
  ctx.fillRect(0, 0, p.width, HEADER_H);
  ctx.fillRect(0, 0, hw, p.height);
  ctx.font = `12px ${FONT}`;
  ctx.textAlign = "center";
  for (let c = c0; c <= c1; c++) {
    const x = X(c);
    const w = layout.colW(c);
    const on = c >= p.sel.c0 && c <= p.sel.c1;
    if (on) {
      ctx.fillStyle = fullCols ? th.bandStrong : th.band;
      ctx.fillRect(x, 0, w, HEADER_H);
    }
    ctx.fillStyle = on ? th.ink : th.pencil;
    ctx.font = `${on ? "600 " : ""}12px ${FONT}`;
    ctx.fillText(colName(c), x + w / 2, HEADER_H / 2 + 1);
  }
  for (let r = r0; r <= r1; r++) {
    const y = Y(r);
    if (y + layout.rowH(r) < HEADER_H) continue;
    const on = r >= p.sel.r0 && r <= p.sel.r1;
    if (on) {
      ctx.fillStyle = fullRows ? th.bandStrong : th.band;
      ctx.fillRect(0, Math.max(y, HEADER_H), hw, layout.rowH(r));
    }
    ctx.fillStyle = on ? th.ink : th.pencil;
    ctx.font = `${on ? "600 " : ""}12px ${FONT}`;
    ctx.fillText(String(r + 1), hw / 2, y + layout.rowH(r) / 2 + 1);
  }
  ctx.fillStyle = th.desk;
  ctx.fillRect(0, 0, hw, HEADER_H);
  ctx.strokeStyle = th.ruleStrong;
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let c = c0; c <= c1 + 1; c++) {
    const x = Math.round(X(c)) - 0.5;
    if (x < hw) continue;
    ctx.moveTo(x, 0);
    ctx.lineTo(x, HEADER_H);
  }
  for (let r = r0; r <= r1 + 1; r++) {
    const y = Math.round(Y(r)) - 0.5;
    if (y < HEADER_H) continue;
    ctx.moveTo(0, y);
    ctx.lineTo(hw, y);
  }
  ctx.moveTo(0, HEADER_H - 0.5);
  ctx.lineTo(p.width, HEADER_H - 0.5);
  ctx.moveTo(hw - 0.5, 0);
  ctx.lineTo(hw - 0.5, p.height);
  ctx.stroke();
}
