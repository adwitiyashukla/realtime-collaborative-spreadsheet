import { type ReactNode, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { SheetMeta, VersionInfo } from "../shared/protocol.ts";
import { api } from "./api.ts";

const PATHS: Record<string, string> = {
  undo: "M9 7H5V3M5.5 7.5A7 7 0 1 1 5 13",
  redo: "M15 7h4V3M18.5 7.5A7 7 0 1 0 19 13",
  left: "M4 6h16M4 10h10M4 14h16M4 18h10",
  center: "M4 6h16M7 10h10M4 14h16M7 18h10",
  right: "M4 6h16M10 10h10M4 14h16M10 18h10",
  fill: "M5 13l7-7 7 7-7 7zM5 13h14M20 16c0 1.5 1 2.5 1 3.5a1 1 0 0 1-2 0c0-1 1-2 1-3.5z",
  history: "M12 7v5l3 2M3.5 12a8.5 8.5 0 1 0 2.5-6M3 4v4h4",
  plus: "M12 5v14M5 12h14",
  close: "M6 6l12 12M18 6L6 18",
  sum: "M17 5H7l6 7-6 7h10",
  more: "M5 12h.01M12 12h.01M19 12h.01",
  less: "M6 15l6-6 6 6",
  down: "M6 9l6 6 6-6",
  fewer: "M3.1 14a.9 .9 0 1 0 1.8 0a.9 .9 0 1 0-1.8 0M6.4 9.5a2.6 4.5 0 1 0 5.2 0a2.6 4.5 0 1 0-5.2 0M21 19.5H12M15 16.5l-3 3 3 3",
  more_decimals: "M2.1 14a.9 .9 0 1 0 1.8 0a.9 .9 0 1 0-1.8 0M5.2 9.5a2.3 4.5 0 1 0 4.6 0a2.3 4.5 0 1 0-4.6 0M11.7 9.5a2.3 4.5 0 1 0 4.6 0a2.3 4.5 0 1 0-4.6 0M7 19.5h12M16 16.5l3 3-3 3",
};

export function Icon({ name, size = 18 }: { name: string; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={name === "more" ? 3 : 1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={PATHS[name]} />
    </svg>
  );
}

function useLatest<T>(value: T): { current: T } {
  const ref = useRef(value);
  useLayoutEffect(() => {
    ref.current = value;
  });
  return ref;
}

export const APP_NAME = "Realtime Collaborative Spreadsheet";

export function Logo() {
  return (
    <svg className="logo" width="22" height="22" viewBox="0 0 24 24" aria-hidden="true">
      <rect x="3" y="3" width="18" height="18" rx="3" fill="none" stroke="currentColor" strokeWidth="2" />
      <path d="M3 9h18M3 15h18M9 3v18M15 3v18" fill="none" stroke="currentColor" strokeWidth="1.5" />
      <rect x="9" y="9" width="6" height="6" fill="currentColor" />
    </svg>
  );
}

export type MenuItem = { label: string; run: () => void; disabled?: boolean; danger?: boolean; hint?: string } | "-";

export function Menu({ x, y, items, onClose, above = false }: { x: number; y: number; items: MenuItem[]; onClose: () => void; above?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ x, y });
  const closeRef = useLatest(onClose);
  useLayoutEffect(() => {
    const el = ref.current!;
    const r = el.getBoundingClientRect();
    setPos({ x: Math.max(8, Math.min(x, innerWidth - r.width - 8)), y: above ? Math.max(8, y - r.height - 4) : Math.max(8, Math.min(y, innerHeight - r.height - 8)) });
    el.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus();
    const close = (e: Event) => {
      if (e instanceof KeyboardEvent && e.key !== "Escape") return;
      if (e instanceof PointerEvent && el.contains(e.target as Node)) return;
      closeRef.current();
    };
    const blur = () => closeRef.current();
    addEventListener("pointerdown", close, true);
    addEventListener("keydown", close, true);
    addEventListener("blur", blur);
    return () => {
      removeEventListener("pointerdown", close, true);
      removeEventListener("keydown", close, true);
      removeEventListener("blur", blur);
    };
  }, [x, y, above, closeRef]);
  const move = (e: React.KeyboardEvent) => {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    e.preventDefault();
    const buttons = [...ref.current!.querySelectorAll<HTMLButtonElement>("button:not(:disabled)")];
    const i = buttons.indexOf(document.activeElement as HTMLButtonElement);
    buttons[(i + (e.key === "ArrowDown" ? 1 : buttons.length - 1)) % buttons.length]?.focus();
  };
  return (
    <div ref={ref} className="menu" role="menu" style={{ left: pos.x, top: pos.y }} onKeyDown={move}>
      {items.map((item, i) =>
        item === "-" ? (
          <hr key={i} />
        ) : (
          <button
            key={i}
            role="menuitem"
            className={item.danger ? "danger" : ""}
            disabled={item.disabled}
            onClick={() => {
              onClose();
              item.run();
            }}
          >
            <span>{item.label}</span>
            {item.hint && <kbd>{item.hint}</kbd>}
          </button>
        ),
      )}
    </div>
  );
}

export const TEXT_COLORS = ["#18241d", "#5f6368", "#c5221f", "#e37400", "#b06000", "#188038", "#007b83", "#1a73e8", "#5b39c6", "#a1256f"];
export const FILL_COLORS = ["#fde2e1", "#fdecd2", "#fef7e0", "#e6f4ea", "#d7f0ee", "#e8f0fe", "#ede7fb", "#fbe4f1", "#eceff1", "#d2e3fc"];

export function Swatches({
  colors,
  label,
  current,
  at,
  onPick,
  onClose,
}: {
  colors: string[];
  label: string;
  current?: string;
  at: { x: number; y: number };
  onPick: (c: string | null) => void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const closeRef = useLatest(onClose);
  useEffect(() => {
    const close = (e: Event) => {
      if (e instanceof KeyboardEvent && e.key !== "Escape") return;
      if (e instanceof PointerEvent && ref.current?.contains(e.target as Node)) return;
      closeRef.current();
    };
    addEventListener("pointerdown", close, true);
    addEventListener("keydown", close, true);
    ref.current?.querySelector("button")?.focus();
    return () => {
      removeEventListener("pointerdown", close, true);
      removeEventListener("keydown", close, true);
    };
  }, [closeRef]);
  return (
    <div ref={ref} className="swatches" role="dialog" aria-label={label} style={{ left: Math.min(at.x, innerWidth - 176), top: at.y }}>
      <div className="swatch-grid">
        {colors.map((c) => (
          <button key={c} className={c === current ? "swatch on" : "swatch"} style={{ background: c }} aria-label={c} onClick={() => onPick(c)} />
        ))}
      </div>
      <button className="link" onClick={() => onPick(null)}>
        Reset
      </button>
    </div>
  );
}

export function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const closeRef = useLatest(onClose);
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    ref.current?.querySelector<HTMLElement>("input, select, button.primary, button")?.focus();
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") closeRef.current();
    };
    addEventListener("keydown", key);
    return () => {
      removeEventListener("keydown", key);
      prev?.focus();
    };
  }, [closeRef]);
  return (
    <div className="backdrop" onPointerDown={(e) => e.target === e.currentTarget && closeRef.current()}>
      <div ref={ref} className="modal" role="dialog" aria-modal="true" aria-label={title}>
        <div className="modal-head">
          <h2>{title}</h2>
          <button className="icon" aria-label="Close" onClick={onClose}>
            <Icon name="close" />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

export function ShareDialog({ meta, onChange, onClose }: { meta: SheetMeta; onChange: (m: SheetMeta) => void; onClose: () => void }) {
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<"editor" | "viewer">("editor");
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState(false);
  const owner = meta.role === "owner";
  const link = `${location.origin}/s/${meta.id}`;
  const changeRef = useLatest(onChange);
  useEffect(() => {
    api.sheet(meta.id).then(
      (m) => changeRef.current(m),
      () => {},
    );
  }, [meta.id, changeRef]);
  const run = async (fn: () => Promise<SheetMeta>) => {
    setBusy(true);
    setError(null);
    try {
      onChange(await fn());
      return true;
    } catch (e) {
      setError((e as Error).message);
      return false;
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal title={`Share "${meta.title}"`} onClose={onClose}>
      <section className="share">
        <label className="field">
          <span>Anyone with the link</span>
          <select
            value={meta.linkAccess}
            disabled={!owner || busy}
            onChange={(e) => void run(() => api.setLinkAccess(meta.id, e.target.value as SheetMeta["linkAccess"]))}
          >
            <option value="none">No access</option>
            <option value="viewer">Can view</option>
            <option value="editor">Can edit</option>
          </select>
        </label>
        <div className="copy-link">
          <input readOnly value={link} aria-label="Link to this sheet" onFocus={(e) => e.currentTarget.select()} />
          <button
            onClick={async () => {
              await navigator.clipboard?.writeText(link).catch(() => {});
              setCopied(true);
              setTimeout(() => setCopied(false), 1500);
            }}
          >
            {copied ? "Copied" : "Copy link"}
          </button>
        </div>
        {owner ? (
          <>
            <form
              className="invite"
              onSubmit={async (e) => {
                e.preventDefault();
                if (email.trim() && (await run(() => api.addMember(meta.id, email.trim(), role)))) setEmail("");
              }}
            >
              <input type="email" placeholder="Add people by email" value={email} onChange={(e) => setEmail(e.target.value)} aria-label="Email address" />
              <select value={role} onChange={(e) => setRole(e.target.value as "editor" | "viewer")} aria-label="Role">
                <option value="editor">Editor</option>
                <option value="viewer">Viewer</option>
              </select>
              <button className="primary" disabled={busy || !email.trim()}>
                Share
              </button>
            </form>
            {error && <p className="error">{error}</p>}
            <ul className="people">
              <li>
                <span>
                  {meta.owner.name} <em>(you)</em>
                </span>
                <span className="muted">Owner</span>
              </li>
              {meta.members.map((m) => (
                <li key={m.id}>
                  <span>
                    {m.name} <em>{m.email}</em>
                  </span>
                  <span>
                    <select value={m.role} aria-label={`Role for ${m.name}`} onChange={(e) => void run(() => api.addMember(meta.id, m.email!, e.target.value as "editor" | "viewer"))}>
                      <option value="editor">Editor</option>
                      <option value="viewer">Viewer</option>
                    </select>
                    <button className="link danger" onClick={() => void run(() => api.removeMember(meta.id, m.id))}>
                      Remove
                    </button>
                  </span>
                </li>
              ))}
            </ul>
          </>
        ) : (
          <p className="muted">Only {meta.owner.name}, the owner, can change who has access.</p>
        )}
      </section>
    </Modal>
  );
}

const KIND_LABEL: Record<string, string> = {
  auto: "Saved automatically",
  named: "Named version",
  restore: "Restored an earlier version",
  create: "Created",
  template: "Created from the demo",
  import: "Imported from CSV",
  copy: "Copied",
};

function when(iso: string): string {
  const d = new Date(iso);
  const today = new Date();
  const time = d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  if (d.toDateString() === today.toDateString()) return `Today, ${time}`;
  return `${d.toLocaleDateString([], { month: "short", day: "numeric", year: d.getFullYear() === today.getFullYear() ? undefined : "numeric" })}, ${time}`;
}

export function HistoryPanel({
  sheetId,
  canEdit,
  previewing,
  onPreview,
  onRestore,
  onClose,
}: {
  sheetId: string;
  canEdit: boolean;
  previewing: number | null;
  onPreview: (v: VersionInfo | null) => void;
  onRestore: (v: VersionInfo) => void;
  onClose: () => void;
}) {
  const [versions, setVersions] = useState<VersionInfo[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState("");
  const load = useCallback(
    () =>
      api
        .versions(sheetId)
        .then((r) => setVersions(r.versions))
        .catch((e: Error) => setError(e.message)),
    [sheetId],
  );
  useEffect(() => {
    void load();
  }, [load]);
  return (
    <aside className="history" aria-label="Version history">
      <header>
        <h2>Version history</h2>
        <button className="icon" aria-label="Close version history" onClick={onClose}>
          <Icon name="close" />
        </button>
      </header>
      {canEdit && (
        <form
          className="name-version"
          onSubmit={async (e) => {
            e.preventDefault();
            if (!name.trim()) return;
            try {
              await api.saveVersion(sheetId, name.trim());
              setName("");
              void load();
            } catch (err) {
              setError((err as Error).message);
            }
          }}
        >
          <input placeholder="Name the current version" value={name} onChange={(e) => setName(e.target.value)} aria-label="Version name" />
          <button disabled={!name.trim()}>Save</button>
        </form>
      )}
      {error && <p className="error">{error}</p>}
      {!versions && !error && <p className="muted pad">Loading versions</p>}
      <ol className="versions">
        <li>
          <button className={previewing === null ? "on" : ""} onClick={() => onPreview(null)}>
            <b>Current version</b>
            <span>What everyone is editing now</span>
          </button>
        </li>
        {versions?.map((v) => (
          <li key={v.id}>
            <button className={previewing === v.id ? "on" : ""} onClick={() => onPreview(v)}>
              <b>{v.name ?? when(v.createdAt)}</b>
              <span>
                {v.name ? `${when(v.createdAt)}, ` : ""}
                {KIND_LABEL[v.kind] ?? v.kind}
              </span>
              {v.editors.length > 0 && <span className="muted">{v.editors.join(", ")}</span>}
            </button>
            {previewing === v.id && canEdit && (
              <button className="primary restore" onClick={() => onRestore(v)}>
                Restore this version
              </button>
            )}
          </li>
        ))}
      </ol>
    </aside>
  );
}

export function Toast({ text }: { text: string }) {
  return (
    <div className="toast" role="status">
      {text}
    </div>
  );
}

export function Confirm({ title, body, action, onYes, onClose }: { title: string; body: string; action: string; onYes: () => void; onClose: () => void }) {
  return (
    <Modal title={title} onClose={onClose}>
      <p className="confirm-body">{body}</p>
      <footer className="actions">
        <button onClick={onClose}>Cancel</button>
        <button
          className="primary danger"
          onClick={() => {
            onClose();
            onYes();
          }}
        >
          {action}
        </button>
      </footer>
    </Modal>
  );
}
