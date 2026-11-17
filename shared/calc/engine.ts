import type { Change, Doc, Tab } from "../model.ts";
import { type Ctx, cellValue, evaluateCell } from "./evaluate.ts";
import { formatValue } from "./format.ts";
import { FUNCTIONS } from "./functions.ts";
import { isFormula } from "./literal.ts";
import { FormulaError, type Node, type Ref, parseCanonical, walk } from "./parse.ts";
import { CellError, type Scalar } from "./values.ts";

type Key = string;

export const cellKey = (tab: string, row: string, col: string): Key => tab + "|" + row + "|" + col;

type Range = { f: Formula; tab: string; ref: Ref; cols: string[] };

type Formula = {
  key: Key;
  tab: string;
  row: string;
  col: string;
  node: Node | null;
  error: CellError | null;
  singles: Key[];
  refIds: string[];
  ranges: Range[];
  tabs: string[];
  volatile: boolean;
  structural: boolean;
  hint: string | null;
  mark: number;
  seen: number;
  indeg: number;
  out: Formula[] | null;
};

function bucket<K, V>(map: Map<K, Set<V>>, key: K): Set<V> {
  let s = map.get(key);
  if (!s) {
    s = new Set();
    map.set(key, s);
  }
  return s;
}

function hashString(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const DATE_FUNCS = new Set(["TODAY", "DATE", "EDATE", "EOMONTH", "DATEVALUE"]);

function hintOf(node: Node): string | null {
  let n = node;
  while (n.k === "group") n = n.a;
  if (n.k === "call") {
    if (DATE_FUNCS.has(n.name)) return "date";
    if (n.name === "NOW") return "datetime";
    if (n.name === "TIME") return "time";
  }
  if (n.k === "bin" && (n.op === "+" || n.op === "-") && n.b.k === "num") return hintOf(n.a);
  return null;
}

export class Calc {
  doc: Doc;
  seed = 0;
  now: () => number = () => Date.now();
  private formulas = new Map<Key, Formula>();
  private singleDeps = new Map<Key, Set<Formula>>();
  private byCol = new Map<string, Map<string, Set<Range>>>();
  private wide = new Map<string, Set<Range>>();
  private volatiles = new Set<Formula>();
  private pending: [string, string, string][] = [];
  private dirty = new Set<Formula>();
  private rebuildNeeded = true;
  private stamp = 0;
  private seenStamp = 0;
  private rng: () => number = Math.random;
  private ctx: Ctx;

  constructor(doc: Doc) {
    this.doc = doc;
    this.ctx = {
      doc,
      home: "",
      row: "",
      col: "",
      now: 0,
      rand: () => this.rng(),
    };
  }

  setDoc(doc: Doc): void {
    this.doc = doc;
    this.ctx.doc = doc;
    this.rebuildNeeded = true;
  }

  get formulaCount(): number {
    return this.formulas.size;
  }

  value(tabId: string, row: string, col: string): Scalar {
    return cellValue(this.doc.tabs.get(tabId)?.cell(row, col));
  }

  display(tabId: string, row: string, col: string): string {
    const cell = this.doc.tabs.get(tabId)?.cell(row, col);
    if (!cell || cell.v === undefined) return "";
    const v = this.value(tabId, row, col);
    return formatValue(v, cell.s?.nf ?? this.hint(tabId, row, col));
  }

  hint(tabId: string, row: string, col: string): string | null {
    const cell = this.doc.tabs.get(tabId)?.cell(row, col);
    if (!cell || cell.v === undefined) return null;
    if (isFormula(cell.v)) return this.formulas.get(cellKey(tabId, row, col))?.hint ?? null;
    this.value(tabId, row, col);
    return cell.h ?? null;
  }

  apply(changes: Change[]): void {
    for (const ch of changes) {
      if (ch.k === "cells") {
        const tab = this.doc.tab(ch.tab);
        for (const [row, col] of ch.cells) {
          const old = this.formulas.get(cellKey(ch.tab, row, col));
          if (old) this.unregister(old);
          const cell = tab?.cell(row, col);
          const input = cell?.v;
          if (tab && isFormula(input)) {
            const f = this.compile(ch.tab, row, col, input);
            this.register(f);
            this.dirty.add(f);
          } else if (cell) {
            delete cell.p;
            delete cell.h;
          }
          this.pending.push([ch.tab, row, col]);
        }
      } else if (ch.k === "axis") {
        this.reindex(ch.tab);
        const dead = ch.dead.length ? new Set(ch.dead) : null;
        for (const f of this.formulas.values()) {
          if (!f.tabs.includes(ch.tab) && f.tab !== ch.tab) continue;
          if (f.structural || (dead && f.refIds.some((id) => dead.has(id)))) this.dirty.add(f);
        }
      } else if (ch.k === "tabs" && ch.values) {
        this.rebuildNeeded = true;
      }
    }
  }

  private compile(tab: string, row: string, col: string, input: string): Formula {
    const f: Formula = {
      key: cellKey(tab, row, col),
      tab,
      row,
      col,
      node: null,
      error: null,
      singles: [],
      refIds: [],
      ranges: [],
      tabs: [],
      volatile: false,
      structural: false,
      hint: null,
      mark: 0,
      seen: 0,
      indeg: 0,
      out: null,
    };
    try {
      f.node = parseCanonical(input.slice(1));
    } catch (e) {
      f.error = new CellError("#ERROR!", e instanceof FormulaError ? e.message : "Formula parse error");
      return f;
    }
    walk(f.node, (n) => {
      if (n.k === "ref") {
        const t = n.ref.tab ?? tab;
        if (!f.tabs.includes(t)) f.tabs.push(t);
        if (n.ref.b) {
          f.ranges.push({ f, tab: t, ref: n.ref, cols: [] });
          f.structural = true;
        } else if (n.ref.a.row !== null && n.ref.a.col !== null) {
          f.singles.push(cellKey(t, n.ref.a.row, n.ref.a.col));
          f.refIds.push(n.ref.a.row, n.ref.a.col);
        }
      } else if (n.k === "call") {
        const spec = FUNCTIONS[n.name];
        if (spec?.volatile) f.volatile = true;
        if (spec?.position) f.structural = true;
      }
    });
    f.hint = hintOf(f.node);
    return f;
  }

  private register(f: Formula): void {
    this.formulas.set(f.key, f);
    for (const k of f.singles) bucket(this.singleDeps, k).add(f);
    for (const r of f.ranges) this.addRange(r);
    if (f.volatile) this.volatiles.add(f);
  }

  private unregister(f: Formula): void {
    if (this.formulas.get(f.key) === f) this.formulas.delete(f.key);
    for (const k of f.singles) {
      const s = this.singleDeps.get(k);
      if (s) {
        s.delete(f);
        if (s.size === 0) this.singleDeps.delete(k);
      }
    }
    for (const r of f.ranges) this.removeRange(r);
    this.volatiles.delete(f);
    this.dirty.delete(f);
  }

  private addRange(r: Range): void {
    const { a, b } = r.ref;
    if (a.col === null || b === null || b.col === null) {
      bucket(this.wide, r.tab).add(r);
      return;
    }
    const tab = this.doc.tab(r.tab);
    if (!tab) return;
    const i0 = tab.cols.fullIndex(a.col);
    const i1 = tab.cols.fullIndex(b.col);
    if (i0 < 0 || i1 < 0) return;
    let cols = this.byCol.get(r.tab);
    if (!cols) {
      cols = new Map();
      this.byCol.set(r.tab, cols);
    }
    r.cols = tab.cols.order.slice(Math.min(i0, i1), Math.max(i0, i1) + 1);
    for (const c of r.cols) bucket(cols, c).add(r);
  }

  private removeRange(r: Range): void {
    this.wide.get(r.tab)?.delete(r);
    const cols = this.byCol.get(r.tab);
    if (cols) {
      for (const c of r.cols) {
        const s = cols.get(c);
        if (s) {
          s.delete(r);
          if (s.size === 0) cols.delete(c);
        }
      }
    }
    r.cols = [];
  }

  private reindex(tabId: string): void {
    for (const f of this.formulas.values()) {
      for (const r of f.ranges) {
        if (r.tab !== tabId) continue;
        this.removeRange(r);
        this.addRange(r);
      }
    }
  }

  private containsRow(r: Range, tab: Tab, fr: number): boolean {
    const { a, b } = r.ref;
    if (a.row === null) return true;
    const f0 = tab.rows.fullIndex(a.row);
    if (f0 < 0) return false;
    if (b === null || b.row === null) return fr >= f0;
    const f1 = tab.rows.fullIndex(b.row);
    if (f1 < 0) return false;
    return f0 <= f1 ? fr >= f0 && fr <= f1 : fr >= f1 && fr <= f0;
  }

  private dependents(tabId: string, row: string, col: string, visit: (f: Formula) => void): void {
    const stamp = ++this.seenStamp;
    const add = (f: Formula) => {
      if (f.seen !== stamp) {
        f.seen = stamp;
        visit(f);
      }
    };
    const singles = this.singleDeps.get(cellKey(tabId, row, col));
    if (singles) for (const f of singles) add(f);
    const ranges = this.byCol.get(tabId)?.get(col);
    const wide = this.wide.get(tabId);
    if (!ranges && !wide) return;
    const tab = this.doc.tabs.get(tabId);
    if (!tab) return;
    const fr = tab.rows.fullIndex(row);
    if (fr < 0) return;
    if (ranges) for (const r of ranges) if (this.containsRow(r, tab, fr)) add(r.f);
    if (wide) for (const r of wide) if (this.containsRow(r, tab, fr)) add(r.f);
  }

  private rebuild(): void {
    this.formulas.clear();
    this.singleDeps.clear();
    this.byCol.clear();
    this.wide.clear();
    this.volatiles.clear();
    this.pending = [];
    this.dirty.clear();
    for (const tab of this.doc.tabs.values()) {
      tab.forEach((row, col, cell) => {
        if (!isFormula(cell.v)) return;
        delete cell.p;
        const f = this.compile(tab.id, row, col, cell.v);
        this.register(f);
        this.dirty.add(f);
      });
    }
    this.rebuildNeeded = false;
  }

  private evalFormula(f: Formula): void {
    const cell = this.doc.tabs.get(f.tab)?.cell(f.row, f.col);
    if (!cell) return;
    if (f.error || !f.node) {
      cell.p = f.error ?? new CellError("#ERROR!");
      return;
    }
    this.ctx.home = f.tab;
    this.ctx.row = f.row;
    this.ctx.col = f.col;
    if (f.volatile) this.rng = mulberry32(hashString(f.key) ^ this.seed);
    try {
      cell.p = evaluateCell(f.node, this.ctx);
    } catch {
      cell.p = new CellError("#ERROR!", "Formula is too complex to evaluate");
    }
  }

  recalc(): number {
    if (this.rebuildNeeded) this.rebuild();
    for (const f of this.volatiles) this.dirty.add(f);
    if (this.pending.length === 0 && this.dirty.size === 0) return 0;
    this.ctx.now = this.now();
    const stamp = ++this.stamp;
    const nodes: Formula[] = [];
    const enter = (f: Formula) => {
      if (f.mark === stamp) return;
      f.mark = stamp;
      f.indeg = 0;
      f.out = null;
      nodes.push(f);
    };
    for (const f of this.dirty) if (this.formulas.get(f.key) === f) enter(f);
    for (const [t, r, c] of this.pending) {
      const f = this.formulas.get(cellKey(t, r, c));
      if (f && f.mark === stamp) continue;
      this.dependents(t, r, c, enter);
    }
    this.dirty.clear();
    this.pending = [];
    for (let i = 0; i < nodes.length; i++) {
      const src = nodes[i];
      this.dependents(src.tab, src.row, src.col, (d) => {
        enter(d);
        d.indeg++;
        (src.out ??= []).push(d);
      });
    }
    const ready: Formula[] = [];
    for (const f of nodes) if (f.indeg === 0) ready.push(f);
    let count = 0;
    const drain = (skip: Set<Formula> | null) => {
      while (ready.length) {
        const f = ready.pop()!;
        this.evalFormula(f);
        count++;
        if (!f.out) continue;
        for (const d of f.out) {
          if (skip?.has(d)) continue;
          if (--d.indeg === 0) ready.push(d);
        }
      }
    };
    drain(null);
    const left = nodes.filter((f) => f.indeg > 0);
    if (left.length) {
      const cyclic = this.cycles(left, new Set(left));
      for (const f of cyclic) {
        const cell = this.doc.tabs.get(f.tab)?.cell(f.row, f.col);
        if (cell) cell.p = new CellError("#CYCLE!", "Circular reference");
        count++;
      }
      for (const f of cyclic) {
        for (const d of f.out ?? []) {
          if (!cyclic.has(d) && --d.indeg === 0) ready.push(d);
        }
      }
      drain(cyclic);
    }
    for (const f of nodes) f.out = null;
    return count;
  }

  private cycles(nodes: Formula[], within: Set<Formula>): Set<Formula> {
    const index = new Map<Formula, number>();
    const low = new Map<Formula, number>();
    const onStack = new Set<Formula>();
    const stack: Formula[] = [];
    const out = new Set<Formula>();
    let counter = 0;
    const visit = (v: Formula) => {
      index.set(v, counter);
      low.set(v, counter);
      counter++;
      stack.push(v);
      onStack.add(v);
    };
    for (const root of nodes) {
      if (index.has(root)) continue;
      visit(root);
      const work: [Formula, number][] = [[root, 0]];
      while (work.length) {
        const top = work[work.length - 1];
        const v = top[0];
        const edges = v.out ?? [];
        if (top[1] < edges.length) {
          const w = edges[top[1]++];
          if (!within.has(w)) continue;
          if (!index.has(w)) {
            visit(w);
            work.push([w, 0]);
          } else if (onStack.has(w)) {
            low.set(v, Math.min(low.get(v)!, index.get(w)!));
          }
          continue;
        }
        work.pop();
        if (work.length) {
          const parent = work[work.length - 1][0];
          low.set(parent, Math.min(low.get(parent)!, low.get(v)!));
        }
        if (low.get(v) === index.get(v)) {
          const comp: Formula[] = [];
          let w: Formula;
          do {
            w = stack.pop()!;
            onStack.delete(w);
            comp.push(w);
          } while (w !== v);
          if (comp.length > 1 || edges.includes(v)) for (const c of comp) out.add(c);
        }
      }
    }
    return out;
  }
}
