import type { AxisName, Doc, Op, StylePatch } from "./model.ts";

type Item =
  | { t: "set"; tab: string; cells: [string, string, string | null, string | null][] }
  | { t: "style"; tab: string; cells: [string, string, StylePatch, StylePatch][] }
  | { t: "rows"; tab: string; axis: AxisName; ids: string[]; added: boolean }
  | { t: "resize"; tab: string; axis: AxisName; sizes: [string, number | null, number | null][] }
  | { t: "tab"; id: string; added: boolean }
  | { t: "rename"; id: string; before: string; after: string }
  | { t: "move"; id: string; before: string | null; after: string | null }
  | { t: "title"; before: string; after: string };

export function describe(doc: Doc, op: Op): Item | null {
  switch (op.t) {
    case "set": {
      const tab = doc.tab(op.tab);
      if (!tab) return null;
      const seen = new Map<string, [string, string, string | null, string | null]>();
      for (const [r, c, v] of op.cells) {
        const k = r + "|" + c;
        const prev = seen.get(k);
        if (prev) prev[3] = v;
        else seen.set(k, [r, c, tab.input(r, c), v === "" ? null : v]);
      }
      return { t: "set", tab: op.tab, cells: [...seen.values()] };
    }
    case "style": {
      const tab = doc.tab(op.tab);
      if (!tab) return null;
      return {
        t: "style",
        tab: op.tab,
        cells: op.cells.map(([r, c, patch]) => {
          const style = (tab.cell(r, c)?.s ?? {}) as Record<string, unknown>;
          const before: Record<string, unknown> = {};
          for (const k of Object.keys(patch)) before[k] = style[k] ?? null;
          return [r, c, before as StylePatch, patch];
        }),
      };
    }
    case "insert":
      return { t: "rows", tab: op.tab, axis: op.axis, ids: op.ids, added: true };
    case "remove":
    case "restore": {
      const tab = doc.tab(op.tab);
      if (!tab) return null;
      const axis = op.axis === "row" ? tab.rows : tab.cols;
      const ids = op.ids.filter((id) => (op.t === "remove" ? axis.isLive(id) : axis.dead.has(id)));
      return { t: "rows", tab: op.tab, axis: op.axis, ids, added: op.t === "restore" };
    }
    case "resize": {
      const tab = doc.tab(op.tab);
      if (!tab) return null;
      const axis = op.axis === "row" ? tab.rows : tab.cols;
      return { t: "resize", tab: op.tab, axis: op.axis, sizes: op.sizes.map(([id, px]) => [id, axis.sizes.get(id) ?? null, px]) };
    }
    case "addTab":
      return { t: "tab", id: op.id, added: true };
    case "removeTab":
    case "restoreTab":
      return { t: "tab", id: op.id, added: op.t === "restoreTab" };
    case "renameTab": {
      const tab = doc.tab(op.id);
      return tab ? { t: "rename", id: op.id, before: tab.name, after: op.name.trim() } : null;
    }
    case "moveTab": {
      const at = doc.order.indexOf(op.id);
      return { t: "move", id: op.id, before: doc.order[at + 1] ?? null, after: op.before };
    }
    case "title":
      return { t: "title", before: doc.title, after: op.title };
    default:
      return null;
  }
}

function invert(doc: Doc, item: Item, undo: boolean): Op | null {
  switch (item.t) {
    case "set": {
      const tab = doc.tab(item.tab);
      if (!tab) return null;
      const cells: [string, string, string | null][] = [];
      for (const [r, c, before, after] of item.cells) {
        const [from, to] = undo ? [after, before] : [before, after];
        if (tab.input(r, c) === from) cells.push([r, c, to]);
      }
      return cells.length ? { t: "set", tab: item.tab, cells } : null;
    }
    case "style": {
      const tab = doc.tab(item.tab);
      if (!tab) return null;
      const cells: [string, string, StylePatch][] = [];
      for (const [r, c, before, after] of item.cells) {
        const [from, to] = undo ? [after, before] : [before, after];
        const style = (tab.cell(r, c)?.s ?? {}) as Record<string, unknown>;
        const patch: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(from)) {
          const now = style[k] ?? null;
          const was = v === false ? null : (v ?? null);
          if (now === was) patch[k] = (to as Record<string, unknown>)[k] ?? null;
        }
        if (Object.keys(patch).length) cells.push([r, c, patch as StylePatch]);
      }
      return cells.length ? { t: "style", tab: item.tab, cells } : null;
    }
    case "rows": {
      const tab = doc.tab(item.tab);
      if (!tab) return null;
      const axis = item.axis === "row" ? tab.rows : tab.cols;
      const add = undo ? !item.added : item.added;
      const ids = item.ids.filter((id) => (add ? axis.dead.has(id) : axis.isLive(id)));
      if (!ids.length) return null;
      if (!add && axis.count - ids.length < 1) return null;
      return { t: add ? "restore" : "remove", tab: item.tab, axis: item.axis, ids };
    }
    case "resize": {
      const tab = doc.tab(item.tab);
      if (!tab) return null;
      const axis = item.axis === "row" ? tab.rows : tab.cols;
      const sizes: [string, number | null][] = [];
      for (const [id, before, after] of item.sizes) {
        const [from, to] = undo ? [after, before] : [before, after];
        if ((axis.sizes.get(id) ?? null) === from) sizes.push([id, to]);
      }
      return sizes.length ? { t: "resize", tab: item.tab, axis: item.axis, sizes } : null;
    }
    case "tab": {
      const tab = doc.tab(item.id);
      if (!tab) return null;
      const add = undo ? !item.added : item.added;
      if (add) return tab.dead ? { t: "restoreTab", id: item.id } : null;
      return !tab.dead && doc.liveTabs().length > 1 ? { t: "removeTab", id: item.id } : null;
    }
    case "rename": {
      const tab = doc.tab(item.id);
      const [from, to] = undo ? [item.after, item.before] : [item.before, item.after];
      return tab && !tab.dead && tab.name === from ? { t: "renameTab", id: item.id, name: to } : null;
    }
    case "move": {
      if (!doc.tabs.has(item.id)) return null;
      const before = undo ? item.before : item.after;
      if (before !== null && !doc.tabs.has(before)) return null;
      return { t: "moveTab", id: item.id, before };
    }
    case "title": {
      const [from, to] = undo ? [item.after, item.before] : [item.before, item.after];
      return doc.title === from ? { t: "title", title: to } : null;
    }
  }
}

export class History {
  private undos: Item[][] = [];
  private redos: Item[][] = [];
  limit = 200;

  get canUndo(): boolean {
    return this.undos.length > 0;
  }

  get canRedo(): boolean {
    return this.redos.length > 0;
  }

  push(items: Item[]): void {
    if (!items.length) return;
    this.undos.push(items);
    if (this.undos.length > this.limit) this.undos.shift();
    this.redos = [];
  }

  undo(doc: Doc, apply: (op: Op) => void): boolean {
    return this.step(doc, apply, this.undos, this.redos, true);
  }

  redo(doc: Doc, apply: (op: Op) => void): boolean {
    return this.step(doc, apply, this.redos, this.undos, false);
  }

  clear(): void {
    this.undos = [];
    this.redos = [];
  }

  private step(doc: Doc, apply: (op: Op) => void, from: Item[][], to: Item[][], undo: boolean): boolean {
    while (from.length) {
      const items = from.pop()!;
      to.push(items);
      let did = false;
      const order = undo ? [...items].reverse() : items;
      for (const item of order) {
        const op = invert(doc, item, undo);
        if (op) {
          apply(op);
          did = true;
        }
      }
      if (did) return true;
    }
    return false;
  }
}

export type { Item as HistoryItem };
