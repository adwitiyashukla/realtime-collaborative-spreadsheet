import { useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import { FUNCTIONS, FUNCTION_NAMES } from "../shared/calc/functions.ts";
import { isFormula } from "../shared/calc/literal.ts";
import { COL_W, FONT, HEADER_H, ROW_H, fillColor, formulaRefs, paint, readTheme, resetTheme, textColor } from "./draw.ts";
import type { LiveSheet } from "./live.ts";
import type { Rect, SheetView } from "./sheet.ts";

export type MenuKind = "cell" | "row" | "col";

type Drag =
  | { mode: "cells"; r: number; c: number }
  | { mode: "rows"; r: number }
  | { mode: "cols"; c: number }
  | { mode: "fill"; target: Rect | null }
  | { mode: "point"; r: number; c: number; tab: string }
  | { mode: "size"; axis: "row" | "col"; index: number; start: number; size: number; px: number };

type Hit = { kind: "corner" | "col" | "row" | "cell" | "colEdge" | "rowEdge" | "fill" | "none"; r: number; c: number };

const FOOTER_H = 52;

const COMMON = ["SUM", "IF", "AVERAGE", "COUNT", "MAX", "MIN", "VLOOKUP", "XLOOKUP", "ROUND", "SUMIF", "COUNTIF", "IFERROR", "INDEX", "MATCH", "TODAY", "CONCAT", "LEN", "TEXT", "AND", "OR"];

function rank(name: string, word: string): number {
  if (name === word) return -1;
  const i = COMMON.indexOf(name);
  return i < 0 ? COMMON.length : i;
}

function suggestions(value: string, caret: number): { start: number; names: string[] } | null {
  if (!isFormula(value)) return null;
  const before = value.slice(0, caret);
  const m = /(^=|[(,+\-*/^&=<>\s])([A-Za-z][A-Za-z0-9.]*)$/.exec(before);
  if (!m) return null;
  const word = m[2].toUpperCase();
  if (/^[A-Z]{1,3}\d+$/.test(word) || word === "TRUE" || word === "FALSE") return null;
  const names = FUNCTION_NAMES.filter((n) => n.startsWith(word))
    .sort((a, b) => rank(a, word) - rank(b, word) || a.length - b.length || a.localeCompare(b))
    .slice(0, 8);
  return names.length ? { start: caret - m[2].length, names } : null;
}

function hintFor(value: string, caret: number): string | null {
  if (!isFormula(value)) return null;
  let depth = 0;
  let inString = false;
  for (let i = caret - 1; i >= 0; i--) {
    const ch = value[i];
    if (ch === '"') inString = !inString;
    if (inString) continue;
    if (ch === ")") depth++;
    else if (ch === "(") {
      if (depth === 0) {
        const m = /([A-Za-z][A-Za-z0-9.]*)$/.exec(value.slice(0, i));
        const fn = m ? FUNCTIONS[m[1].toUpperCase()] : undefined;
        return fn ? `${fn.sig}  ${fn.desc}` : null;
      }
      depth--;
    }
  }
  return null;
}

export function Grid({ view, live, onMenu, footer = true }: { view: SheetView; live: LiveSheet; onMenu: (x: number, y: number, kind: MenuKind) => void; footer?: boolean }) {
  useSyncExternalStore(view.subscribe, () => view.version);
  useSyncExternalStore(live.subscribe, () => live.version);
  const wrap = useRef<HTMLDivElement>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const anchor = useRef<HTMLDivElement>(null);
  const scroll = useRef({ x: 0, y: 0 });
  const size = useRef({ w: 0, h: 0, dpr: 1 });
  const drag = useRef<Drag | null>(null);
  const frame = useRef(0);
  const [focused, setFocused] = useState(false);
  const [pick, setPick] = useState(0);
  const [announce, setAnnounce] = useState("");
  const tab = view.tab;
  const layout = view.layout();
  const editing = view.editing;
  const editOrigin = editing?.origin;
  const editMode = editing?.mode;
  const isEditing = !!editing;
  const version = view.version;

  const draw = () => {
    const el = canvas.current;
    const t = view.tab;
    const calc = view.calc;
    if (!el || !t || !calc || !layout) return;
    const ctx = el.getContext("2d");
    if (!ctx) return;
    const { w, h, dpr } = size.current;
    const e = view.editing;
    const fill = drag.current?.mode === "fill" ? drag.current.target : null;
    paint({
      ctx,
      width: w,
      height: h,
      dpr,
      tab: t,
      calc,
      layout,
      x: scroll.current.x,
      y: scroll.current.y,
      sel: view.rect(),
      active: view.active(),
      editing: !!e,
      fillTarget: fill,
      clip: view.clip && view.clip.tab === t.id ? view.clip.rect : null,
      peers: view.preview ? [] : [...live.peers.values()],
      refs: e && view.doc ? formulaRefs(e.value, view.doc, t) : [],
      focused,
    });
  };

  const place = () => {
    const el = anchor.current;
    const box = wrap.current;
    if (!el || !box || !layout) return;
    const a = view.active();
    const x = layout.left(a.c) - scroll.current.x;
    const y = layout.top(a.r) - scroll.current.y;
    el.style.transform = `translate(${x}px, ${y}px)`;
    for (const pop of el.querySelectorAll<HTMLElement>(".suggest, .fn-hint")) {
      const below = layout.rowH(a.r) + 2;
      pop.style.left = `${Math.min(0, box.clientWidth - x - pop.offsetWidth - 8)}px`;
      pop.style.top = `${y + below + pop.offsetHeight > box.clientHeight && y > pop.offsetHeight ? -pop.offsetHeight - 2 : below}px`;
    }
  };

  const drawRef = useRef(draw);
  useLayoutEffect(() => {
    drawRef.current = draw;
    place();
  });
  const schedule = useCallback(() => {
    if (frame.current) return;
    frame.current = requestAnimationFrame(() => {
      frame.current = 0;
      drawRef.current();
    });
  }, []);
  const ready = !!(tab && layout);

  useEffect(() => schedule());

  useLayoutEffect(() => {
    const el = wrap.current;
    if (!el || !ready) return;
    const obs = new ResizeObserver(() => {
      const box = scroller.current!;
      const dpr = window.devicePixelRatio || 1;
      size.current = { w: box.clientWidth, h: box.clientHeight, dpr };
      const c = canvas.current!;
      c.width = Math.round(box.clientWidth * dpr);
      c.height = Math.round(box.clientHeight * dpr);
      c.style.width = `${box.clientWidth}px`;
      c.style.height = `${box.clientHeight}px`;
      view.setPageRows(Math.max(1, Math.floor((box.clientHeight - HEADER_H) / ROW_H) - 1));
      schedule();
    });
    obs.observe(el);
    const media = matchMedia("(prefers-color-scheme: dark)");
    const onTheme = () => {
      resetTheme();
      schedule();
    };
    media.addEventListener("change", onTheme);
    return () => {
      obs.disconnect();
      media.removeEventListener("change", onTheme);
    };
  }, [ready, view, schedule]);

  useEffect(() => {
    view.setReveal((r, c) => {
      const box = scroller.current;
      if (!box || !layout || r >= layout.rows || c >= layout.cols) return;
      const top = layout.rowPos[r];
      const bottom = layout.rowPos[r + 1];
      const left = layout.colPos[c];
      const right = layout.colPos[c + 1];
      const viewH = box.clientHeight - HEADER_H;
      const viewW = box.clientWidth - layout.headerW;
      if (top < box.scrollTop) box.scrollTop = top;
      else if (bottom > box.scrollTop + viewH) box.scrollTop = bottom - viewH;
      if (left < box.scrollLeft) box.scrollLeft = left;
      else if (right > box.scrollLeft + viewW) box.scrollLeft = Math.min(left, right - viewW);
    });
    return () => view.setReveal(null);
  }, [view, layout]);

  useEffect(() => {
    const e = view.editing;
    const el = input.current;
    if (e?.origin === "cell" && el && document.activeElement !== el) {
      el.focus({ preventScroll: true });
      el.setSelectionRange(e.caret, e.caret);
    }
  }, [view, editOrigin, editMode, isEditing]);

  useEffect(() => {
    if (!isEditing && document.activeElement === input.current) scroller.current?.focus({ preventScroll: true });
  }, [isEditing]);

  useEffect(() => {
    const e = view.editing;
    const el = input.current;
    if (e && el && el.value === e.value && el.selectionStart !== e.caret && e.ref) el.setSelectionRange(e.caret, e.caret);
  });

  useEffect(() => {
    const t = setTimeout(() => setAnnounce(view.tab ? view.describeActive() : ""), 250);
    return () => clearTimeout(t);
  }, [view, version]);

  if (!tab || !layout) return <div className="grid-wrap" />;

  const local = (e: { clientX: number; clientY: number }) => {
    const box = wrap.current!.getBoundingClientRect();
    return { x: e.clientX - box.left, y: e.clientY - box.top };
  };

  const hit = (e: { clientX: number; clientY: number }): Hit => {
    const { x, y } = local(e);
    const hw = layout.headerW;
    const box = scroller.current!;
    if (x > box.clientWidth || y > box.clientHeight) return { kind: "none", r: 0, c: 0 };
    const cx = x - hw + scroll.current.x;
    const cy = y - HEADER_H + scroll.current.y;
    if (x < hw && y < HEADER_H) return { kind: "corner", r: 0, c: 0 };
    if ((y >= HEADER_H && cy >= layout.rowPos[layout.rows]) || (x >= hw && cx >= layout.colPos[layout.cols])) return { kind: "none", r: 0, c: 0 };
    if (y < HEADER_H) {
      const c = layout.colAt(cx);
      if (layout.colPos[c + 1] - cx <= 4) return { kind: "colEdge", r: 0, c };
      if (cx - layout.colPos[c] <= 3 && c > 0) return { kind: "colEdge", r: 0, c: c - 1 };
      return { kind: "col", r: 0, c };
    }
    if (x < hw) {
      const r = layout.rowAt(cy);
      if (layout.rowPos[r + 1] - cy <= 3) return { kind: "rowEdge", r, c: 0 };
      if (cy - layout.rowPos[r] <= 2 && r > 0) return { kind: "rowEdge", r: r - 1, c: 0 };
      return { kind: "row", r, c: 0 };
    }
    const r = layout.rowAt(cy);
    const c = layout.colAt(cx);
    const sel = view.rect();
    const fx = layout.colPos[sel.c1 + 1];
    const fy = layout.rowPos[sel.r1 + 1];
    if (!view.readOnly && !view.editing && Math.abs(cx - fx) <= 5 && Math.abs(cy - fy) <= 5) return { kind: "fill", r, c };
    return { kind: "cell", r, c };
  };

  const cursorFor = (h: Hit) => {
    if (h.kind === "colEdge") return "col-resize";
    if (h.kind === "rowEdge") return "row-resize";
    if (h.kind === "fill") return "crosshair";
    if (h.kind === "cell") return view.canPoint() ? "copy" : "cell";
    return "default";
  };

  const fillTarget = (r: number, c: number): Rect | null => {
    const s = view.rect();
    if (r >= s.r0 && r <= s.r1 && c >= s.c0 && c <= s.c1) return null;
    const dy = r > s.r1 ? r - s.r1 : r < s.r0 ? s.r0 - r : 0;
    const dx = c > s.c1 ? c - s.c1 : c < s.c0 ? s.c0 - c : 0;
    if (dy >= dx) return r > s.r1 ? { ...s, r1: r } : { ...s, r0: r };
    return c > s.c1 ? { ...s, c1: c } : { ...s, c0: c };
  };

  const onPointerDown = (e: React.PointerEvent) => {
    if (e.button === 2 || (e.target as HTMLElement).closest(".grid-footer")) return;
    const h = hit(e);
    if (h.kind === "none") return;
    if (view.editing && view.canPoint() && h.kind === "cell") {
      e.preventDefault();
      drag.current = { mode: "point", r: h.r, c: h.c, tab: view.tabId };
      view.point({ r0: h.r, r1: h.r, c0: h.c, c1: h.c }, view.tabId);
      scroller.current!.setPointerCapture(e.pointerId);
      return;
    }
    if (view.editing) view.commit();
    scroller.current!.focus({ preventScroll: true });
    scroller.current!.setPointerCapture(e.pointerId);
    if (h.kind === "corner") view.selectAll();
    else if (h.kind === "col") {
      const s = view.rect();
      if (e.shiftKey) view.selectCols(Math.min(s.c0, h.c), Math.max(s.c1, h.c));
      else view.selectCols(h.c, h.c);
      drag.current = { mode: "cols", c: e.shiftKey ? view.index(view.anchor).c : h.c };
    } else if (h.kind === "row") {
      const s = view.rect();
      if (e.shiftKey) view.selectRows(Math.min(s.r0, h.r), Math.max(s.r1, h.r));
      else view.selectRows(h.r, h.r);
      drag.current = { mode: "rows", r: e.shiftKey ? view.index(view.anchor).r : h.r };
    } else if (h.kind === "colEdge" || h.kind === "rowEdge") {
      const axis = h.kind === "colEdge" ? "col" : "row";
      const index = axis === "col" ? h.c : h.r;
      const sizeNow = axis === "col" ? layout.colW(index) : layout.rowH(index);
      drag.current = { mode: "size", axis, index, start: axis === "col" ? e.clientX : e.clientY, size: sizeNow, px: sizeNow };
    } else if (h.kind === "fill") {
      drag.current = { mode: "fill", target: null };
    } else {
      view.select(h.r, h.c, e.shiftKey);
      drag.current = { mode: "cells", r: h.r, c: h.c };
    }
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d) {
      scroller.current!.style.cursor = cursorFor(hit(e));
      return;
    }
    const box = scroller.current!;
    const { x, y } = local(e);
    if (y > box.clientHeight - 16) box.scrollTop += 20;
    else if (y < HEADER_H + 4 && d.mode !== "cols" && d.mode !== "size") box.scrollTop -= 20;
    if (x > box.clientWidth - 16) box.scrollLeft += 20;
    else if (x < layout.headerW + 4 && d.mode !== "rows" && d.mode !== "size") box.scrollLeft -= 20;
    const cx = Math.max(0, x - layout.headerW + scroll.current.x);
    const cy = Math.max(0, y - HEADER_H + scroll.current.y);
    const r = layout.rowAt(cy);
    const c = layout.colAt(cx);
    if (d.mode === "cells") view.select(r, c, true);
    else if (d.mode === "rows") view.selectRows(Math.min(d.r, r), Math.max(d.r, r));
    else if (d.mode === "cols") view.selectCols(Math.min(d.c, c), Math.max(d.c, c));
    else if (d.mode === "fill") {
      d.target = fillTarget(r, c);
      schedule();
    } else if (d.mode === "point") {
      view.point({ r0: Math.min(d.r, r), r1: Math.max(d.r, r), c0: Math.min(d.c, c), c1: Math.max(d.c, c) }, d.tab);
    } else if (d.mode === "size") {
      d.px = Math.max(16, d.size + (d.axis === "col" ? e.clientX : e.clientY) - d.start);
      const guide = wrap.current!.querySelector<HTMLDivElement>(".size-guide")!;
      guide.style.display = "block";
      if (d.axis === "col") {
        guide.className = "size-guide col";
        guide.style.left = `${layout.left(d.index) - scroll.current.x + d.px}px`;
      } else {
        guide.className = "size-guide row";
        guide.style.top = `${layout.top(d.index) - scroll.current.y + d.px}px`;
      }
    }
  };

  const onPointerUp = (e: React.PointerEvent) => {
    const d = drag.current;
    drag.current = null;
    scroller.current!.releasePointerCapture?.(e.pointerId);
    if (!d) return;
    if (d.mode === "fill" && d.target) view.fill(d.target);
    if (d.mode === "size") {
      wrap.current!.querySelector<HTMLDivElement>(".size-guide")!.style.display = "none";
      if (Math.abs(d.px - d.size) >= 1) view.resize(d.axis, d.index, d.px);
    }
    if (d.mode === "point") input.current?.focus({ preventScroll: true });
    schedule();
  };

  const onDoubleClick = (e: React.MouseEvent) => {
    const h = hit(e);
    if (h.kind === "cell") view.startEdit(null, "edit");
    else if (h.kind === "colEdge") view.resize("col", h.c, null);
    else if (h.kind === "rowEdge") view.resize("row", h.r, null);
  };

  const onContextMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    const h = hit(e);
    if (h.kind === "none" || h.kind === "corner") return;
    const s = view.rect();
    if (h.kind === "col" || h.kind === "colEdge") {
      if (!(h.c >= s.c0 && h.c <= s.c1 && s.r0 === 0 && s.r1 === layout.rows - 1)) view.selectCols(h.c, h.c);
      onMenu(e.clientX, e.clientY, "col");
    } else if (h.kind === "row" || h.kind === "rowEdge") {
      if (!(h.r >= s.r0 && h.r <= s.r1 && s.c0 === 0 && s.c1 === layout.cols - 1)) view.selectRows(h.r, h.r);
      onMenu(e.clientX, e.clientY, "row");
    } else {
      if (!(h.r >= s.r0 && h.r <= s.r1 && h.c >= s.c0 && h.c <= s.c1)) view.select(h.r, h.c);
      onMenu(e.clientX, e.clientY, "cell");
    }
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.target !== scroller.current) return;
    const mod = e.ctrlKey || e.metaKey;
    const k = e.key;
    const shift = e.shiftKey;
    let handled = true;
    if (mod && k.toLowerCase() === "z") view[shift ? "redo" : "undo"]();
    else if (mod && k.toLowerCase() === "y") view.redo();
    else if (mod && k.toLowerCase() === "a") view.selectAll();
    else if (mod && k.toLowerCase() === "b") view.toggle("b");
    else if (mod && k.toLowerCase() === "i") view.toggle("i");
    else if (mod && k.toLowerCase() === "u") view.toggle("u");
    else if (mod && k === " ") {
      const s = view.rect();
      view.selectCols(s.c0, s.c1);
    } else if (shift && k === " ") {
      const s = view.rect();
      view.selectRows(s.r0, s.r1);
    } else if (k === "ArrowUp") view[mod ? "jump" : "move"](-1, 0, shift);
    else if (k === "ArrowDown") view[mod ? "jump" : "move"](1, 0, shift);
    else if (k === "ArrowLeft") view[mod ? "jump" : "move"](0, -1, shift);
    else if (k === "ArrowRight") view[mod ? "jump" : "move"](0, 1, shift);
    else if (k === "Tab") view.move(0, shift ? -1 : 1);
    else if (k === "PageDown") view.move(view.pageRows, 0, shift);
    else if (k === "PageUp") view.move(-view.pageRows, 0, shift);
    else if (k === "Home") view.select(mod ? 0 : view.active().r, 0, shift);
    else if (k === "End") {
      const t = view.tab!;
      let lastR = 0;
      let lastC = 0;
      t.forEach((row, col, cell) => {
        if (cell.v === undefined) return;
        lastR = Math.max(lastR, t.rows.indexOf(row));
        lastC = Math.max(lastC, t.cols.indexOf(col));
      });
      view.select(mod ? lastR : view.active().r, lastC, shift);
    } else if (k === "Enter" || k === "F2") {
      if (k === "Enter" && shift) view.move(-1, 0);
      else view.startEdit(null, "edit");
    } else if (k === "Delete" || k === "Backspace") view.clear();
    else if (k === "Escape") view.clearClip();
    else if (k.length === 1 && !mod && !e.altKey) {
      if (view.readOnly) {
        live.say("This sheet is view only");
      } else {
        view.startEdit("", "enter");
        input.current?.focus({ preventScroll: true });
        return;
      }
    } else handled = false;
    if (handled) e.preventDefault();
  };

  const e = editing;
  const sugg = e?.origin === "cell" ? suggestions(e.value, e.caret) : null;
  const hint = e ? hintFor(e.value, e.caret) : null;
  const pickIndex = sugg ? Math.min(pick, sugg.names.length - 1) : 0;

  const accept = (name: string) => {
    if (!e || !sugg) return;
    const value = e.value.slice(0, sugg.start) + name + "(" + e.value.slice(e.caret);
    const caret = sugg.start + name.length + 1;
    view.draft(value, caret);
    requestAnimationFrame(() => input.current?.setSelectionRange(caret, caret));
  };

  const onInputKey = (ev: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (!e) return;
    const k = ev.key;
    if (sugg && (k === "ArrowDown" || k === "ArrowUp")) {
      ev.preventDefault();
      setPick((pickIndex + (k === "ArrowDown" ? 1 : sugg.names.length - 1)) % sugg.names.length);
      return;
    }
    if (sugg && (k === "Tab" || (k === "Enter" && !ev.altKey))) {
      ev.preventDefault();
      accept(sugg.names[pickIndex]);
      return;
    }
    if (k === "Enter" && ev.altKey) {
      ev.preventDefault();
      const el = ev.currentTarget;
      const at = el.selectionStart;
      view.draft(e.value.slice(0, at) + "\n" + e.value.slice(el.selectionEnd), at + 1);
      return;
    }
    if (k === "Enter") {
      ev.preventDefault();
      view.commit(ev.shiftKey ? -1 : 1, 0);
    } else if (k === "Tab") {
      ev.preventDefault();
      view.commit(0, ev.shiftKey ? -1 : 1);
    } else if (k === "Escape") {
      ev.preventDefault();
      view.cancel();
    } else if (e.mode === "enter" && !isFormula(e.value) && k.startsWith("Arrow")) {
      ev.preventDefault();
      const dir = { ArrowUp: [-1, 0], ArrowDown: [1, 0], ArrowLeft: [0, -1], ArrowRight: [0, 1] }[k]!;
      view.commit(dir[0], dir[1]);
    }
  };

  const act = view.active();
  const s = tab.cell(view.anchor.row, view.anchor.col)?.s;
  const editorStyle: React.CSSProperties = {
    minWidth: layout.colW(act.c) || COL_W,
    minHeight: layout.rowH(act.r) || ROW_H,
    font: `${s?.i ? "italic " : ""}${s?.b ? "bold " : ""}13px ${FONT}`,
    color: textColor(s?.fg, s?.bg),
    background: s?.bg ? fillColor(s.bg) : readTheme().paper,
  };
  const showEditor = !!e && e.origin === "cell";
  const more = footer && !view.readOnly ? Math.min(live.limits.defaultRows, live.limits.maxRows - tab.rows.count) : 0;

  return (
    <div className="grid-wrap" ref={wrap}>
      <canvas ref={canvas} className="grid-canvas" aria-hidden="true" />
      <div
        ref={scroller}
        className="grid-scroller"
        tabIndex={0}
        role="application"
        aria-roledescription="spreadsheet"
        aria-label={`${tab.name} sheet`}
        onScroll={(ev) => {
          scroll.current = { x: ev.currentTarget.scrollLeft, y: ev.currentTarget.scrollTop };
          place();
          schedule();
        }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onDoubleClick={onDoubleClick}
        onContextMenu={onContextMenu}
        onKeyDown={onKeyDown}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        onCopy={(ev) => {
          ev.preventDefault();
          const { text, html } = view.copy(false);
          ev.clipboardData.setData("text/plain", text);
          ev.clipboardData.setData("text/html", html);
        }}
        onCut={(ev) => {
          ev.preventDefault();
          const { text, html } = view.copy(true);
          ev.clipboardData.setData("text/plain", text);
          ev.clipboardData.setData("text/html", html);
        }}
        onPaste={(ev) => {
          ev.preventDefault();
          view.paste(ev.clipboardData.getData("text/plain"), ev.clipboardData.getData("text/html") || null);
        }}
      >
        <div className="grid-content" style={{ width: layout.width, height: layout.height + (more > 0 ? FOOTER_H : 0) }}>
          {more > 0 && (
            <div className="grid-footer" style={{ top: layout.height }}>
              <button onClick={() => view.addRows()}>Add {more} more rows at the bottom</button>
            </div>
          )}
        </div>
      </div>
      <div className="cell-anchor" ref={anchor}>
        <textarea
          ref={input}
          className={showEditor ? "cell-editor" : "cell-editor idle"}
          style={showEditor ? editorStyle : undefined}
          value={showEditor ? e.value : ""}
          aria-label="Cell editor"
          spellCheck={false}
          tabIndex={-1}
          onChange={(ev) => {
            if (!view.editing) view.startEdit("", "enter");
            view.draft(ev.target.value, ev.target.selectionStart);
            setPick(0);
          }}
          onSelect={(ev) => {
            if (view.editing && ev.currentTarget.selectionStart !== view.editing.caret) view.draft(ev.currentTarget.value, ev.currentTarget.selectionStart);
          }}
          onKeyDown={onInputKey}
          onBlur={(ev) => {
            const next = ev.relatedTarget as HTMLElement | null;
            if (drag.current?.mode === "point") return;
            if (next?.closest(".formula-bar")) return;
            if (view.editing?.origin === "cell") view.commit();
          }}
        />
        {showEditor && sugg && (
          <ul className="suggest" role="listbox">
            {sugg.names.map((n, i) => (
              <li
                key={n}
                role="option"
                aria-selected={i === pickIndex}
                className={i === pickIndex ? "on" : ""}
                onPointerDown={(ev) => {
                  ev.preventDefault();
                  accept(n);
                }}
              >
                <b>{n}</b>
                <span>{FUNCTIONS[n].desc}</span>
              </li>
            ))}
          </ul>
        )}
        {showEditor && !sugg && hint && (
          <div className="fn-hint">
            {hint}
          </div>
        )}
      </div>
      <div className="size-guide" />
      <div className="sr-only" aria-live="polite">
        {announce}
      </div>
    </div>
  );
}
