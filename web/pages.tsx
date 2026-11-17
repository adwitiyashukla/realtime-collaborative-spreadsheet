import { useCallback, useEffect, useRef, useState } from "react";
import { compileInput } from "../shared/calc/parse.ts";
import { idMaker } from "../shared/ids.ts";
import { NO_LIMITS, newDoc } from "../shared/model.ts";
import type { SheetSummary, User } from "../shared/protocol.ts";
import { api } from "./api.ts";
import { APP_NAME, Confirm, Logo } from "./dialogs.tsx";
import { Grid } from "./grid.tsx";
import { LiveSheet } from "./live.ts";
import { Link, go } from "./router.tsx";
import { SheetView } from "./sheet.ts";

const SOURCE = "https://github.com/adwitiyashukla/realtime-collaborative-spreadsheet";
const DEMO_ROWS = 12;
const DEMO_COLS = 6;

function demoSheet(): { live: LiveSheet; view: SheetView } {
  const next = idMaker("demo");
  const doc = newDoc(DEMO_ROWS, DEMO_COLS, next, "Hackathon snacks");
  const tab = doc.liveTabs()[0];
  const data = [
    ["Item", "Qty", "Price", "Total"],
    ["Pizza", "6", "14.50", "=B2*C2"],
    ["Sodas", "24", "1.25", "=B3*C3"],
    ["Chips", "10", "2.75", "=B4*C4"],
    ["Coffee", "3", "18", "=B5*C5"],
    ["Fruit", "2", "9.50", "=B6*C6"],
    ["Total", "=SUM(B2:B6)", "", "=SUM(D2:D6)"],
    ["Per person (12)", "", "", "=D7/12"],
  ];
  const cells: [string, string, string][] = [];
  data.forEach((line, r) => line.forEach((v, c) => v && cells.push([tab.rows.idAt(r)!, tab.cols.idAt(c)!, compileInput(v, doc, tab.id)])));
  doc.apply({ t: "set", tab: tab.id, cells });
  const cell = (r: number, c: number) => [tab.rows.idAt(r)!, tab.cols.idAt(c)!] as const;
  doc.apply({
    t: "style",
    tab: tab.id,
    cells: [
      ...[0, 1, 2, 3].map((c): [string, string, { b: true; bg: string }] => [...cell(0, c), { b: true, bg: "#e6f4ea" }]),
      ...[1, 2, 3, 4, 5].flatMap((r) => [2, 3].map((c): [string, string, { nf: string }] => [...cell(r, c), { nf: "currency:2" }])),
      [...cell(6, 0), { b: true }],
      [...cell(6, 1), { b: true }],
      [...cell(6, 3), { b: true, nf: "currency:2" }],
      [...cell(7, 3), { nf: "currency:2" }],
    ],
  });
  doc.apply({ t: "resize", tab: tab.id, axis: "col", sizes: [[tab.cols.idAt(0)!, 130], [tab.cols.idAt(1)!, 64], [tab.cols.idAt(2)!, 84], [tab.cols.idAt(3)!, 96]] });
  const live = new LiveSheet("demo", { state: doc.toJSON(), limits: { ...NO_LIMITS, defaultRows: DEMO_ROWS, defaultCols: DEMO_COLS } });
  const view = new SheetView(live);
  view.select(6, 3);
  return { live, view };
}

function Demo() {
  const [{ live, view }] = useState(demoSheet);
  useEffect(() => {
    const t = live.doc!.liveTabs()[0];
    const peers = [
      { client: "demo-priya", user: "priya", name: "Priya", color: "#1a73e8" },
      { client: "demo-marcus", user: "marcus", name: "Marcus", color: "#c5221f" },
    ];
    let turn = 0;
    let timer: ReturnType<typeof setTimeout>;
    const step = () => {
      const p = peers[turn % 2];
      const r = 1 + Math.floor(Math.random() * 5);
      const row = t.rows.idAt(r)!;
      const col = t.cols.idAt(1)!;
      live.simulate({ ...p, tab: t.id, sel: [row, col, row, col], editing: true }, p.client);
      timer = setTimeout(() => {
        const busy = view.editing && view.anchor.row === row && view.anchor.col === col;
        if (!busy) {
          const now = Number(t.input(row, col) ?? "1");
          const delta = Math.random() < 0.5 ? -1 : 1 + Math.floor(Math.random() * 2);
          live.edit([{ t: "set", tab: t.id, cells: [[row, col, String(Math.max(1, now + delta))]] }], false);
        }
        live.simulate({ ...p, tab: t.id, sel: [row, col, row, col], editing: false }, p.client);
        turn++;
        timer = setTimeout(step, 900 + Math.random() * 700);
      }, 700);
    };
    timer = setTimeout(step, 600);
    return () => clearTimeout(timer);
  }, [live, view]);
  return (
    <figure className="demo">
      <div className="demo-grid">
        <Grid view={view} live={live} footer={false} onMenu={() => {}} />
      </div>
      <figcaption>Priya and Marcus are changing quantities. Click a cell and type to join in. This demo runs in your browser only.</figcaption>
    </figure>
  );
}

function useStart(onUser: (u: User) => void, user: User | null) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const start = async () => {
    setBusy(true);
    setError(null);
    try {
      if (!user) onUser((await api.guest()).user);
      const { id } = await api.create("demo");
      go(`/s/${id}`);
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  };
  return { busy, error, start };
}

export function Landing({ user, onUser }: { user: User | null; onUser: (u: User) => void }) {
  const { busy, error, start } = useStart(onUser, user);
  return (
    <div className="landing">
      <header className="site-head">
        <span className="wordmark">
          <Logo />
          {APP_NAME}
        </span>
        <nav>
          {user ? (
            <Link to="/sheets" className="button">
              Your sheets
            </Link>
          ) : (
            <Link to="/login" className="button">
              Log in
            </Link>
          )}
        </nav>
      </header>
      <main>
        <section className="hero">
          <div className="pitch">
            <h1>Spreadsheets you edit together, live.</h1>
            <p>
              This is a Google Sheets style web app I built from scratch. It has its own formula engine, live editing for many people at once, version
              history and sharing.
            </p>
            <div className="actions">
              <button className="primary big" disabled={busy} onClick={start}>
                {busy ? "Opening a demo sheet" : "Try it with a demo sheet"}
              </button>
              {!user && (
                <Link to="/signup" className="button big">
                  Create an account
                </Link>
              )}
            </div>
            {error && <p className="error">{error}</p>}
            <p className="muted small">No sign up needed. You get a guest account, and you can turn it into a real one later.</p>
          </div>
          <Demo />
        </section>
        <section className="inside">
          <h2>What is inside</h2>
          <dl>
            <div>
              <dt>Formula engine</dt>
              <dd>Over 100 functions like SUMIFS, XLOOKUP and DATEDIF. A dependency graph means one edit only recalculates the cells that depend on it.</dd>
            </div>
            <div>
              <dt>Live editing</dt>
              <dd>Every edit goes through the server over WebSockets and everyone sees the same result. If you go offline, your edits sync when you are back.</dd>
            </div>
            <div>
              <dt>Rows that keep their place</dt>
              <dd>Rows and columns have fixed ids, so inserting rows while someone else types never moves their edit or breaks a formula.</dd>
            </div>
            <div>
              <dt>History and sharing</dt>
              <dd>Look back at older versions and restore one, share by link or email, and import or export CSV files.</dd>
            </div>
          </dl>
          <p>
            <a href={SOURCE}>Read the source code on GitHub</a>
          </p>
        </section>
      </main>
    </div>
  );
}

export function AuthPage({ mode, next, user, onUser }: { mode: "login" | "signup"; next: string | null; user: User | null; onUser: (u: User) => void }) {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const signup = mode === "signup";
  const target = next && next.startsWith("/") && !next.startsWith("//") ? next : "/sheets";
  return (
    <main className="center-page">
      <form
        className="auth"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setError(null);
          try {
            const res = signup ? await api.signup(name, email, password) : await api.login(email, password);
            onUser(res.user);
            go(target, true);
          } catch (err) {
            setError((err as Error).message);
            setBusy(false);
          }
        }}
      >
        <Link to="/" className="wordmark">
          <Logo />
          {APP_NAME}
        </Link>
        <h1>{signup ? "Create your account" : "Log in"}</h1>
        {signup && user?.guest && <p className="muted">Your guest sheets will move into this account.</p>}
        {signup && (
          <label className="field">
            <span>Name</span>
            <input value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" required maxLength={60} />
          </label>
        )}
        <label className="field">
          <span>Email</span>
          <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" required />
        </label>
        <label className="field">
          <span>Password</span>
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete={signup ? "new-password" : "current-password"}
            minLength={signup ? 8 : undefined}
            required
          />
          {signup && <small className="muted">At least 8 characters</small>}
        </label>
        {error && <p className="error">{error}</p>}
        <button className="primary big" disabled={busy}>
          {signup ? "Create account" : "Log in"}
        </button>
        <p className="muted switch">
          {signup ? "Already have an account? " : "New here? "}
          <Link to={`${signup ? "/login" : "/signup"}${next ? `?next=${encodeURIComponent(next)}` : ""}`}>{signup ? "Log in" : "Create an account"}</Link>
        </p>
      </form>
    </main>
  );
}

function ago(iso: string): string {
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  if (s < 172800) return "yesterday";
  return new Date(iso).toLocaleDateString([], { month: "short", day: "numeric", year: "numeric" });
}

export function Home({ user, onUser }: { user: User | null; onUser: (u: User | null) => void }) {
  const [sheets, setSheets] = useState<SheetSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [doomed, setDoomed] = useState<SheetSummary | null>(null);
  const file = useRef<HTMLInputElement>(null);
  const load = useCallback(() => api.sheets().then((r) => setSheets(r.sheets), (e: Error) => setError(e.message)), []);
  const uid = user?.id;
  useEffect(() => {
    if (!uid) {
      go("/login?next=/sheets", true);
      return;
    }
    void load();
  }, [uid, load]);
  if (!user) return null;
  const run = async (fn: () => Promise<{ id: string }>) => {
    setBusy(true);
    setError(null);
    try {
      go(`/s/${(await fn()).id}`);
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  };
  return (
    <div className="home">
      <header className="site-head">
        <Link to="/" className="wordmark">
          <Logo />
          {APP_NAME}
        </Link>
        <nav>
          <span className="muted">{user.guest ? `${user.name}, guest` : user.name}</span>
          {user.guest && (
            <Link to="/signup" className="button">
              Create an account
            </Link>
          )}
          <button
            onClick={async () => {
              await api.logout().catch(() => {});
              onUser(null);
              go("/");
            }}
          >
            Log out
          </button>
        </nav>
      </header>
      <main>
        <div className="home-head">
          <h1>Your sheets</h1>
          <div className="actions">
            <button className="primary" disabled={busy} onClick={() => run(() => api.create())}>
              New spreadsheet
            </button>
            <button disabled={busy} onClick={() => run(() => api.create("demo"))}>
              Copy of the sales demo
            </button>
            <button disabled={busy} onClick={() => file.current?.click()}>
              Import a CSV file
            </button>
            <input
              ref={file}
              type="file"
              accept=".csv,text/csv"
              hidden
              onChange={(e) => {
                const f = e.target.files?.[0];
                e.target.value = "";
                if (f) void run(() => api.importCsv(f));
              }}
            />
          </div>
        </div>
        {user.guest && <p className="note">You are using a guest account. It is removed after a week, so create an account if you want to keep your sheets.</p>}
        {error && <p className="error">{error}</p>}
        {sheets && sheets.length === 0 && <p className="empty">No sheets yet. Start a new one or open a copy of the sales demo.</p>}
        {sheets && sheets.length > 0 && (
          <table className="sheet-list">
            <thead>
              <tr>
                <th scope="col">Name</th>
                <th scope="col">Owner</th>
                <th scope="col">Your access</th>
                <th scope="col">Last change</th>
                <th scope="col">
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {sheets.map((s) => (
                <tr key={s.id}>
                  <td>
                    <Link to={`/s/${s.id}`}>{s.title}</Link>
                  </td>
                  <td>{s.role === "owner" ? "You" : s.owner}</td>
                  <td>{s.role === "owner" ? "Owner" : s.role === "editor" ? "Can edit" : "Can view"}</td>
                  <td>{ago(s.updatedAt)}</td>
                  <td className="row-actions">
                    {s.role === "owner" && (
                      <button className="link danger" onClick={() => setDoomed(s)}>
                        Delete
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </main>
      {doomed && (
        <Confirm
          title="Delete this spreadsheet?"
          body={`"${doomed.title}" will be deleted for everyone it is shared with. This can't be undone.`}
          action="Delete"
          onClose={() => setDoomed(null)}
          onYes={async () => {
            try {
              await api.remove(doomed.id);
              void load();
            } catch (e) {
              setError((e as Error).message);
            }
          }}
        />
      )}
    </div>
  );
}
