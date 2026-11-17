import type { Calc } from "../shared/calc/engine.ts";
import { parseFormat } from "../shared/calc/format.ts";
import { isFormula, parseLiteral } from "../shared/calc/literal.ts";
import { cellName, colIndex, compileInput, displayInput, shiftInput } from "../shared/calc/parse.ts";
import { parseCsv } from "../shared/csv.ts";
import { idMaker } from "../shared/ids.ts";
import { type Axis, type Doc, MAX_SIZE, MIN_SIZE, type Op, type Style, type StylePatch, type Tab, validTabName } from "../shared/model.ts";
import { Layout } from "./draw.ts";
import type { LiveSheet } from "./live.ts";

export type Pos = { row: string; col: string };
export type Rect = { r0: number; r1: number; c0: number; c1: number };
export type Editing = { value: string; mode: "enter" | "edit"; origin: "cell" | "bar"; caret: number; ref: [number, number] | null };
type Clip = { text: string; tab: string; rect: Rect; inputs: (string | null)[][]; styles: (Style | undefined)[][]; cut: boolean };

const STYLE_KEYS: (keyof Style)[] = ["b", "i", "u", "st", "fg", "bg", "al", "nf"];
const REF_SLOT = /(^=|[(,+\-*/^&=<>:;{]\s*)$/;

function escapeHtml(s: string): string {
  return s.replace(/[&<>"]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[ch]!);
}

function tsvField(s: string): string {
  return /[\t\n\r"]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

function fullPatch(s: Style | undefined): StylePatch {
  const patch: Record<string, unknown> = {};
  for (const k of STYLE_KEYS) patch[k] = s?.[k] ?? null;
  return patch as StylePatch;
}

function series(values: (string | null)[]): ((k: number) => string | null) | null {
  const nums = values.map((v) => (v !== null && !isFormula(v) ? parseLiteral(v) : null));
  if (values.length >= 2 && nums.every((n) => n && typeof n.value === "number")) {
    const xs = nums.map((n) => n!.value as number);
    const step = xs[1] - xs[0];
    if (xs.every((x, i) => i === 0 || Math.abs(x - xs[i - 1] - step) < 1e-9)) {
      const nf = nums[0]!.nf;
      const last = xs[xs.length - 1];
      return (k) => {
        const v = Math.round((last + step * (k + 1)) * 1e10) / 1e10;
        if (nf === "date") {
          const d = new Date(Date.UTC(1899, 11, 30) + v * 86400000);
          return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
        }
        if (nf?.startsWith("percent")) return `${Math.round(v * 1e12) / 1e10}%`;
        if (nf?.startsWith("currency")) return v < 0 ? `-$${-v}` : `$${v}`;
        return String(v);
      };
    }
  }
  return null;
}

export class SheetView {
  live: LiveSheet;
  tabId = "";
  anchor: Pos = { row: "", col: "" };
  focus: Pos = { row: "", col: "" };
  editing: Editing | null = null;
  clip: Clip | null = null;
  preview: { doc: Doc; calc: Calc; label: string; id: number } | null = null;
  version = 0;
  pageRows = 25;
  private reveal: ((r: number, c: number) => void) | null = null;
  private grid: { key: string; layout: Layout } | null = null;
  private listeners = new Set<() => void>();
  private next = idMaker();
  private remembered = new Map<string, [Pos, Pos]>();

  constructor(live: LiveSheet) {
    this.live = live;
    live.subscribe(() => this.sync());
    this.sync();
  }

  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };

  private emit(): void {
    this.version++;
    for (const fn of this.listeners) fn();
  }

  get doc(): Doc | null {
    return this.preview?.doc ?? this.live.doc;
  }

  get calc(): Calc | null {
    return this.preview?.calc ?? this.live.calc;
  }

  get tab(): Tab | null {
    return this.doc?.tab(this.tabId) ?? null;
  }

  layout(): Layout | null {
    const t = this.tab;
    if (!t) return null;
    const key = `${this.preview?.id ?? "live"}:${t.id}:${this.live.structure}`;
    if (this.grid?.key !== key) this.grid = { key, layout: new Layout(t) };
    return this.grid.layout;
  }

  setReveal(fn: ((r: number, c: number) => void) | null): void {
    this.reveal = fn;
  }

  setPageRows(rows: number): void {
    this.pageRows = rows;
  }

  get readOnly(): boolean {
    return !!this.preview || this.live.role === "viewer" || this.live.status === "closed" || !this.live.doc;
  }

  sync(): void {
    const doc = this.doc;
    if (!doc) return this.emit();
    let tab = doc.tab(this.tabId);
    if (!tab || tab.dead) {
      tab = doc.liveTabs()[0];
      this.tabId = tab.id;
      this.anchor = { row: "", col: "" };
      if (this.editing) this.editing = null;
    }
    if (!tab.rows.has(this.anchor.row) || !tab.cols.has(this.anchor.col)) {
      this.anchor = { row: tab.rows.idAt(0)!, col: tab.cols.idAt(0)! };
      this.focus = { ...this.anchor };
    }
    if (!tab.rows.has(this.focus.row) || !tab.cols.has(this.focus.col)) this.focus = { ...this.anchor };
    this.emit();
  }

  index(p: Pos): { r: number; c: number } {
    const t = this.tab!;
    return { r: t.rows.nearest(p.row), c: t.cols.nearest(p.col) };
  }

  pos(r: number, c: number): Pos {
    const t = this.tab!;
    const rr = Math.max(0, Math.min(t.rows.count - 1, r));
    const cc = Math.max(0, Math.min(t.cols.count - 1, c));
    return { row: t.rows.idAt(rr)!, col: t.cols.idAt(cc)! };
  }

  active(): { r: number; c: number } {
    return this.index(this.anchor);
  }

  rect(): Rect {
    const a = this.index(this.anchor);
    const b = this.index(this.focus);
    return { r0: Math.min(a.r, b.r), r1: Math.max(a.r, b.r), c0: Math.min(a.c, b.c), c1: Math.max(a.c, b.c) };
  }

  rectName(): string {
    return this.rectNameOf(this.rect());
  }

  rectNameOf(r: Rect): string {
    const t = this.tab;
    if (!t) return "";
    if (r.r0 === r.r1 && r.c0 === r.c1) return cellName(r.c0, r.r0);
    if (r.r0 === 0 && r.r1 === t.rows.count - 1) return `${cellName(r.c0, 0).replace(/\d+$/, "")}:${cellName(r.c1, 0).replace(/\d+$/, "")}`;
    return `${cellName(r.c0, r.r0)}:${cellName(r.c1, r.r1)}`;
  }

  private selected(): void {
    this.emit();
    this.sendPresence();
  }

  sendPresence(): void {
    if (this.preview || !this.live.doc) return;
    this.live.presence(this.tabId, [this.anchor.row, this.anchor.col, this.focus.row, this.focus.col], !!this.editing);
  }

  select(r: number, c: number, extend = false): void {
    const p = this.pos(r, c);
    if (extend) this.focus = p;
    else {
      this.anchor = p;
      this.focus = { ...p };
    }
    const f = this.index(this.focus);
    this.reveal?.(f.r, f.c);
    this.selected();
  }

  selectRect(r0: number, c0: number, r1: number, c1: number): void {
    this.anchor = this.pos(r0, c0);
    this.focus = this.pos(r1, c1);
    this.reveal?.(Math.max(0, r0), Math.max(0, c0));
    this.selected();
  }

  selectRows(r0: number, r1: number): void {
    const t = this.tab!;
    this.anchor = this.pos(r0, 0);
    this.focus = this.pos(r1, t.cols.count - 1);
    this.selected();
  }

  selectCols(c0: number, c1: number): void {
    const t = this.tab!;
    this.anchor = this.pos(0, c0);
    this.focus = this.pos(t.rows.count - 1, c1);
    this.selected();
  }

  selectAll(): void {
    const t = this.tab!;
    this.anchor = this.pos(0, 0);
    this.focus = this.pos(t.rows.count - 1, t.cols.count - 1);
    this.selected();
  }

  move(dr: number, dc: number, extend = false): void {
    const from = extend ? this.index(this.focus) : this.active();
    this.select(from.r + dr, from.c + dc, extend);
  }

  jump(dr: number, dc: number, extend = false): void {
    const t = this.tab!;
    const from = extend ? this.index(this.focus) : this.active();
    const inside = (r: number, c: number) => r >= 0 && c >= 0 && r < t.rows.count && c < t.cols.count;
    const has = (r: number, c: number) => t.input(t.rows.idAt(r)!, t.cols.idAt(c)!) !== null;
    let r = from.r + dr;
    let c = from.c + dc;
    if (!inside(r, c)) return;
    if (has(from.r, from.c) && has(r, c)) {
      while (inside(r + dr, c + dc) && has(r + dr, c + dc)) {
        r += dr;
        c += dc;
      }
    } else {
      while (inside(r, c) && !has(r, c)) {
        r += dr;
        c += dc;
      }
      if (!inside(r, c)) {
        r -= dr;
        c -= dc;
      }
    }
    this.select(r, c, extend);
  }

  goto(text: string): boolean {
    const m = /^\s*(?:(.+)!)?([A-Za-z]{1,3})(\d{1,7})(?::([A-Za-z]{1,3})(\d{1,7}))?\s*$/.exec(text);
    if (!m || !this.doc) return false;
    if (m[1]) {
      const tab = this.doc.findTab(m[1].replace(/^'|'$/g, ""));
      if (!tab) return false;
      this.switchTab(tab.id);
    }
    const c0 = colIndex(m[2]);
    const r0 = Number(m[3]) - 1;
    if (m[4]) this.selectRect(r0, c0, Number(m[5]) - 1, colIndex(m[4]));
    else this.select(r0, c0);
    return true;
  }

  inputAt(r: number, c: number): string {
    const t = this.tab;
    if (!t || !this.doc) return "";
    const p = this.pos(r, c);
    return displayInput(t.input(p.row, p.col), this.doc, t.id);
  }

  display(r: number, c: number): string {
    const t = this.tab;
    if (!t || !this.calc) return "";
    const p = this.pos(r, c);
    return this.calc.display(t.id, p.row, p.col);
  }

  describeActive(): string {
    const { r, c } = this.active();
    const input = this.inputAt(r, c);
    const shown = this.display(r, c);
    if (!input) return `${cellName(c, r)}, empty`;
    return isFormula(input) ? `${cellName(c, r)}, ${shown}, formula ${input}` : `${cellName(c, r)}, ${shown}`;
  }

  startEdit(initial: string | null, mode: Editing["mode"], origin: Editing["origin"] = "cell"): void {
    if (this.readOnly) return;
    const { r, c } = this.active();
    const value = initial ?? this.inputAt(r, c);
    this.editing = { value, mode, origin, caret: value.length, ref: null };
    this.selected();
  }

  editInBar(caret: number): void {
    if (this.readOnly) return;
    if (this.editing) this.editing.origin = "bar";
    else this.startEdit(null, "edit", "bar");
    if (this.editing) this.draft(this.editing.value, caret);
  }

  draft(value: string, caret: number): void {
    if (!this.editing) return;
    this.editing = { ...this.editing, value, caret, ref: null };
    this.emit();
  }

  canPoint(): boolean {
    const e = this.editing;
    if (!e || !isFormula(e.value)) return false;
    if (e.ref) return true;
    return REF_SLOT.test(e.value.slice(0, e.caret));
  }

  point(rect: Rect, tabId: string): void {
    const e = this.editing;
    if (!e || !this.doc) return;
    const one = rect.r0 === rect.r1 && rect.c0 === rect.c1;
    let text = one ? cellName(rect.c0, rect.r0) : `${cellName(rect.c0, rect.r0)}:${cellName(rect.c1, rect.r1)}`;
    if (tabId !== this.tabId) {
      const name = this.doc.tab(tabId)!.name;
      text = (/^[A-Za-z_][A-Za-z0-9_.]*$/.test(name) ? name : `'${name.replace(/'/g, "''")}'`) + "!" + text;
    }
    const [start, end] = e.ref ?? [e.caret, e.caret];
    const value = e.value.slice(0, start) + text + e.value.slice(end);
    this.editing = { ...e, value, caret: start + text.length, ref: [start, start + text.length], mode: "edit" };
    this.emit();
  }

  commit(dr = 0, dc = 0): void {
    const e = this.editing;
    if (!e) return;
    this.editing = null;
    const { r, c } = this.active();
    if (e.value !== this.inputAt(r, c)) this.setInputs([[r, c, e.value]]);
    if (dr || dc) this.move(dr, dc);
    else this.selected();
  }

  cancel(): void {
    if (!this.editing) return;
    this.editing = null;
    this.selected();
  }

  private ensureSize(rows: number, cols: number): boolean {
    const t = this.tab!;
    const ops: Op[] = [];
    if (rows > t.rows.count) ops.push({ t: "insert", tab: t.id, axis: "row", before: null, ids: Array.from({ length: rows - t.rows.count }, this.next) });
    if (cols > t.cols.count) ops.push({ t: "insert", tab: t.id, axis: "col", before: null, ids: Array.from({ length: cols - t.cols.count }, this.next) });
    if (!ops.length) return true;
    return this.live.edit(ops);
  }

  setInputs(cells: [number, number, string | null][]): void {
    if (this.readOnly || !cells.length) return;
    const t = this.tab!;
    const doc = this.doc!;
    const raw: [string, string, string | null][] = cells.map(([r, c, v]) => {
      const p = this.pos(r, c);
      return [p.row, p.col, v === null || v === "" ? null : compileInput(v, doc, t.id)];
    });
    this.live.edit([{ t: "set", tab: t.id, cells: raw }]);
  }

  private cells(rect: Rect): [string, string][] {
    const t = this.tab!;
    const out: [string, string][] = [];
    const rows = t.rows.live;
    const cols = t.cols.live;
    const max = this.live.limits.maxCellsPerOp;
    for (let r = rect.r0; r <= rect.r1 && out.length < max; r++) {
      for (let c = rect.c0; c <= rect.c1 && out.length < max; c++) out.push([rows[r], cols[c]]);
    }
    return out;
  }

  clear(): void {
    if (this.readOnly) return;
    const t = this.tab!;
    const { r0, r1, c0, c1 } = this.rect();
    const cells: [string, string, null][] = [];
    t.forEach((row, col, cell) => {
      if (cell.v === undefined) return;
      const r = t.rows.indexOf(row);
      const c = t.cols.indexOf(col);
      if (r >= r0 && r <= r1 && c >= c0 && c <= c1) cells.push([row, col, null]);
    });
    const max = this.live.limits.maxCellsPerOp;
    const ops: Op[] = [];
    for (let i = 0; i < cells.length; i += max) ops.push({ t: "set", tab: t.id, cells: cells.slice(i, i + max) });
    if (ops.length) this.live.edit(ops);
  }

  activeStyle(): Style {
    const t = this.tab;
    return (t && t.cell(this.anchor.row, this.anchor.col)?.s) ?? {};
  }

  style(patch: StylePatch): void {
    if (this.readOnly) return;
    const t = this.tab!;
    const rect = this.rect();
    const cells = this.cells(rect);
    const max = this.live.limits.maxCellsPerOp;
    if ((rect.r1 - rect.r0 + 1) * (rect.c1 - rect.c0 + 1) > max) this.live.say(`Formatting was applied to the first ${max} cells`);
    this.live.edit([{ t: "style", tab: t.id, cells: cells.map(([r, c]) => [r, c, patch]) }]);
  }

  toggle(key: "b" | "i" | "u" | "st"): void {
    this.style({ [key]: this.activeStyle()[key] ? null : true });
  }

  decimals(delta: number): void {
    const { kind, decimals } = parseFormat(this.activeStyle().nf);
    const base = kind === "general" || kind === "date" || kind === "time" || kind === "datetime" || kind === "text" ? "number" : kind;
    const start = kind === "general" ? 2 : decimals;
    this.style({ nf: `${base}:${Math.max(0, Math.min(10, start + delta))}` });
  }

  insertRows(below: boolean): void {
    if (this.readOnly) return;
    const t = this.tab!;
    const { r0, r1 } = this.rect();
    const at = below ? r1 + 1 : r0;
    const ids = Array.from({ length: r1 - r0 + 1 }, this.next);
    this.live.edit([{ t: "insert", tab: t.id, axis: "row", before: t.rows.idAt(at) ?? null, ids }]);
    this.sync();
  }

  insertCols(right: boolean): void {
    if (this.readOnly) return;
    const t = this.tab!;
    const { c0, c1 } = this.rect();
    const at = right ? c1 + 1 : c0;
    const ids = Array.from({ length: c1 - c0 + 1 }, this.next);
    this.live.edit([{ t: "insert", tab: t.id, axis: "col", before: t.cols.idAt(at) ?? null, ids }]);
    this.sync();
  }

  deleteRows(): void {
    if (this.readOnly) return;
    const t = this.tab!;
    const { r0, r1 } = this.rect();
    if (r1 - r0 + 1 >= t.rows.count) return this.live.say("A sheet needs at least one row");
    this.live.edit([{ t: "remove", tab: t.id, axis: "row", ids: t.rows.live.slice(r0, r1 + 1) }]);
    this.select(r0, this.active().c);
  }

  deleteCols(): void {
    if (this.readOnly) return;
    const t = this.tab!;
    const { c0, c1 } = this.rect();
    if (c1 - c0 + 1 >= t.cols.count) return this.live.say("A sheet needs at least one column");
    this.live.edit([{ t: "remove", tab: t.id, axis: "col", ids: t.cols.live.slice(c0, c1 + 1) }]);
    this.select(this.active().r, c0);
  }

  addRows(): void {
    if (this.readOnly) return;
    const t = this.tab!;
    const { defaultRows, maxRows } = this.live.limits;
    const count = Math.min(defaultRows, maxRows - t.rows.count);
    if (count <= 0) return this.live.say(`A sheet can have up to ${maxRows} rows`);
    this.live.edit([{ t: "insert", tab: t.id, axis: "row", before: null, ids: Array.from({ length: count }, this.next) }]);
  }

  resize(axis: "row" | "col", index: number, px: number | null): void {
    if (this.readOnly) return;
    const t = this.tab!;
    const rect = this.rect();
    const whole = axis === "col" ? rect.r0 === 0 && rect.r1 === t.rows.count - 1 : rect.c0 === 0 && rect.c1 === t.cols.count - 1;
    const [lo, hi] = axis === "col" ? [rect.c0, rect.c1] : [rect.r0, rect.r1];
    const ids = whole && index >= lo && index <= hi ? (axis === "col" ? t.cols : t.rows).live.slice(lo, hi + 1) : [(axis === "col" ? t.cols : t.rows).idAt(index)!];
    const size = px === null ? null : Math.max(MIN_SIZE, Math.min(MAX_SIZE, Math.round(px)));
    this.live.edit([{ t: "resize", tab: t.id, axis, sizes: ids.map((id): [string, number | null] => [id, size]) }]);
  }

  switchTab(id: string): void {
    if (id === this.tabId) return;
    this.remembered.set(this.tabId, [this.anchor, this.focus]);
    this.editing = null;
    this.tabId = id;
    const saved = this.remembered.get(id);
    const t = this.tab!;
    if (saved && t.rows.has(saved[0].row) && t.cols.has(saved[0].col)) [this.anchor, this.focus] = saved;
    else {
      this.anchor = { row: t.rows.idAt(0)!, col: t.cols.idAt(0)! };
      this.focus = { ...this.anchor };
    }
    this.selected();
  }

  addTab(): void {
    if (this.readOnly) return;
    const doc = this.doc!;
    const at = doc.order.indexOf(this.tabId);
    const id = this.next();
    const rows = Array.from({ length: this.live.limits.defaultRows }, this.next);
    const cols = Array.from({ length: this.live.limits.defaultCols }, this.next);
    if (this.live.edit([{ t: "addTab", id, name: doc.nextTabName(), before: doc.order[at + 1] ?? null, rows, cols }])) this.switchTab(id);
  }

  duplicateTab(id: string): void {
    if (this.readOnly) return;
    const doc = this.doc!;
    const src = doc.tab(id)!;
    const newId = this.next();
    const rows = src.rows.live.map(() => this.next());
    const cols = src.cols.live.map(() => this.next());
    const rowOf = new Map(src.rows.live.map((r, i) => [r, rows[i]]));
    const colOf = new Map(src.cols.live.map((c, i) => [c, cols[i]]));
    const cells: [string, string, string][] = [];
    const styles: [string, string, StylePatch][] = [];
    src.forEach((row, col, cell) => {
      const r = rowOf.get(row);
      const c = colOf.get(col);
      if (!r || !c) return;
      if (cell.v !== undefined) cells.push([r, c, cell.v]);
      if (cell.s) styles.push([r, c, cell.s]);
    });
    const at = doc.order.indexOf(id);
    const ops: Op[] = [{ t: "addTab", id: newId, name: `${src.name} copy`, before: doc.order[at + 1] ?? null, rows, cols, cells }];
    if (styles.length) ops.push({ t: "style", tab: newId, cells: styles });
    const sizes = (axis: Axis, ids: string[]) => axis.live.flatMap((x, i): [string, number][] => (axis.sizes.has(x) ? [[ids[i], axis.sizes.get(x)!]] : []));
    const rs = sizes(src.rows, rows);
    const cs = sizes(src.cols, cols);
    if (rs.length) ops.push({ t: "resize", tab: newId, axis: "row", sizes: rs });
    if (cs.length) ops.push({ t: "resize", tab: newId, axis: "col", sizes: cs });
    if (this.live.edit(ops)) this.switchTab(newId);
  }

  renameTab(id: string, name: string): boolean {
    if (this.readOnly) return false;
    const tab = this.doc!.tab(id);
    if (!tab || name.trim() === tab.name) return true;
    if (!validTabName(name)) {
      this.live.say("Sheet names can't be empty or use \\ / ? * [ ] :");
      return false;
    }
    return this.live.edit([{ t: "renameTab", id, name: name.trim() }]);
  }

  deleteTab(id: string): void {
    if (this.readOnly) return;
    const tabs = this.doc!.liveTabs();
    if (tabs.length <= 1) return this.live.say("A spreadsheet needs at least one sheet");
    const i = tabs.findIndex((t) => t.id === id);
    if (id === this.tabId) this.switchTab(tabs[i + 1]?.id ?? tabs[i - 1].id);
    this.live.edit([{ t: "removeTab", id }]);
  }

  moveTab(id: string, delta: -1 | 1): void {
    if (this.readOnly) return;
    const tabs = this.doc!.liveTabs();
    const i = tabs.findIndex((t) => t.id === id);
    const j = i + delta;
    if (i < 0 || j < 0 || j >= tabs.length) return;
    const before = delta < 0 ? tabs[j].id : (tabs[j + 1]?.id ?? null);
    this.live.edit([{ t: "moveTab", id, before }]);
  }

  setTitle(title: string): void {
    const t = title.trim();
    if (this.readOnly || !t || t === this.live.doc?.title) return;
    this.live.edit([{ t: "title", title: t.slice(0, 200) }]);
  }

  copy(cut: boolean): { text: string; html: string } {
    const t = this.tab!;
    const rect = this.rect();
    const inputs: (string | null)[][] = [];
    const styles: (Style | undefined)[][] = [];
    const lines: string[] = [];
    const html: string[] = [];
    for (let r = rect.r0; r <= rect.r1 && r - rect.r0 < 5000; r++) {
      const rowInputs: (string | null)[] = [];
      const rowStyles: (Style | undefined)[] = [];
      const shown: string[] = [];
      for (let c = rect.c0; c <= rect.c1; c++) {
        const p = this.pos(r, c);
        const cell = t.cell(p.row, p.col);
        rowInputs.push(cell?.v ?? null);
        rowStyles.push(cell?.s);
        shown.push(this.display(r, c));
      }
      inputs.push(rowInputs);
      styles.push(rowStyles);
      lines.push(shown.map(tsvField).join("\t"));
      html.push("<tr>" + shown.map((s, i) => `<td${rowStyles[i]?.b ? ' style="font-weight:bold"' : ""}>${escapeHtml(s)}</td>`).join("") + "</tr>");
    }
    const text = lines.join("\n");
    this.clip = { text, tab: t.id, rect: { ...rect, r1: rect.r0 + inputs.length - 1 }, inputs, styles, cut: cut && !this.readOnly };
    this.emit();
    return { text, html: `<table>${html.join("")}</table>` };
  }

  clearClip(): void {
    if (!this.clip) return;
    this.clip = null;
    this.emit();
  }

  paste(text: string, html: string | null): void {
    if (this.readOnly) return;
    const t = this.tab!;
    const doc = this.doc!;
    const { r, c } = this.active();
    const sel = this.rect();
    const internal = this.clip && text === this.clip.text ? this.clip : null;
    let grid: (string | null)[][];
    let styles: (Style | undefined)[][] | null = null;
    if (internal) {
      grid = internal.inputs;
      styles = internal.styles;
    } else {
      grid = [];
      if (html && /<table/i.test(html)) {
        const dom = new DOMParser().parseFromString(html, "text/html");
        for (const tr of dom.querySelectorAll("tr")) grid.push([...tr.querySelectorAll("td,th")].map((td) => td.textContent ?? ""));
      }
      if (!grid.length) grid = parseCsv(text.replace(/\r?\n$/, ""), "\t");
    }
    if (!grid.length) return;
    const h = grid.length;
    const w = Math.max(...grid.map((row) => row.length));
    const tile = h === 1 && w === 1 && (sel.r1 > sel.r0 || sel.c1 > sel.c0);
    const rows = tile ? sel.r1 - sel.r0 + 1 : h;
    const cols = tile ? sel.c1 - sel.c0 + 1 : w;
    const top = tile ? sel.r0 : r;
    const left = tile ? sel.c0 : c;
    if (rows * cols > this.live.limits.maxCellsPerOp) return this.live.say(`You can paste up to ${this.live.limits.maxCellsPerOp} cells at once`);
    if (!this.ensureSize(top + rows, left + cols)) return;
    const values: [string, string, string | null][] = [];
    const looks: [string, string, StylePatch][] = [];
    for (let i = 0; i < rows; i++) {
      for (let j = 0; j < cols; j++) {
        const si = tile ? 0 : i;
        const sj = tile ? 0 : j;
        const src = grid[si]?.[sj] ?? null;
        const p = this.pos(top + i, left + j);
        let input: string | null;
        if (internal) {
          const dr = top + i - (internal.rect.r0 + si);
          const dc = left + j - (internal.rect.c0 + sj);
          input = src === null ? null : internal.cut ? src : shiftInput(src, doc, internal.tab, t.id, dr, dc);
          looks.push([p.row, p.col, fullPatch(styles![si]?.[sj])]);
        } else {
          input = src === null || src === "" ? null : compileInput(src, doc, t.id);
        }
        values.push([p.row, p.col, input]);
      }
    }
    const ops: Op[] = [{ t: "set", tab: t.id, cells: values }];
    if (looks.length) ops.push({ t: "style", tab: t.id, cells: looks });
    if (internal?.cut) {
      const src = doc.tab(internal.tab);
      if (src && !src.dead) {
        const target = new Set(values.map(([a, b]) => a + "|" + b));
        const clearCells: [string, string, string | null][] = [];
        const clearStyles: [string, string, StylePatch][] = [];
        for (let i = 0; i < internal.inputs.length; i++) {
          for (let j = 0; j < internal.inputs[i].length; j++) {
            const row = src.rows.idAt(internal.rect.r0 + i);
            const col = src.cols.idAt(internal.rect.c0 + j);
            if (!row || !col || (internal.tab === t.id && target.has(row + "|" + col))) continue;
            clearCells.push([row, col, null]);
            clearStyles.push([row, col, fullPatch(undefined)]);
          }
        }
        if (clearCells.length) ops.push({ t: "set", tab: internal.tab, cells: clearCells }, { t: "style", tab: internal.tab, cells: clearStyles });
      }
      this.clip = null;
    }
    this.live.edit(ops);
    this.selectRect(top, left, top + rows - 1, left + cols - 1);
  }

  fill(target: Rect): void {
    if (this.readOnly) return;
    const t = this.tab!;
    const doc = this.doc!;
    const src = this.rect();
    const down = target.r1 > src.r1;
    const up = target.r0 < src.r0;
    const right = target.c1 > src.c1;
    const left = target.c0 < src.c0;
    if (!down && !up && !right && !left) return;
    const vertical = down || up;
    const total = (target.r1 - target.r0 + 1) * (target.c1 - target.c0 + 1) - (src.r1 - src.r0 + 1) * (src.c1 - src.c0 + 1);
    if (total > this.live.limits.maxCellsPerOp) return this.live.say(`You can fill up to ${this.live.limits.maxCellsPerOp} cells at once`);
    const values: [string, string, string | null][] = [];
    const looks: [string, string, StylePatch][] = [];
    const lines = vertical ? [src.c0, src.c1] : [src.r0, src.r1];
    for (let line = lines[0]; line <= lines[1]; line++) {
      const cellsIn: { r: number; c: number }[] = [];
      if (vertical) for (let r = src.r0; r <= src.r1; r++) cellsIn.push({ r, c: line });
      else for (let c = src.c0; c <= src.c1; c++) cellsIn.push({ r: line, c });
      if (up || left) cellsIn.reverse();
      const inputs = cellsIn.map(({ r, c }) => {
        const p = this.pos(r, c);
        return t.input(p.row, p.col);
      });
      const looksIn = cellsIn.map(({ r, c }) => {
        const p = this.pos(r, c);
        return t.cell(p.row, p.col)?.s;
      });
      const next = series(inputs);
      const span = vertical ? (down ? target.r1 - src.r1 : src.r0 - target.r0) : right ? target.c1 - src.c1 : src.c0 - target.c0;
      for (let k = 0; k < span; k++) {
        const step = (up || left ? -1 : 1) * (k + 1);
        const tr = vertical ? (down ? src.r1 : src.r0) + step : line;
        const tc = vertical ? line : (right ? src.c1 : src.c0) + step;
        const from = cellsIn[k % cellsIn.length];
        const raw = inputs[k % inputs.length];
        let input: string | null;
        if (next) input = next(k);
        else if (raw === null) input = null;
        else if (isFormula(raw)) input = shiftInput(raw, doc, t.id, t.id, tr - from.r, tc - from.c);
        else {
          const m = cellsIn.length === 1 ? /^(.*?)(\d+)$/.exec(raw) : null;
          input = m ? m[1] + String(Number(m[2]) + (up || left ? -(k + 1) : k + 1)).padStart(m[2].length, "0") : raw;
        }
        const p = this.pos(tr, tc);
        values.push([p.row, p.col, input]);
        looks.push([p.row, p.col, fullPatch(looksIn[k % looksIn.length])]);
      }
    }
    if (!values.length) return;
    this.live.edit([
      { t: "set", tab: t.id, cells: values },
      { t: "style", tab: t.id, cells: looks },
    ]);
    const all = { r0: Math.min(src.r0, target.r0), r1: Math.max(src.r1, target.r1), c0: Math.min(src.c0, target.c0), c1: Math.max(src.c1, target.c1) };
    this.selectRect(all.r0, all.c0, all.r1, all.c1);
  }

  undo(): void {
    this.editing = null;
    if (!this.live.undo()) this.live.say("Nothing to undo");
  }

  redo(): void {
    this.editing = null;
    if (!this.live.redo()) this.live.say("Nothing to redo");
  }

  setPreview(preview: SheetView["preview"]): void {
    this.preview = preview;
    this.editing = null;
    this.sync();
  }
}
