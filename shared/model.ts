import { ID_PATTERN } from "./ids.ts";
import type { Scalar } from "./calc/values.ts";

export type Align = "left" | "center" | "right";

export type Style = {
  b?: boolean;
  i?: boolean;
  u?: boolean;
  st?: boolean;
  fg?: string;
  bg?: string;
  al?: Align;
  nf?: string;
};

export type StylePatch = { [K in keyof Style]?: Style[K] | null };

export type Cell = { v?: string; s?: Style; p?: Scalar; h?: string | null };

export type AxisName = "row" | "col";

export type Op =
  | { t: "set"; tab: string; cells: [string, string, string | null][] }
  | { t: "style"; tab: string; cells: [string, string, StylePatch][] }
  | { t: "insert"; tab: string; axis: AxisName; before: string | null; ids: string[] }
  | { t: "remove"; tab: string; axis: AxisName; ids: string[] }
  | { t: "restore"; tab: string; axis: AxisName; ids: string[] }
  | { t: "resize"; tab: string; axis: AxisName; sizes: [string, number | null][] }
  | {
      t: "addTab";
      id: string;
      name: string;
      before: string | null;
      rows: string[];
      cols: string[];
      cells?: [string, string, string][];
    }
  | { t: "renameTab"; id: string; name: string }
  | { t: "removeTab"; id: string; name?: string }
  | { t: "restoreTab"; id: string; name?: string }
  | { t: "moveTab"; id: string; before: string | null }
  | { t: "title"; title: string }
  | { t: "uninsert"; tab: string; axis: AxisName; ids: string[] }
  | { t: "dropTab"; id: string };

export type Change =
  | { k: "cells"; tab: string; cells: [string, string][] }
  | { k: "style"; tab: string }
  | { k: "axis"; tab: string; axis: AxisName; dead: string[] }
  | { k: "size"; tab: string }
  | { k: "tabs"; values: boolean }
  | { k: "title" };

export type Applied = { inverse: Op | null; changes: Change[] };

export type Limits = {
  maxRows: number;
  maxCols: number;
  maxTabs: number;
  maxCellChars: number;
  maxCellsPerOp: number;
};

export const MIN_SIZE = 8;
export const MAX_SIZE = 2000;

export const NO_LIMITS: Limits = {
  maxRows: Infinity,
  maxCols: Infinity,
  maxTabs: Infinity,
  maxCellChars: Infinity,
  maxCellsPerOp: Infinity,
};

type View = {
  live: string[];
  pos: Int32Array;
  full: Int32Array;
  liveFull: Int32Array;
  liveSlots: Int32Array;
};

function lowerBound(a: Int32Array, x: number): number {
  let lo = 0;
  let hi = a.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (a[mid] < x) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

export class Axis {
  order: string[];
  dead: Set<string>;
  sizes: Map<string, number>;
  private slots = new Map<string, number>();
  private bySlot: (string | undefined)[] = [];
  private view: View | null = null;

  constructor(order: string[], dead: Iterable<string> = [], sizes: Iterable<[string, number]> = []) {
    this.order = order;
    this.dead = new Set(dead);
    this.sizes = new Map(sizes);
    for (const id of order) this.claim(id);
  }

  private claim(id: string): void {
    if (this.slots.has(id)) return;
    this.slots.set(id, this.bySlot.length);
    this.bySlot.push(id);
  }

  private get v(): View {
    if (this.view) return this.view;
    const n = this.bySlot.length;
    const full = new Int32Array(n).fill(-1);
    const pos = new Int32Array(n).fill(-1);
    const live: string[] = [];
    const liveFull: number[] = [];
    const liveSlots: number[] = [];
    for (let i = 0; i < this.order.length; i++) {
      const id = this.order[i];
      const slot = this.slots.get(id)!;
      full[slot] = i;
      if (!this.dead.has(id)) {
        pos[slot] = live.length;
        live.push(id);
        liveFull.push(i);
        liveSlots.push(slot);
      }
    }
    this.view = { live, pos, full, liveFull: Int32Array.from(liveFull), liveSlots: Int32Array.from(liveSlots) };
    return this.view;
  }

  get live(): string[] {
    return this.v.live;
  }

  get liveSlots(): Int32Array {
    return this.v.liveSlots;
  }

  get count(): number {
    return this.v.live.length;
  }

  has(id: string): boolean {
    return this.slots.has(id);
  }

  isLive(id: string): boolean {
    return this.indexOf(id) >= 0;
  }

  isLiveSlot(slot: number): boolean {
    const pos = this.v.pos;
    return slot >= 0 && slot < pos.length && pos[slot] >= 0;
  }

  slot(id: string): number {
    return this.slots.get(id) ?? -1;
  }

  idOfSlot(slot: number): string | undefined {
    return this.bySlot[slot];
  }

  indexOf(id: string): number {
    const slot = this.slots.get(id);
    return slot === undefined ? -1 : this.v.pos[slot];
  }

  idAt(index: number): string | undefined {
    return this.v.live[index];
  }

  fullIndex(id: string): number {
    const slot = this.slots.get(id);
    return slot === undefined ? -1 : this.v.full[slot];
  }

  nearest(id: string): number {
    const i = this.indexOf(id);
    if (i >= 0) return i;
    const f = this.fullIndex(id);
    const span = f >= 0 ? this.spanFull(f, this.order.length) : null;
    return span ? span[0] : Math.max(0, this.count - 1);
  }

  spanFull(lo: number, hi: number): [number, number] | null {
    const lf = this.v.liveFull;
    const start = lowerBound(lf, lo);
    const end = lowerBound(lf, hi + 1);
    return start < end ? [start, end] : null;
  }

  span(a: string, b: string | null): [number, number] | null {
    const fa = this.fullIndex(a);
    if (fa < 0) return null;
    if (b === null) return this.spanFull(fa, this.order.length);
    const fb = this.fullIndex(b);
    if (fb < 0) return null;
    return this.spanFull(Math.min(fa, fb), Math.max(fa, fb));
  }

  insert(ids: string[], before: string | null): void {
    let at = before === null ? this.order.length : this.fullIndex(before);
    if (at < 0) at = this.order.length;
    this.order = this.order.slice(0, at).concat(ids, this.order.slice(at));
    for (const id of ids) this.claim(id);
    this.view = null;
  }

  drop(ids: string[]): string | null {
    const gone = new Set(ids);
    let last = -1;
    for (const id of ids) last = Math.max(last, this.fullIndex(id));
    let after: string | null = null;
    for (let i = last + 1; i < this.order.length; i++) {
      if (!gone.has(this.order[i])) {
        after = this.order[i];
        break;
      }
    }
    this.order = this.order.filter((id) => !gone.has(id));
    for (const id of ids) {
      this.dead.delete(id);
      this.sizes.delete(id);
      const slot = this.slots.get(id);
      if (slot !== undefined) this.bySlot[slot] = undefined;
      this.slots.delete(id);
    }
    this.view = null;
    return after;
  }

  kill(ids: string[]): void {
    for (const id of ids) this.dead.add(id);
    this.view = null;
  }

  revive(ids: string[]): void {
    for (const id of ids) this.dead.delete(id);
    this.view = null;
  }
}

export type Column = (Cell | undefined)[];

export class Tab {
  id: string;
  name: string;
  dead: boolean;
  rows: Axis;
  cols: Axis;
  private data: (Column | undefined)[] = [];
  private filled = 0;

  constructor(id: string, name: string, rows: Axis, cols: Axis, dead = false) {
    this.id = id;
    this.name = name;
    this.rows = rows;
    this.cols = cols;
    this.dead = dead;
  }

  get size(): number {
    return this.filled;
  }

  column(colSlot: number): Column | undefined {
    return this.data[colSlot];
  }

  cell(row: string, col: string): Cell | undefined {
    const c = this.cols.slot(col);
    if (c < 0) return undefined;
    const column = this.data[c];
    if (!column) return undefined;
    const r = this.rows.slot(row);
    return r < 0 ? undefined : column[r];
  }

  input(row: string, col: string): string | null {
    return this.cell(row, col)?.v ?? null;
  }

  forEach(cb: (row: string, col: string, cell: Cell) => void): void {
    for (let c = 0; c < this.data.length; c++) {
      const column = this.data[c];
      if (!column) continue;
      const col = this.cols.idOfSlot(c)!;
      for (let r = 0; r < column.length; r++) {
        const cell = column[r];
        if (cell) cb(this.rows.idOfSlot(r)!, col, cell);
      }
    }
  }

  setInput(row: string, col: string, v: string | null): string | null {
    const cell = this.cell(row, col);
    const prev = cell?.v ?? null;
    if (v === null || v === "") {
      if (cell) {
        delete cell.v;
        delete cell.p;
        delete cell.h;
        this.prune(row, col, cell);
      }
    } else {
      const c = cell ?? this.make(row, col);
      c.v = v;
      delete c.p;
      delete c.h;
    }
    return prev;
  }

  patchStyle(row: string, col: string, patch: StylePatch): StylePatch {
    const cell = this.cell(row, col);
    const style: Record<string, unknown> = { ...(cell?.s ?? {}) };
    const prev: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(patch)) {
      prev[key] = style[key] ?? null;
      if (value === null || value === undefined || value === false) delete style[key];
      else style[key] = value;
    }
    if (Object.keys(style).length === 0) {
      if (cell) {
        delete cell.s;
        this.prune(row, col, cell);
      }
    } else {
      (cell ?? this.make(row, col)).s = style as Style;
    }
    return prev as StylePatch;
  }

  clearLines(axis: AxisName, ids: string[]): [string, string][] {
    const cleared: [string, string][] = [];
    if (axis === "col") {
      for (const id of ids) {
        const c = this.cols.slot(id);
        const column = c < 0 ? undefined : this.data[c];
        if (!column) continue;
        for (let r = 0; r < column.length; r++) {
          if (!column[r]) continue;
          cleared.push([this.rows.idOfSlot(r)!, id]);
          this.filled--;
        }
        this.data[c] = undefined;
      }
      return cleared;
    }
    const slots = ids.map((id) => this.rows.slot(id)).filter((r) => r >= 0);
    for (let c = 0; c < this.data.length; c++) {
      const column = this.data[c];
      if (!column) continue;
      for (const r of slots) {
        if (!column[r]) continue;
        cleared.push([this.rows.idOfSlot(r)!, this.cols.idOfSlot(c)!]);
        column[r] = undefined;
        this.filled--;
      }
    }
    return cleared;
  }

  private make(row: string, col: string): Cell {
    const c = this.cols.slot(col);
    const r = this.rows.slot(row);
    if (c < 0 || r < 0) throw new Error("unknown cell");
    let column = this.data[c];
    if (!column) {
      while (this.data.length <= c) this.data.push(undefined);
      column = [];
      this.data[c] = column;
    }
    while (column.length <= r) column.push(undefined);
    const cell: Cell = {};
    column[r] = cell;
    this.filled++;
    return cell;
  }

  private prune(row: string, col: string, cell: Cell): void {
    if (cell.v !== undefined || cell.s !== undefined) return;
    const column = this.data[this.cols.slot(col)];
    const r = this.rows.slot(row);
    if (column && r >= 0 && column[r] === cell) {
      column[r] = undefined;
      this.filled--;
    }
  }
}

export type CellJSON = [string, string, string | null] | [string, string, string | null, Style];

export type TabJSON = {
  id: string;
  name: string;
  dead?: boolean;
  rows: string[];
  cols: string[];
  deadRows?: string[];
  deadCols?: string[];
  rowSizes?: [string, number][];
  colSizes?: [string, number][];
  cells: CellJSON[];
};

export type DocJSON = { title: string; tabs: TabJSON[] };

const BAD_TAB_CHARS = /[\\/?*[\]:]/;

export function validTabName(name: string): boolean {
  const n = name.trim();
  return n.length > 0 && n.length <= 100 && !BAD_TAB_CHARS.test(n) && !n.startsWith("'") && !n.endsWith("'");
}

export class Doc {
  title: string;
  tabs = new Map<string, Tab>();
  order: string[] = [];

  constructor(title = "Untitled spreadsheet") {
    this.title = title;
  }

  liveTabs(): Tab[] {
    const out: Tab[] = [];
    for (const id of this.order) {
      const tab = this.tabs.get(id);
      if (tab && !tab.dead) out.push(tab);
    }
    return out;
  }

  tab(id: string): Tab | undefined {
    return this.tabs.get(id);
  }

  findTab(name: string): Tab | undefined {
    const n = name.toLowerCase();
    return this.liveTabs().find((t) => t.name.toLowerCase() === n);
  }

  uniqueName(name: string, except?: string): string {
    const taken = (n: string) =>
      this.liveTabs().some((t) => t.id !== except && t.name.toLowerCase() === n.toLowerCase());
    if (!taken(name)) return name;
    for (let i = 2; ; i++) {
      const n = `${name} (${i})`;
      if (!taken(n)) return n;
    }
  }

  nextTabName(): string {
    for (let i = this.liveTabs().length + 1; ; i++) {
      const n = `Sheet${i}`;
      if (!this.findTab(n)) return n;
    }
  }

  private must(id: string): Tab {
    const tab = this.tabs.get(id);
    if (!tab) throw new Error(`unknown tab ${id}`);
    return tab;
  }

  private mustCells(tab: Tab, cells: [string, string, unknown][]): void {
    for (const [r, c] of cells) if (!tab.rows.has(r) || !tab.cols.has(c)) throw new Error("unknown cell");
  }

  private axis(tab: string, axis: AxisName): Axis {
    const t = this.must(tab);
    return axis === "row" ? t.rows : t.cols;
  }

  apply(op: Op): Applied {
    switch (op.t) {
      case "set": {
        const tab = this.must(op.tab);
        this.mustCells(tab, op.cells);
        const prev: [string, string, string | null][] = [];
        for (const [r, c, v] of op.cells) prev.push([r, c, tab.setInput(r, c, v)]);
        prev.reverse();
        return {
          inverse: { t: "set", tab: op.tab, cells: prev },
          changes: [{ k: "cells", tab: op.tab, cells: op.cells.map(([r, c]) => [r, c]) }],
        };
      }
      case "style": {
        const tab = this.must(op.tab);
        this.mustCells(tab, op.cells);
        const prev: [string, string, StylePatch][] = [];
        for (const [r, c, p] of op.cells) prev.push([r, c, tab.patchStyle(r, c, p)]);
        prev.reverse();
        const changes: Change[] = [{ k: "style", tab: op.tab }];
        const formats = op.cells.filter(([, , p]) => "nf" in p).map(([r, c]): [string, string] => [r, c]);
        if (formats.length) changes.push({ k: "cells", tab: op.tab, cells: formats });
        return { inverse: { t: "style", tab: op.tab, cells: prev }, changes };
      }
      case "insert": {
        this.axis(op.tab, op.axis).insert(op.ids, op.before);
        return {
          inverse: { t: "uninsert", tab: op.tab, axis: op.axis, ids: op.ids },
          changes: [{ k: "axis", tab: op.tab, axis: op.axis, dead: [] }],
        };
      }
      case "uninsert": {
        const tab = this.must(op.tab);
        const axis = op.axis === "row" ? tab.rows : tab.cols;
        const cleared = tab.clearLines(op.axis, op.ids);
        const after = axis.drop(op.ids);
        const changes: Change[] = [{ k: "axis", tab: op.tab, axis: op.axis, dead: op.ids }];
        if (cleared.length) changes.push({ k: "cells", tab: op.tab, cells: cleared });
        return { inverse: { t: "insert", tab: op.tab, axis: op.axis, before: after, ids: op.ids }, changes };
      }
      case "remove": {
        const axis = this.axis(op.tab, op.axis);
        const ids = [...new Set(op.ids)].filter((id) => axis.isLive(id));
        axis.kill(ids);
        return {
          inverse: { t: "restore", tab: op.tab, axis: op.axis, ids },
          changes: [{ k: "axis", tab: op.tab, axis: op.axis, dead: ids }],
        };
      }
      case "restore": {
        const axis = this.axis(op.tab, op.axis);
        const ids = [...new Set(op.ids)].filter((id) => axis.dead.has(id));
        axis.revive(ids);
        return {
          inverse: { t: "remove", tab: op.tab, axis: op.axis, ids },
          changes: [{ k: "axis", tab: op.tab, axis: op.axis, dead: ids }],
        };
      }
      case "resize": {
        const axis = this.axis(op.tab, op.axis);
        const prev: [string, number | null][] = [];
        for (const [id, px] of op.sizes) {
          prev.push([id, axis.sizes.get(id) ?? null]);
          if (px === null) axis.sizes.delete(id);
          else axis.sizes.set(id, px);
        }
        prev.reverse();
        return { inverse: { t: "resize", tab: op.tab, axis: op.axis, sizes: prev }, changes: [{ k: "size", tab: op.tab }] };
      }
      case "addTab": {
        const tab = new Tab(op.id, this.uniqueName(op.name.trim()), new Axis([...op.rows]), new Axis([...op.cols]));
        for (const [r, c, v] of op.cells ?? []) tab.setInput(r, c, v);
        this.tabs.set(op.id, tab);
        const at = op.before === null ? -1 : this.order.indexOf(op.before);
        this.order.splice(at < 0 ? this.order.length : at, 0, op.id);
        return { inverse: { t: "dropTab", id: op.id }, changes: [{ k: "tabs", values: true }] };
      }
      case "dropTab": {
        const at = this.order.indexOf(op.id);
        if (at >= 0) this.order.splice(at, 1);
        this.tabs.delete(op.id);
        return { inverse: null, changes: [{ k: "tabs", values: true }] };
      }
      case "renameTab": {
        const tab = this.must(op.id);
        const prev = tab.name;
        tab.name = this.uniqueName(op.name.trim(), tab.id);
        return { inverse: { t: "renameTab", id: op.id, name: prev }, changes: [{ k: "tabs", values: false }] };
      }
      case "removeTab": {
        const tab = this.must(op.id);
        if (tab.dead) return { inverse: null, changes: [] };
        const prev = tab.name;
        tab.dead = true;
        if (op.name !== undefined) tab.name = op.name;
        const inverse: Op = op.name !== undefined && op.name !== prev ? { t: "restoreTab", id: op.id, name: prev } : { t: "restoreTab", id: op.id };
        return { inverse, changes: [{ k: "tabs", values: true }] };
      }
      case "restoreTab": {
        const tab = this.must(op.id);
        if (!tab.dead) return { inverse: null, changes: [] };
        const prev = tab.name;
        tab.dead = false;
        tab.name = this.uniqueName((op.name ?? tab.name).trim(), tab.id);
        const inverse: Op = tab.name !== prev ? { t: "removeTab", id: op.id, name: prev } : { t: "removeTab", id: op.id };
        return { inverse, changes: [{ k: "tabs", values: true }] };
      }
      case "moveTab": {
        const at = this.order.indexOf(op.id);
        if (at < 0 || op.before === op.id) return { inverse: null, changes: [] };
        const prevBefore = this.order[at + 1] ?? null;
        this.order.splice(at, 1);
        const to = op.before === null ? -1 : this.order.indexOf(op.before);
        this.order.splice(to < 0 ? this.order.length : to, 0, op.id);
        return { inverse: { t: "moveTab", id: op.id, before: prevBefore }, changes: [{ k: "tabs", values: false }] };
      }
      case "title": {
        const prev = this.title;
        this.title = op.title;
        return { inverse: { t: "title", title: prev }, changes: [{ k: "title" }] };
      }
    }
  }

  toJSON(): DocJSON {
    const tabs: TabJSON[] = [];
    for (const id of this.order) {
      const tab = this.tabs.get(id);
      if (!tab) continue;
      const list: [number, number, CellJSON][] = [];
      tab.forEach((row, col, cell) => {
        list.push([tab.rows.fullIndex(row), tab.cols.fullIndex(col), cell.s ? [row, col, cell.v ?? null, cell.s] : [row, col, cell.v ?? null]]);
      });
      list.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
      const cells = list.map((x) => x[2]);
      const json: TabJSON = { id: tab.id, name: tab.name, rows: [...tab.rows.order], cols: [...tab.cols.order], cells };
      if (tab.dead) json.dead = true;
      const deadRows = tab.rows.order.filter((r) => tab.rows.dead.has(r));
      const deadCols = tab.cols.order.filter((c) => tab.cols.dead.has(c));
      if (deadRows.length) json.deadRows = deadRows;
      if (deadCols.length) json.deadCols = deadCols;
      const rowSizes = tab.rows.order.filter((r) => tab.rows.sizes.has(r)).map((r): [string, number] => [r, tab.rows.sizes.get(r)!]);
      const colSizes = tab.cols.order.filter((c) => tab.cols.sizes.has(c)).map((c): [string, number] => [c, tab.cols.sizes.get(c)!]);
      if (rowSizes.length) json.rowSizes = rowSizes;
      if (colSizes.length) json.colSizes = colSizes;
      tabs.push(json);
    }
    return { title: this.title, tabs };
  }

  static fromJSON(json: DocJSON): Doc {
    const doc = new Doc(json.title);
    for (const t of json.tabs) {
      const tab = new Tab(
        t.id,
        t.name,
        new Axis([...t.rows], t.deadRows ?? [], t.rowSizes ?? []),
        new Axis([...t.cols], t.deadCols ?? [], t.colSizes ?? []),
        t.dead ?? false,
      );
      for (const [r, c, v, s] of t.cells) {
        if (v !== null) tab.setInput(r, c, v);
        if (s) tab.patchStyle(r, c, s);
      }
      doc.tabs.set(t.id, tab);
      doc.order.push(t.id);
    }
    return doc;
  }
}

export function newDoc(rows: number, cols: number, nextId: () => string, title?: string): Doc {
  const doc = new Doc(title);
  const r = Array.from({ length: rows }, nextId);
  const c = Array.from({ length: cols }, nextId);
  doc.apply({ t: "addTab", id: nextId(), name: "Sheet1", before: null, rows: r, cols: c });
  return doc;
}

function idsOk(ids: string[], exists: (id: string) => boolean): boolean {
  const seen = new Set<string>();
  for (const id of ids) {
    if (!ID_PATTERN.test(id) || exists(id) || seen.has(id)) return false;
    seen.add(id);
  }
  return true;
}

export function checkOp(doc: Doc, op: Op, limits: Limits): string | null {
  switch (op.t) {
    case "set":
    case "style": {
      const tab = doc.tab(op.tab);
      if (!tab) return "unknown tab";
      if (op.cells.length === 0 || op.cells.length > limits.maxCellsPerOp) return "bad cell count";
      for (const [r, c, v] of op.cells) {
        if (!tab.rows.has(r) || !tab.cols.has(c)) return "unknown cell";
        if (op.t === "set" && typeof v === "string" && v.length > limits.maxCellChars) return "cell too long";
      }
      return null;
    }
    case "insert": {
      const tab = doc.tab(op.tab);
      if (!tab) return "unknown tab";
      const axis = op.axis === "row" ? tab.rows : tab.cols;
      if (op.before !== null && !axis.has(op.before)) return "unknown anchor";
      const max = op.axis === "row" ? limits.maxRows : limits.maxCols;
      if (op.ids.length === 0 || axis.count + op.ids.length > max) return "too many";
      return idsOk(op.ids, (id) => axis.has(id)) ? null : "bad ids";
    }
    case "remove":
    case "restore":
    case "resize": {
      const tab = doc.tab(op.tab);
      if (!tab) return "unknown tab";
      const axis = op.axis === "row" ? tab.rows : tab.cols;
      const ids = op.t === "resize" ? op.sizes.map(([id]) => id) : op.ids;
      if (ids.length === 0) return "empty";
      if (!ids.every((id) => axis.has(id))) return "unknown id";
      if (op.t === "remove") {
        const live = new Set(op.ids.filter((id) => axis.isLive(id)));
        if (axis.count - live.size < 1) return "cannot remove everything";
      }
      if (op.t === "restore") {
        const max = op.axis === "row" ? limits.maxRows : limits.maxCols;
        const dead = new Set(op.ids.filter((id) => axis.dead.has(id)));
        if (axis.count + dead.size > max) return "too many";
      }
      return null;
    }
    case "addTab": {
      if (!ID_PATTERN.test(op.id) || doc.tabs.has(op.id)) return "bad id";
      if (doc.liveTabs().length >= limits.maxTabs || doc.tabs.size >= limits.maxTabs * 4) return "too many tabs";
      if (!validTabName(op.name)) return "bad name";
      if (op.before !== null && !doc.tabs.has(op.before)) return "unknown anchor";
      if (op.rows.length === 0 || op.rows.length > limits.maxRows) return "bad rows";
      if (op.cols.length === 0 || op.cols.length > limits.maxCols) return "bad cols";
      if (!idsOk(op.rows, () => false) || !idsOk(op.cols, () => false)) return "bad ids";
      const cells = op.cells ?? [];
      if (cells.length > limits.maxCellsPerOp) return "bad cell count";
      const rows = new Set(op.rows);
      const cols = new Set(op.cols);
      for (const [r, c, v] of cells) {
        if (!rows.has(r) || !cols.has(c)) return "unknown cell";
        if (v.length > limits.maxCellChars) return "cell too long";
      }
      return null;
    }
    case "renameTab": {
      const tab = doc.tab(op.id);
      if (!tab || tab.dead) return "unknown tab";
      return validTabName(op.name) ? null : "bad name";
    }
    case "removeTab": {
      const tab = doc.tab(op.id);
      if (!tab || tab.dead) return "unknown tab";
      if (op.name !== undefined && !validTabName(op.name)) return "bad name";
      return doc.liveTabs().length > 1 ? null : "cannot remove the last tab";
    }
    case "restoreTab": {
      const tab = doc.tab(op.id);
      if (!tab || !tab.dead) return "unknown tab";
      if (op.name !== undefined && !validTabName(op.name)) return "bad name";
      return doc.liveTabs().length < limits.maxTabs ? null : "too many tabs";
    }
    case "moveTab": {
      if (!doc.tabs.has(op.id)) return "unknown tab";
      return op.before === null || doc.tabs.has(op.before) ? null : "unknown anchor";
    }
    case "title":
      return op.title.trim().length > 0 && op.title.length <= 200 ? null : "bad title";
    case "uninsert":
    case "dropTab":
      return "internal op";
  }
}
