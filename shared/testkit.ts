import { Calc } from "./calc/engine.ts";
import { colIndex, compileInput, displayInput } from "./calc/parse.ts";
import type { Scalar } from "./calc/values.ts";
import { idMaker } from "./ids.ts";
import { type Doc, type Op, type Tab, newDoc } from "./model.ts";

export type Input = string | number | boolean | null;

export const LIMITS = { maxRows: 1000, maxCols: 100, maxTabs: 8, maxCellChars: 1000, maxCellsPerOp: 1000 };

export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function randomOp(doc: Doc, rnd: () => number, next: () => string): Op {
  const pick = <T>(xs: T[]): T => xs[Math.floor(rnd() * xs.length)];
  const tabs = doc.liveTabs();
  const tab = pick(tabs);
  const axisName = rnd() < 0.5 ? ("row" as const) : ("col" as const);
  const axis = axisName === "row" ? tab.rows : tab.cols;
  const kind = Math.floor(rnd() * 100);
  const names = ["Sheet", "Data", "notes", "Q1", "My tab"];
  if (kind >= 50 && kind < 58) {
    const before = rnd() < 0.2 ? null : pick(axis.order);
    return { t: "insert", tab: tab.id, axis: axisName, before, ids: Array.from({ length: 1 + Math.floor(rnd() * 2) }, next) };
  }
  if (kind >= 58 && kind < 64 && axis.count > 2) return { t: "remove", tab: tab.id, axis: axisName, ids: [pick(axis.live)] };
  if (kind >= 64 && kind < 68 && axis.dead.size) return { t: "restore", tab: tab.id, axis: axisName, ids: [pick([...axis.dead])] };
  if (kind >= 68 && kind < 72) return { t: "resize", tab: tab.id, axis: axisName, sizes: [[pick(axis.order), rnd() < 0.3 ? null : 20 + Math.floor(rnd() * 200)]] };
  if (kind >= 72 && kind < 78 && doc.liveTabs().length < LIMITS.maxTabs && doc.tabs.size < LIMITS.maxTabs * 4) {
    const rows = Array.from({ length: 3 }, next);
    const cols = Array.from({ length: 3 }, next);
    const cells: [string, string, string][] = rnd() < 0.5 ? [[rows[0], cols[1], String(Math.floor(rnd() * 9))]] : [];
    return { t: "addTab", id: next(), name: pick(names), before: rnd() < 0.5 ? null : pick(doc.order), rows, cols, cells };
  }
  if (kind >= 78 && kind < 82) return { t: "renameTab", id: tab.id, name: pick(names) };
  if (kind >= 82 && kind < 86 && tabs.length > 1) return { t: "removeTab", id: tab.id };
  const dead = doc.order.filter((id) => doc.tab(id)!.dead);
  if (kind >= 86 && kind < 90 && dead.length && tabs.length < LIMITS.maxTabs) return { t: "restoreTab", id: pick(dead) };
  if (kind >= 90 && kind < 95) return { t: "moveTab", id: tab.id, before: rnd() < 0.3 ? null : pick(doc.order) };
  if (kind >= 95) return { t: "title", title: pick(["Budget", "Plan", "Untitled spreadsheet"]) };
  if (kind >= 40 && kind < 50) {
    return { t: "style", tab: tab.id, cells: [[pick(tab.rows.order), pick(tab.cols.order), { b: rnd() < 0.5 ? true : null, bg: rnd() < 0.5 ? "#ffcc00" : null }]] };
  }
  const cells: [string, string, string | null][] = Array.from({ length: 1 + Math.floor(rnd() * 3) }, () => [
    pick(tab.rows.order),
    pick(tab.cols.order),
    rnd() < 0.2 ? null : String(Math.floor(rnd() * 100)),
  ]);
  return { t: "set", tab: tab.id, cells };
}

export function a1(ref: string): { c: number; r: number } {
  const m = /^([A-Z]+)(\d+)$/.exec(ref);
  if (!m) throw new Error(`bad ref ${ref}`);
  return { c: colIndex(m[1]), r: Number(m[2]) - 1 };
}

export class Sheet {
  doc: Doc;
  calc: Calc;
  next = idMaker("t");

  constructor(rows = 30, cols = 10) {
    this.doc = newDoc(rows, cols, this.next);
    this.calc = new Calc(this.doc);
    this.calc.now = () => Date.UTC(2026, 10, 9, 15, 30);
    this.calc.recalc();
  }

  tab(name?: string): Tab {
    return name ? this.doc.findTab(name)! : this.doc.liveTabs()[0];
  }

  apply(op: Op): void {
    const { changes } = this.doc.apply(op);
    this.calc.apply(changes);
    this.calc.recalc();
  }

  ids(ref: string, tabName?: string): [string, string, string] {
    const tab = this.tab(tabName);
    const { c, r } = a1(ref);
    return [tab.id, tab.rows.idAt(r)!, tab.cols.idAt(c)!];
  }

  set(ref: string, input: Input, tabName?: string): this {
    const [tab, row, col] = this.ids(ref, tabName);
    const raw = input === null ? null : typeof input === "string" ? compileInput(input, this.doc, tab) : String(input).toUpperCase();
    this.apply({ t: "set", tab, cells: [[row, col, raw]] });
    return this;
  }

  fill(data: Input[][], start = "A1", tabName?: string): this {
    const tab = this.tab(tabName);
    const { c, r } = a1(start);
    const cells: [string, string, string | null][] = [];
    data.forEach((line, i) =>
      line.forEach((v, j) => {
        const raw = v === null ? null : typeof v === "string" ? compileInput(v, this.doc, tab.id) : String(v).toUpperCase();
        cells.push([tab.rows.idAt(r + i)!, tab.cols.idAt(c + j)!, raw]);
      }),
    );
    this.apply({ t: "set", tab: tab.id, cells });
    return this;
  }

  get(ref: string, tabName?: string): Scalar {
    const [tab, row, col] = this.ids(ref, tabName);
    return this.calc.value(tab, row, col);
  }

  show(ref: string, tabName?: string): string {
    const [tab, row, col] = this.ids(ref, tabName);
    return this.calc.display(tab, row, col);
  }

  formula(ref: string, tabName?: string): string {
    const [tab, row, col] = this.ids(ref, tabName);
    return displayInput(this.doc.tab(tab)!.input(row, col), this.doc, tab);
  }

  eval(formula: string): Scalar {
    this.set("J30", formula);
    return this.get("J30");
  }

  addTab(name: string, rows = 30, cols = 10): Tab {
    const id = this.next();
    this.apply({
      t: "addTab",
      id,
      name,
      before: null,
      rows: Array.from({ length: rows }, this.next),
      cols: Array.from({ length: cols }, this.next),
    });
    return this.doc.tab(id)!;
  }

  insertRows(at: number, count = 1, tabName?: string): string[] {
    const tab = this.tab(tabName);
    const ids = Array.from({ length: count }, this.next);
    this.apply({ t: "insert", tab: tab.id, axis: "row", before: tab.rows.idAt(at) ?? null, ids });
    return ids;
  }

  insertCols(at: number, count = 1, tabName?: string): string[] {
    const tab = this.tab(tabName);
    const ids = Array.from({ length: count }, this.next);
    this.apply({ t: "insert", tab: tab.id, axis: "col", before: tab.cols.idAt(at) ?? null, ids });
    return ids;
  }

  removeRows(at: number, count = 1, tabName?: string): string[] {
    const tab = this.tab(tabName);
    const ids = tab.rows.live.slice(at, at + count);
    this.apply({ t: "remove", tab: tab.id, axis: "row", ids });
    return ids;
  }

  removeCols(at: number, count = 1, tabName?: string): string[] {
    const tab = this.tab(tabName);
    const ids = tab.cols.live.slice(at, at + count);
    this.apply({ t: "remove", tab: tab.id, axis: "col", ids });
    return ids;
  }
}
