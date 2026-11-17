import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { Calc } from "../shared/calc/engine.ts";
import { FUNCTIONS } from "../shared/calc/functions.ts";
import { parseFormat } from "../shared/calc/format.ts";
import { csvInput, parseCsv } from "../shared/csv.ts";
import { idMaker } from "../shared/ids.ts";
import { Doc } from "../shared/model.ts";
import type { SheetMeta, User, VersionInfo } from "../shared/protocol.ts";
import { ApiError, api } from "./api.ts";
import { APP_NAME, Confirm, FILL_COLORS, HistoryPanel, Icon, Logo, Menu, type MenuItem, ShareDialog, Swatches, TEXT_COLORS, Toast } from "./dialogs.tsx";
import { Grid, type MenuKind } from "./grid.tsx";
import { LiveSheet } from "./live.ts";
import { Link, go } from "./router.tsx";
import { SheetView } from "./sheet.ts";

const FORMATS: [string, string][] = [
  ["general", "Automatic"],
  ["number:2", "Number"],
  ["percent:2", "Percent"],
  ["currency:2", "Currency"],
  ["date", "Date"],
  ["time", "Time"],
  ["datetime", "Date and time"],
  ["text", "Plain text"],
];

const QUICK = ["SUM", "AVERAGE", "COUNT", "MAX", "MIN"];

function useStore(sub: (fn: () => void) => () => void, get: () => number): void {
  useSyncExternalStore(sub, get);
}

function initials(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]!.toUpperCase())
    .join("");
}

function statusText(live: LiveSheet): string {
  if (live.status === "closed") return live.closedReason ?? "This sheet is closed";
  if (live.status === "connecting") return "Connecting";
  if (live.status === "offline") return live.pending ? `Offline, ${live.pending} unsaved ${live.pending === 1 ? "edit" : "edits"} will sync when you reconnect` : "Offline, reconnecting";
  if (live.pending) return "Saving";
  return "All changes saved";
}

function Toolbar({ view, live }: { view: SheetView; live: LiveSheet }) {
  const [open, setOpen] = useState<"fg" | "bg" | "fn" | null>(null);
  const [at, setAt] = useState({ x: 0, y: 0 });
  const style = view.activeStyle();
  const ro = view.readOnly;
  const nf = style.nf ?? "general";
  const kind = parseFormat(nf).kind;
  const current = FORMATS.find(([v]) => v === nf || (v !== "general" && v.split(":")[0] === kind))?.[0] ?? "general";
  const close = useCallback(() => setOpen(null), []);
  const toggle = (which: "fg" | "bg" | "fn", e: React.MouseEvent<HTMLButtonElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    setAt({ x: r.left, y: r.bottom + 4 });
    setOpen(open === which ? null : which);
  };
  const btn = (label: string, on: boolean, run: (e: React.MouseEvent<HTMLButtonElement>) => void, child: React.ReactNode, cls = "") => (
    <button className={`tool ${on ? "on" : ""} ${cls}`} aria-label={label} title={label} aria-pressed={on} disabled={ro} onClick={run}>
      <span aria-hidden="true">{child}</span>
    </button>
  );
  return (
    <div className="toolbar" role="toolbar" aria-label="Formatting">
      <button className="tool" aria-label="Undo" title="Undo (Ctrl+Z)" disabled={ro || !live.history.canUndo} onClick={() => view.undo()}>
        <Icon name="undo" />
      </button>
      <button className="tool" aria-label="Redo" title="Redo (Ctrl+Y)" disabled={ro || !live.history.canRedo} onClick={() => view.redo()}>
        <Icon name="redo" />
      </button>
      <span className="sep" />
      <select className="format" aria-label="Number format" title="Number format" value={current} disabled={ro} onChange={(e) => view.style({ nf: e.target.value === "general" ? null : e.target.value })}>
        {FORMATS.map(([v, label]) => (
          <option key={v} value={v}>
            {label}
          </option>
        ))}
      </select>
      {btn("Fewer decimal places", false, () => view.decimals(-1), <Icon name="fewer" />)}
      {btn("More decimal places", false, () => view.decimals(1), <Icon name="more_decimals" />)}
      <span className="sep" />
      {btn("Bold (Ctrl+B)", !!style.b, () => view.toggle("b"), <b className="glyph">B</b>)}
      {btn("Italic (Ctrl+I)", !!style.i, () => view.toggle("i"), <i className="glyph serif">I</i>)}
      {btn("Underline (Ctrl+U)", !!style.u, () => view.toggle("u"), <u className="glyph">U</u>)}
      {btn("Strikethrough", !!style.st, () => view.toggle("st"), <s className="glyph">S</s>)}
      <span className="pop">
        {btn(
          "Text color",
          false,
          (e) => toggle("fg", e),
          <span className="glyph color">
            A<i style={{ background: style.fg ?? "currentColor" }} />
          </span>,
        )}
        {open === "fg" && (
          <Swatches
            colors={TEXT_COLORS}
            label="Text color"
            current={style.fg}
            at={at}
            onClose={close}
            onPick={(c) => {
              view.style({ fg: c });
              close();
            }}
          />
        )}
      </span>
      <span className="pop">
        {btn(
          "Fill color",
          false,
          (e) => toggle("bg", e),
          <span className="glyph fill">
            <Icon name="fill" />
            <i style={{ background: style.bg ?? "transparent" }} />
          </span>,
        )}
        {open === "bg" && (
          <Swatches
            colors={FILL_COLORS}
            label="Fill color"
            current={style.bg}
            at={at}
            onClose={close}
            onPick={(c) => {
              view.style({ bg: c });
              close();
            }}
          />
        )}
      </span>
      <span className="sep" />
      {btn("Align left", style.al === "left", () => view.style({ al: style.al === "left" ? null : "left" }), <Icon name="left" />)}
      {btn("Align center", style.al === "center", () => view.style({ al: style.al === "center" ? null : "center" }), <Icon name="center" />)}
      {btn("Align right", style.al === "right", () => view.style({ al: style.al === "right" ? null : "right" }), <Icon name="right" />)}
      <span className="sep" />
      <span className="pop">
        {btn(
          "Insert a function",
          false,
          (e) => toggle("fn", e),
          <Icon name="sum" />,
        )}
        {open === "fn" && (
          <Menu
            x={at.x}
            y={at.y}
            onClose={close}
            items={QUICK.map((name) => ({
              label: name,
              hint: FUNCTIONS[name].desc,
              run: () => {
                const r = view.rect();
                const single = r.r0 === r.r1 && r.c0 === r.c1;
                if (single) view.startEdit(`=${name}(`, "edit");
                else {
                  const target = Math.min(r.r1 + 1, view.tab!.rows.count - 1);
                  view.select(target, r.c0);
                  view.startEdit(`=${name}(${view.rectNameOf(r)})`, "edit");
                }
              },
            }))}
          />
        )}
      </span>
    </div>
  );
}

function FormulaBar({ view }: { view: SheetView }) {
  const [name, setName] = useState<string | null>(null);
  const ref = useRef<HTMLInputElement>(null);
  const e = view.editing;
  const { r, c } = view.active();
  const value = e ? e.value : view.inputAt(r, c);
  const origin = e?.origin;
  useEffect(() => {
    const ed = view.editing;
    const el = ref.current;
    if (ed?.origin === "bar" && el && document.activeElement !== el) {
      el.focus();
      el.setSelectionRange(ed.caret, ed.caret);
    }
  }, [view, origin]);
  return (
    <div className="formula-bar">
      <input
        className="name-box"
        aria-label="Cell reference"
        value={name ?? view.rectName()}
        onFocus={(ev) => {
          setName(view.rectName());
          ev.currentTarget.select();
        }}
        onChange={(ev) => setName(ev.target.value)}
        onBlur={() => setName(null)}
        onKeyDown={(ev) => {
          if (ev.key === "Enter") {
            if (!view.goto(ev.currentTarget.value)) view.live.say("Type a cell like B4 or a range like A1:C10");
            setName(null);
            document.querySelector<HTMLElement>(".grid-scroller")?.focus();
          } else if (ev.key === "Escape") {
            setName(null);
            document.querySelector<HTMLElement>(".grid-scroller")?.focus();
          }
        }}
      />
      <span className="fx" aria-hidden="true">
        fx
      </span>
      <input
        ref={ref}
        className="formula-input"
        aria-label="Cell contents"
        value={value}
        readOnly={view.readOnly}
        spellCheck={false}
        onFocus={(ev) => view.editInBar(ev.currentTarget.selectionStart ?? 0)}
        onChange={(ev) => view.draft(ev.target.value, ev.target.selectionStart ?? ev.target.value.length)}
        onSelect={(ev) => {
          if (view.editing && ev.currentTarget.selectionStart !== view.editing.caret) view.draft(ev.currentTarget.value, ev.currentTarget.selectionStart ?? 0);
        }}
        onKeyDown={(ev) => {
          if (ev.key === "Enter") {
            ev.preventDefault();
            view.commit(1, 0);
            document.querySelector<HTMLElement>(".grid-scroller")?.focus();
          } else if (ev.key === "Escape") {
            view.cancel();
            document.querySelector<HTMLElement>(".grid-scroller")?.focus();
          } else if (ev.key === "Tab") {
            ev.preventDefault();
            view.commit(0, ev.shiftKey ? -1 : 1);
            document.querySelector<HTMLElement>(".grid-scroller")?.focus();
          }
        }}
        onBlur={(ev) => {
          const next = ev.relatedTarget as HTMLElement | null;
          if (next?.closest(".grid-wrap")) return;
          if (view.editing?.origin === "bar") view.commit();
        }}
      />
    </div>
  );
}

function TabBar({ view, live }: { view: SheetView; live: LiveSheet }) {
  const [renaming, setRenaming] = useState<string | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; id: string } | null>(null);
  const doc = view.doc;
  if (!doc) return null;
  const tabs = doc.liveTabs();
  const ro = view.readOnly;
  const close = () => setMenu(null);
  return (
    <div className="tabbar">
      <button className="tool" aria-label="Add a sheet" title="Add a sheet" disabled={ro} onClick={() => view.addTab()}>
        <Icon name="plus" />
      </button>
      <div className="tabs" role="tablist" aria-label="Sheets">
        {tabs.map((t, i) =>
          renaming === t.id ? (
            <input
              key={t.id}
              className="tab-rename"
              defaultValue={t.name}
              aria-label="Sheet name"
              autoFocus
              onFocus={(e) => e.currentTarget.select()}
              onBlur={(e) => {
                view.renameTab(t.id, e.currentTarget.value);
                setRenaming(null);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") e.currentTarget.blur();
                if (e.key === "Escape") setRenaming(null);
              }}
            />
          ) : (
            <button
              key={t.id}
              role="tab"
              aria-selected={t.id === view.tabId}
              className={t.id === view.tabId ? "tab on" : "tab"}
              onClick={() => view.switchTab(t.id)}
              onDoubleClick={() => !ro && setRenaming(t.id)}
              onContextMenu={(e) => {
                e.preventDefault();
                const r = e.currentTarget.getBoundingClientRect();
                setMenu({ x: r.left, y: r.top, id: t.id });
              }}
              onKeyDown={(e) => {
                if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
                  const next = tabs[(i + (e.key === "ArrowRight" ? 1 : tabs.length - 1)) % tabs.length];
                  view.switchTab(next.id);
                }
              }}
            >
              {t.name}
            </button>
          ),
        )}
      </div>
      <span className="status" aria-live="polite">
        {live.role === "viewer" && live.status !== "closed" ? <span className="badge">View only</span> : null}
        <span className={`dot ${live.status}`} />
        {statusText(live)}
      </span>
      {menu && (
        <Menu
          x={menu.x}
          y={menu.y}
          above
          onClose={close}
          items={[
            { label: "Rename", disabled: ro, run: () => setRenaming(menu.id) },
            { label: "Duplicate", disabled: ro, run: () => view.duplicateTab(menu.id) },
            { label: "Move left", disabled: ro || tabs[0]?.id === menu.id, run: () => view.moveTab(menu.id, -1) },
            { label: "Move right", disabled: ro || tabs[tabs.length - 1]?.id === menu.id, run: () => view.moveTab(menu.id, 1) },
            "-",
            { label: "Delete", danger: true, disabled: ro || tabs.length < 2, run: () => view.deleteTab(menu.id) },
          ]}
        />
      )}
    </div>
  );
}

function Account({ user, onUser }: { user: User; onUser: (u: User | null) => void }) {
  const [open, setOpen] = useState<{ x: number; y: number } | null>(null);
  return (
    <>
      <button
        className="avatar me"
        title={user.name}
        onClick={(e) => {
          const r = e.currentTarget.getBoundingClientRect();
          setOpen({ x: r.right - 200, y: r.bottom + 6 });
        }}
      >
        <span aria-hidden="true">{initials(user.name)}</span>
        <span className="sr-only">Account menu for {user.name}</span>
      </button>
      {open && (
        <Menu
          x={open.x}
          y={open.y}
          onClose={() => setOpen(null)}
          items={[
            { label: user.guest ? `${user.name} (guest)` : user.name, disabled: true, run: () => {} },
            ...(user.guest ? [{ label: "Create an account to keep your sheets", run: () => go("/signup") }] : []),
            { label: "All my sheets", run: () => go("/sheets") },
            "-",
            {
              label: "Log out",
              run: async () => {
                await api.logout().catch(() => {});
                onUser(null);
                go("/");
              },
            },
          ]}
        />
      )}
    </>
  );
}

function Workspace({ id, user, meta, onUser, onMeta }: { id: string; user: User; meta: SheetMeta; onUser: (u: User | null) => void; onMeta: (m: SheetMeta) => void }) {
  const [{ live, view }] = useState(() => {
    const live = new LiveSheet(id);
    return { live, view: new SheetView(live) };
  });
  useEffect(() => {
    live.start();
    return () => live.close();
  }, [live]);
  return <Loaded live={live} view={view} user={user} meta={meta} onUser={onUser} onMeta={onMeta} />;
}

function Loaded({ live, view, user, meta, onUser, onMeta }: { live: LiveSheet; view: SheetView; user: User; meta: SheetMeta; onUser: (u: User | null) => void; onMeta: (m: SheetMeta) => void }) {
  useStore(live.subscribe, () => live.version);
  useStore(view.subscribe, () => view.version);
  const [menu, setMenu] = useState<{ x: number; y: number; kind: MenuKind | "file" } | null>(null);
  const [share, setShare] = useState(false);
  const [history, setHistory] = useState(false);
  const [confirm, setConfirm] = useState<null | "delete">(null);
  const [title, setTitle] = useState<string | null>(null);
  const file = useRef<HTMLInputElement>(null);
  const doc = live.doc;
  const docTitle = doc?.title;
  const role = live.role;

  useEffect(() => {
    if (docTitle) document.title = `${docTitle} - ${APP_NAME}`;
  }, [docTitle]);

  useEffect(() => {
    if (role !== meta.role && meta.role !== "owner") api.sheet(meta.id).then(onMeta, () => {});
  }, [role, meta.id, meta.role, onMeta]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
        e.preventDefault();
        live.say(live.pending ? "Saving your changes" : "Every change is saved as you type");
      }
    };
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  }, [live]);

  if (!doc || !live.calc) {
    return (
      <main className="center-page">
        <p className="muted">{live.status === "closed" ? live.closedReason : live.status === "offline" ? "Could not connect to the server. Trying again" : "Opening the sheet"}</p>
      </main>
    );
  }

  const ro = view.readOnly;
  const cellMenu = (kind: MenuKind): MenuItem[] => {
    const r = view.rect();
    const nr = r.r1 - r.r0 + 1;
    const nc = r.c1 - r.c0 + 1;
    const rows = nr === 1 ? "row" : `${nr} rows`;
    const cols = nc === 1 ? "column" : `${nc} columns`;
    const clip: MenuItem[] = [
      { label: "Cut", hint: "Ctrl+X", disabled: ro, run: () => void navigator.clipboard?.writeText(view.copy(true).text) },
      { label: "Copy", hint: "Ctrl+C", run: () => void navigator.clipboard?.writeText(view.copy(false).text) },
      {
        label: "Paste",
        hint: "Ctrl+V",
        disabled: ro,
        run: async () => {
          try {
            view.paste(await navigator.clipboard.readText(), null);
          } catch {
            live.say("Your browser blocked reading the clipboard. Press Ctrl+V to paste.");
          }
        },
      },
      "-",
    ];
    const rowItems: MenuItem[] = [
      { label: `Insert ${nr === 1 ? "1 row" : rows} above`, disabled: ro, run: () => view.insertRows(false) },
      { label: `Insert ${nr === 1 ? "1 row" : rows} below`, disabled: ro, run: () => view.insertRows(true) },
      { label: `Delete ${rows}`, disabled: ro, danger: true, run: () => view.deleteRows() },
    ];
    const colItems: MenuItem[] = [
      { label: `Insert ${nc === 1 ? "1 column" : cols} left`, disabled: ro, run: () => view.insertCols(false) },
      { label: `Insert ${nc === 1 ? "1 column" : cols} right`, disabled: ro, run: () => view.insertCols(true) },
      { label: `Delete ${cols}`, disabled: ro, danger: true, run: () => view.deleteCols() },
    ];
    if (kind === "row") return [...clip, ...rowItems, { label: "Reset row height", disabled: ro, run: () => view.resize("row", r.r0, null) }];
    if (kind === "col") return [...clip, ...colItems, { label: "Reset column width", disabled: ro, run: () => view.resize("col", r.c0, null) }];
    return [...clip, rowItems[0], colItems[0], rowItems[2], colItems[2], "-", { label: "Clear contents", hint: "Delete", disabled: ro, run: () => view.clear() }];
  };

  const importTab = async (f: File) => {
    const text = await f.text();
    const rows = parseCsv(text);
    while (rows.length && rows[rows.length - 1].every((v) => v === "")) rows.pop();
    if (!rows.length) return live.say("That file is empty");
    const width = Math.max(...rows.map((x) => x.length));
    const lim = live.limits;
    if (rows.length > lim.maxRows || width > lim.maxCols) return live.say(`A sheet can have up to ${lim.maxRows} rows and ${lim.maxCols} columns`);
    const next = idMaker();
    const ids = Array.from({ length: Math.max(lim.defaultRows, rows.length) }, next);
    const cols = Array.from({ length: Math.max(lim.defaultCols, width) }, next);
    const cells: [string, string, string][] = [];
    rows.forEach((line, i) => line.forEach((v, j) => v !== "" && cells.push([ids[i], cols[j], csvInput(v, lim.maxCellChars)])));
    if (cells.length > lim.maxCellsPerOp) return live.say("That file is too big to add as a tab. Import it from your sheets list instead.");
    const name = f.name.replace(/\.csv$/i, "").replace(/[\\/?*[\]:']/g, " ").trim().slice(0, 90) || doc.nextTabName();
    const tabId = next();
    const at = doc.order.indexOf(view.tabId);
    if (live.edit([{ t: "addTab", id: tabId, name, before: doc.order[at + 1] ?? null, rows: ids, cols, cells }])) view.switchTab(tabId);
  };

  const fileMenu: MenuItem[] = [
    {
      label: "New spreadsheet",
      run: async () => {
        try {
          go(`/s/${(await api.create()).id}`);
        } catch (e) {
          live.say((e as Error).message);
        }
      },
    },
    {
      label: "Make a copy",
      run: async () => {
        try {
          go(`/s/${(await api.copy(meta.id)).id}`);
        } catch (e) {
          live.say((e as Error).message);
        }
      },
    },
    "-",
    { label: "Download this sheet as CSV", run: () => (location.href = api.exportUrl(meta.id, view.tabId)) },
    { label: "Import a CSV file as a new sheet", disabled: ro, run: () => file.current?.click() },
    "-",
    { label: "Delete spreadsheet", danger: true, disabled: meta.role !== "owner", run: () => setConfirm("delete") },
  ];

  const preview = async (v: VersionInfo | null) => {
    if (!v) return view.setPreview(null);
    try {
      const { state } = await api.version(meta.id, v.id);
      const pdoc = Doc.fromJSON(state);
      const pcalc = new Calc(pdoc);
      pcalc.recalc();
      view.setPreview({ doc: pdoc, calc: pcalc, label: v.name ?? new Date(v.createdAt).toLocaleString(), id: v.id });
    } catch (e) {
      live.say((e as Error).message);
    }
  };

  const others = [...new Map([...live.peers.values()].map((p) => [p.user, p])).values()];

  return (
    <div className="editor">
      <header className="topbar">
        <Link to="/sheets" className="wordmark" aria-label={`${APP_NAME}, all sheets`}>
          <Logo />
        </Link>
        <input
          className="title"
          aria-label="Spreadsheet title"
          value={title ?? doc.title}
          readOnly={ro}
          onChange={(e) => setTitle(e.target.value)}
          onBlur={() => {
            if (title !== null) view.setTitle(title);
            setTitle(null);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") e.currentTarget.blur();
            if (e.key === "Escape") {
              setTitle(null);
              e.currentTarget.blur();
            }
          }}
        />
        <button
          className="menu-button"
          onClick={(e) => {
            const r = e.currentTarget.getBoundingClientRect();
            setMenu({ x: r.left, y: r.bottom + 4, kind: "file" });
          }}
        >
          File
        </button>
        <span className="grow" />
        <div className="peers" role="group" aria-label="People in this sheet">
          {others.slice(0, 5).map((p) => (
            <span key={p.client} className="avatar" style={{ background: p.color }} title={p.user === user.id ? `${p.name} (you, in another window)` : p.name}>
              {initials(p.name)}
            </span>
          ))}
          {others.length > 5 && <span className="avatar more">+{others.length - 5}</span>}
        </div>
        <button className={history ? "ghost on" : "ghost"} onClick={() => setHistory(!history)} aria-pressed={history} aria-label="Version history">
          <Icon name="history" /> <span className="label">History</span>
        </button>
        <button className="primary" onClick={() => setShare(true)}>
          Share
        </button>
        <Account user={user} onUser={onUser} />
      </header>
      <main className="workarea">
      <h1 className="sr-only">{doc.title}</h1>
      <Toolbar view={view} live={live} />
      <FormulaBar view={view} />
      {view.preview && (
        <div className="preview-bar" role="status">
          <span>
            Viewing the version from <b>{view.preview.label}</b>. Edits are turned off while you look.
          </span>
          <button onClick={() => view.setPreview(null)}>Back to the current sheet</button>
        </div>
      )}
      <div className="body">
        <Grid view={view} live={live} onMenu={(x, y, kind) => setMenu({ x, y, kind })} />
        {history && (
          <HistoryPanel
            sheetId={meta.id}
            canEdit={meta.role !== "viewer" && live.role !== "viewer"}
            previewing={view.preview?.id ?? null}
            onPreview={(v) => void preview(v)}
            onRestore={async (v) => {
              try {
                await api.restore(meta.id, v.id);
                view.setPreview(null);
              } catch (e) {
                live.say((e as Error).message);
              }
            }}
            onClose={() => {
              setHistory(false);
              view.setPreview(null);
            }}
          />
        )}
      </div>
      <TabBar view={view} live={live} />
      </main>
      <input
        ref={file}
        type="file"
        accept=".csv,text/csv"
        hidden
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) void importTab(f);
          e.target.value = "";
        }}
      />
      {menu && <Menu x={menu.x} y={menu.y} items={menu.kind === "file" ? fileMenu : cellMenu(menu.kind)} onClose={() => setMenu(null)} />}
      {share && <ShareDialog meta={{ ...meta, title: doc.title }} onChange={onMeta} onClose={() => setShare(false)} />}
      {confirm === "delete" && (
        <Confirm
          title="Delete this spreadsheet?"
          body={`"${doc.title}" will be deleted for everyone it is shared with. This can't be undone.`}
          action="Delete"
          onClose={() => setConfirm(null)}
          onYes={async () => {
            try {
              await api.remove(meta.id);
              go("/sheets");
            } catch (e) {
              live.say((e as Error).message);
            }
          }}
        />
      )}
      {live.notice && <Toast key={live.notice.at} text={live.notice.text} />}
    </div>
  );
}

export function EditorPage({ id, user, onUser }: { id: string; user: User | null; onUser: (u: User | null) => void }) {
  const [loaded, setLoaded] = useState<{ key: string; meta: SheetMeta | null; error: string | null } | null>(null);
  const [gateError, setGateError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const key = `${id}:${user?.id ?? ""}`;
  const uid = user?.id;
  useEffect(() => {
    if (!uid) return;
    let alive = true;
    const key = `${id}:${uid}`;
    api.sheet(id).then(
      (meta) => alive && setLoaded({ key, meta, error: null }),
      (e: ApiError) => alive && setLoaded({ key, meta: null, error: e.message }),
    );
    return () => {
      alive = false;
    };
  }, [id, uid]);
  const onMeta = useCallback((meta: SheetMeta) => setLoaded((s) => (s ? { ...s, meta } : s)), []);
  const current = loaded?.key === key ? loaded : null;
  const meta = current?.meta ?? null;
  const error = current?.error ?? null;

  if (!user) {
    return (
      <main className="center-page">
        <div className="gate">
          <Link to="/" className="wordmark">
            <Logo />
            {APP_NAME}
          </Link>
          <h1>Someone shared a spreadsheet with you</h1>
          <p className="muted">Continue as a guest to open it now, or log in if you already have an account.</p>
          <div className="actions">
            <button
              className="primary"
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                try {
                  onUser((await api.guest()).user);
                } catch (e) {
                  setGateError((e as Error).message);
                } finally {
                  setBusy(false);
                }
              }}
            >
              Continue as a guest
            </button>
            <Link to={`/login?next=/s/${id}`} className="button">
              Log in
            </Link>
          </div>
          {gateError && <p className="error">{gateError}</p>}
        </div>
      </main>
    );
  }
  if (error) {
    return (
      <main className="center-page">
        <div className="gate">
          <h1>This sheet isn't available</h1>
          <p className="muted">{error}. Ask the owner to share it with you, or check that the link is complete.</p>
          <Link to="/sheets" className="button primary">
            Go to your sheets
          </Link>
        </div>
      </main>
    );
  }
  if (!meta) return <main className="center-page" />;
  return <Workspace key={id} id={id} user={user} meta={meta} onUser={onUser} onMeta={onMeta} />;
}
