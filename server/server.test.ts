import { mkdtempSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { Calc } from "../shared/calc/engine.ts";
import { compileInput } from "../shared/calc/parse.ts";
import { parseCsv } from "../shared/csv.ts";
import { randomId } from "../shared/ids.ts";
import { Doc, type DocJSON, type Op } from "../shared/model.ts";
import type { ServerMessage } from "../shared/protocol.ts";
import { Replica } from "../shared/sync.ts";
import { type App, buildApp } from "./app.ts";
import { type Config, loadConfig } from "./config.ts";
import { type Database, migrate, openDatabase } from "./db.ts";

type Server = App & { database: Database; config: Config; base: string; dir: string };

const DB_URL = process.env.TEST_DATABASE_URL ?? "";

async function start(dir = "memory://", tweak?: (c: Config) => void): Promise<Server> {
  const config = loadConfig("config.toml", {});
  config.database.url = DB_URL;
  config.database.pglite_dir = dir;
  config.server.public_dir = join(tmpdir(), "no-public-dir");
  config.rooms.idle_unload_seconds = 1;
  tweak?.(config);
  const database = await openDatabase(config.database.url, dir);
  await migrate(database);
  const built = await buildApp(config, database, false);
  await built.app.listen({ host: "127.0.0.1", port: 0 });
  const port = (built.app.server.address() as AddressInfo).port;
  return { ...built, database, config, base: `127.0.0.1:${port}`, dir };
}

async function stop(s: Server): Promise<void> {
  await s.app.close();
  await s.database.close();
}

type Res = { status: number; body: any; headers: Headers };

class Browser {
  base: string;
  cookie = "";

  constructor(base: string) {
    this.base = base;
  }

  async req(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<Res> {
    const h: Record<string, string> = { ...headers };
    if (body !== undefined && typeof body !== "string") h["content-type"] = "application/json";
    if (this.cookie) h.cookie = this.cookie;
    const res = await fetch(`http://${this.base}${path}`, {
      method,
      headers: h,
      body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
    });
    const set = res.headers.get("set-cookie");
    if (set) this.cookie = /spreadsheet_session=;/.test(set) ? "" : set.split(";")[0];
    const type = res.headers.get("content-type") ?? "";
    return { status: res.status, headers: res.headers, body: type.includes("json") ? await res.json() : await res.text() };
  }

  get(path: string) {
    return this.req("GET", path);
  }

  post(path: string, body: unknown = {}, headers?: Record<string, string>) {
    return this.req("POST", path, body, headers);
  }

  async guest(): Promise<string> {
    return (await this.post("/api/auth/guest")).body.user.id;
  }

  async signup(name = "Ann"): Promise<{ id: string; email: string }> {
    const email = `${name.toLowerCase()}.${randomId(6)}@example.com`;
    const res = await this.post("/api/auth/signup", { email, password: "correct horse", name });
    expect(res.status).toBe(200);
    return { id: res.body.user.id, email };
  }

  async sheet(template: "blank" | "demo" = "blank"): Promise<string> {
    const res = await this.post("/api/sheets", { template });
    expect(res.status).toBe(200);
    return res.body.id;
  }

  live(sheet: string, seq = -1, client = randomId(10), origin?: string): Promise<Live> {
    return Live.open(this.base, this.cookie, sheet, seq, client, origin);
  }
}

class Live {
  ws: WebSocket;
  client: string;
  inbox: ServerMessage[] = [];
  closed: { code: number; reason: string } | null = null;
  private wake: (() => void) | null = null;
  private cseq = 0;

  private constructor(ws: WebSocket, client: string) {
    this.ws = ws;
    this.client = client;
    ws.on("message", (d) => {
      this.inbox.push(JSON.parse(d.toString()));
      this.wake?.();
    });
    ws.on("close", (code, reason) => {
      this.closed = { code, reason: reason.toString() };
      this.wake?.();
    });
  }

  static open(base: string, cookie: string, sheet: string, seq: number, client: string, origin?: string): Promise<Live> {
    return new Promise((resolve, reject) => {
      const headers: Record<string, string> = { cookie };
      if (origin) headers.origin = origin;
      const ws = new WebSocket(`ws://${base}/api/live/${sheet}`, { headers });
      const live = new Live(ws, client);
      ws.once("open", () => {
        live.send({ type: "hello", client, seq });
        resolve(live);
      });
      ws.once("error", reject);
      ws.once("unexpected-response", (_req, res) => reject(new Error(`status ${res.statusCode}`)));
    });
  }

  send(msg: unknown): void {
    this.ws.send(JSON.stringify(msg));
  }

  op(op: Op): number {
    this.send({ type: "op", cseq: ++this.cseq, op });
    return this.cseq;
  }

  async next<T extends ServerMessage["type"]>(type: T, pred: (m: Extract<ServerMessage, { type: T }>) => boolean = () => true): Promise<Extract<ServerMessage, { type: T }>> {
    const deadline = Date.now() + 8000;
    for (;;) {
      const i = this.inbox.findIndex((m) => m.type === type && pred(m as Extract<ServerMessage, { type: T }>));
      if (i >= 0) return this.inbox.splice(i, 1)[0] as Extract<ServerMessage, { type: T }>;
      if (this.closed) throw new Error(`closed ${this.closed.code} while waiting for ${type}`);
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${type}`);
      await new Promise<void>((r) => {
        this.wake = r;
        setTimeout(r, 100);
      });
    }
  }

  async closedWith(): Promise<{ code: number; reason: string }> {
    const deadline = Date.now() + 8000;
    while (!this.closed) {
      if (Date.now() > deadline) throw new Error("socket did not close");
      await new Promise((r) => setTimeout(r, 50));
    }
    return this.closed;
  }

  close(): void {
    this.ws.close();
  }
}

function firstCell(state: DocJSON, r = 0, c = 0): { tab: string; row: string; col: string } {
  const tab = state.tabs[0];
  return { tab: tab.id, row: tab.rows[r], col: tab.cols[c] };
}

function set(state: DocJSON, value: string, r = 0, c = 0): Op {
  const { tab, row, col } = firstCell(state, r, c);
  return { t: "set", tab, cells: [[row, col, value]] };
}

let server: Server;

beforeAll(async () => {
  server = await start();
});

afterAll(async () => {
  await stop(server);
});

describe("accounts", () => {
  it("signs up, logs out and logs back in", async () => {
    const b = new Browser(server.base);
    const email = `ann.${randomId(6)}@example.com`;
    const res = await b.post("/api/auth/signup", { email, password: "correct horse", name: "Ann" });
    expect(res.status).toBe(200);
    const cookie = res.headers.get("set-cookie")!;
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=Lax/i);
    expect((await b.get("/api/auth/me")).body.user.email).toBe(email.toLowerCase());
    expect((await b.post("/api/auth/signup", { email: email.toUpperCase(), password: "another one", name: "Ann" })).status).toBe(409);
    await b.post("/api/auth/logout");
    expect((await b.get("/api/auth/me")).body.user).toBeNull();
    expect((await b.post("/api/auth/login", { email, password: "wrong password" })).status).toBe(401);
    expect((await b.post("/api/auth/login", { email, password: "correct horse" })).status).toBe(200);
    expect((await b.get("/api/auth/me")).body.user.name).toBe("Ann");
  });

  it("rejects short passwords and bad emails", async () => {
    const b = new Browser(server.base);
    expect((await b.post("/api/auth/signup", { email: "x@example.com", password: "short", name: "X" })).status).toBe(400);
    expect((await b.post("/api/auth/signup", { email: "not-an-email", password: "long enough", name: "X" })).status).toBe(400);
  });

  it("keeps a guest's sheets when the guest signs up", async () => {
    const b = new Browser(server.base);
    const guestId = await b.guest();
    const sheet = await b.sheet("demo");
    const { id } = await b.signup("Gina");
    expect(id).toBe(guestId);
    const list = (await b.get("/api/sheets")).body.sheets;
    expect(list.map((s: { id: string }) => s.id)).toContain(sheet);
    expect((await b.get("/api/auth/me")).body.user.guest).toBe(false);
  });

  it("rate limits login attempts", async () => {
    const b = new Browser(server.base);
    let limited = false;
    for (let i = 0; i < 15; i++) {
      const res = await b.post("/api/auth/login", { email: "nobody@example.com", password: "nope nope" });
      if (res.status === 429) limited = true;
    }
    expect(limited).toBe(true);
  });

  it("blocks writes from other sites", async () => {
    const b = new Browser(server.base);
    await b.guest();
    const res = await b.post("/api/sheets", {}, { origin: "https://evil.example" });
    expect(res.status).toBe(403);
    const ok = await b.post("/api/sheets", {}, { origin: `http://${server.base}` });
    expect(ok.status).toBe(200);
  });

  it("requires sign in for sheets", async () => {
    const b = new Browser(server.base);
    expect((await b.get("/api/sheets")).status).toBe(401);
  });
});

describe("sheets", () => {
  it("lets only people with access open a sheet", async () => {
    const owner = new Browser(server.base);
    await owner.signup("Olga");
    const id = await owner.sheet();
    const other = new Browser(server.base);
    await other.signup("Omar");
    expect((await other.get(`/api/sheets/${id}`)).status).toBe(404);
    await expect(other.live(id)).rejects.toThrow("404");
    const meta = await owner.req("PATCH", `/api/sheets/${id}`, { linkAccess: "viewer" });
    expect(meta.body.linkAccess).toBe("viewer");
    expect((await other.get(`/api/sheets/${id}`)).body.role).toBe("viewer");
    expect((await other.req("PATCH", `/api/sheets/${id}`, { linkAccess: "editor" })).status).toBe(403);
    const live = await other.live(id);
    await live.next("welcome");
    live.close();
    const listed = (await other.get("/api/sheets")).body.sheets.find((s: { id: string }) => s.id === id);
    expect(listed.role).toBe("viewer");
  });

  it("shares with members by email and removes them", async () => {
    const owner = new Browser(server.base);
    await owner.signup("Pat");
    const id = await owner.sheet();
    const friend = new Browser(server.base);
    const { id: friendId, email } = await friend.signup("Quinn");
    expect((await owner.post(`/api/sheets/${id}/members`, { email: "missing@example.com", role: "editor" })).status).toBe(404);
    const added = await owner.post(`/api/sheets/${id}/members`, { email, role: "editor" });
    expect(added.body.members.map((m: { id: string }) => m.id)).toEqual([friendId]);
    expect((await friend.get(`/api/sheets/${id}`)).body.role).toBe("editor");
    const live = await friend.live(id);
    await live.next("welcome");
    await owner.req("DELETE", `/api/sheets/${id}/members/${friendId}`);
    expect((await live.closedWith()).code).toBe(4003);
    expect((await friend.get(`/api/sheets/${id}`)).status).toBe(404);
  });

  it("imports a CSV file and exports values back", async () => {
    const b = new Browser(server.base);
    await b.guest();
    const csv = 'item,qty,price\r\nPen,3,1.50\r\n"Desk, oak",1,250\r\n=HYPERLINK("x"),1,1\r\n';
    const res = await b.req("POST", "/api/sheets/import?name=budget.csv", csv, { "content-type": "text/csv" });
    expect(res.status).toBe(200);
    expect(res.body.rows).toBe(4);
    const live = await b.live(res.body.id);
    const welcome = await live.next("welcome");
    const state = welcome.state!;
    expect(state.title).toBe("budget");
    expect(state.tabs[0].name).toBe("budget");
    live.op(set(state, compileInput("=B2*C2", Doc.fromJSON(state), state.tabs[0].id), 1, 3));
    await live.next("ops");
    live.close();
    const out = await b.get(`/api/sheets/${res.body.id}/export.csv`);
    expect(out.headers.get("content-disposition")).toContain("budget");
    const rows = parseCsv(out.body);
    expect(rows[1]).toEqual(["Pen", "3", "1.5", "4.5"]);
    expect(rows[2][0]).toBe("Desk, oak");
    expect(rows[3][0]).toBe("'=HYPERLINK(\"x\")");
  });

  it("copies and deletes sheets", async () => {
    const b = new Browser(server.base);
    await b.guest();
    const id = await b.sheet("demo");
    const copy = await b.post(`/api/sheets/${id}/copy`);
    expect((await b.get(`/api/sheets/${copy.body.id}`)).body.title).toBe("Copy of Q3 sales tracker");
    expect((await b.req("DELETE", `/api/sheets/${id}`)).status).toBe(200);
    expect((await b.get(`/api/sheets/${id}`)).status).toBe(404);
  });

  it("creates a demo sheet whose formulas add up", async () => {
    const b = new Browser(server.base);
    await b.guest();
    const id = await b.sheet("demo");
    const live = await b.live(id);
    const { state } = await live.next("welcome");
    live.close();
    const doc = Doc.fromJSON(state!);
    const calc = new Calc(doc);
    calc.recalc();
    const sales = doc.findTab("Sales")!;
    const summary = doc.findTab("Summary")!;
    let total = 0;
    for (let r = 1; r <= 20; r++) total += (calc.value(sales.id, sales.rows.idAt(r)!, sales.cols.idAt(6)!) as number) ?? 0;
    const cell = (r: number, c: number) => calc.value(summary.id, summary.rows.idAt(r)!, summary.cols.idAt(c)!);
    expect(total).toBeGreaterThan(50000);
    expect(cell(1, 1)).toBe(total);
    expect([9, 10, 11, 12].reduce((sum, r) => sum + (cell(r, 1) as number), 0)).toBeCloseTo(total, 6);
    expect(cell(15, 1)).toBe(1250);
    expect(typeof cell(6, 1)).toBe("string");
    for (let r = 0; r < 20; r++) for (let c = 0; c < 4; c++) expect(calc.display(summary.id, summary.rows.idAt(r)!, summary.cols.idAt(c)!)).not.toMatch(/^#/);
  });

  it("limits how many sheets a user can create", async () => {
    const small = await start("memory://", (c) => {
      c.limits.max_sheets_per_user = 2;
    });
    try {
      const b = new Browser(small.base);
      await b.guest();
      await b.sheet();
      await b.sheet();
      expect((await b.post("/api/sheets", {})).status).toBe(403);
    } finally {
      await stop(small);
    }
  });
});

describe("live editing", () => {
  it("sends every edit to everyone in the same order", async () => {
    const b = new Browser(server.base);
    await b.guest();
    const id = await b.sheet();
    const one = await b.live(id);
    const two = await b.live(id);
    const w1 = await one.next("welcome");
    const w2 = await two.next("welcome");
    const r1 = new Replica(w1.state!, w1.seq, one.client);
    const r2 = new Replica(w2.state!, w2.seq, two.client);
    for (let i = 0; i < 20; i++) {
      const op1 = set(w1.state!, `a${i}`, i % 3, 0);
      r1.local(op1);
      one.op(op1);
      const op2 = set(w2.state!, `b${i}`, i % 3, 0);
      r2.local(op2);
      two.op(op2);
    }
    while (r1.seq < 40 || r2.seq < 40) {
      if (r1.seq < 40) r1.receive((await one.next("ops")).ops);
      if (r2.seq < 40) r2.receive((await two.next("ops")).ops);
    }
    expect(r1.pending).toEqual([]);
    expect(r2.pending).toEqual([]);
    expect(JSON.stringify(r1.doc.toJSON())).toBe(JSON.stringify(r2.doc.toJSON()));
    one.close();
    two.close();
  });

  it("rejects bad ops and edits from viewers", async () => {
    const owner = new Browser(server.base);
    await owner.guest();
    const id = await owner.sheet();
    await owner.req("PATCH", `/api/sheets/${id}`, { linkAccess: "viewer" });
    const viewer = new Browser(server.base);
    await viewer.guest();
    const live = await viewer.live(id);
    const w = await live.next("welcome");
    expect(w.role).toBe("viewer");
    const cseq = live.op(set(w.state!, "nope"));
    expect((await live.next("reject")).cseq).toBe(cseq);
    const mine = await owner.live(id);
    await mine.next("welcome");
    const bad = mine.op({ t: "set", tab: "missing", cells: [["a", "b", "c"]] });
    expect((await mine.next("reject")).reason).toBe("unknown tab");
    expect(bad).toBe(1);
    await owner.req("PATCH", `/api/sheets/${id}`, { linkAccess: "editor" });
    expect((await live.next("role")).role).toBe("editor");
    live.close();
    mine.close();
  });

  it("catches up a client that reconnects and ignores resent ops", async () => {
    const b = new Browser(server.base);
    await b.guest();
    const id = await b.sheet();
    const a = await b.live(id, -1, "clientA123");
    const w = await a.next("welcome");
    a.op(set(w.state!, "first"));
    const first = await a.next("ops");
    a.close();
    const other = await b.live(id);
    await other.next("welcome");
    other.op(set(w.state!, "second", 1));
    await other.next("ops");
    const again = await b.live(id, first.ops[0].seq, "clientA123");
    const w2 = await again.next("welcome");
    expect(w2.state).toBeUndefined();
    expect(w2.ops!.map((e) => e.seq)).toEqual([first.ops[0].seq + 1]);
    expect(w2.acked).toBe(1);
    again.send({ type: "op", cseq: 1, op: set(w.state!, "first") });
    again.send({ type: "op", cseq: 2, op: set(w.state!, "third", 2) });
    const next = await again.next("ops");
    expect(next.ops.map((e) => e.cseq)).toEqual([2]);
    again.close();
    other.close();
  });

  it("writes a burst of edits in a few database batches", async () => {
    const b = new Browser(server.base);
    await b.guest();
    const id = await b.sheet();
    const live = await b.live(id);
    const w = await live.next("welcome");
    for (let i = 0; i < 300; i++) live.op(set(w.state!, String(i), i % 50, i % 5));
    let seen = 0;
    while (seen < 300) seen += (await live.next("ops")).ops.length;
    const room = server.rooms.loaded(id)!;
    expect(room.stats.ops).toBe(300);
    expect(room.stats.batches).toBeLessThan(150);
    live.close();
  });

  it("shares presence between clients", async () => {
    const b = new Browser(server.base);
    await b.guest();
    const id = await b.sheet();
    const one = await b.live(id);
    const w = await one.next("welcome");
    const two = await b.live(id);
    const w2 = await two.next("welcome");
    expect(w2.peers.map((p) => p.client)).toContain(one.client);
    const { tab, row, col } = firstCell(w.state!);
    one.send({ type: "presence", tab, sel: [row, col, row, col], editing: true });
    const p = await two.next("presence", (m) => m.peer.client === one.client && m.peer.sel !== null);
    expect(p.peer.sel).toEqual([row, col, row, col]);
    expect(p.peer.editing).toBe(true);
    one.close();
    expect((await two.next("leave")).client).toBe(one.client);
    two.close();
  });

  it("restores an old version for everyone", async () => {
    const b = new Browser(server.base);
    await b.guest();
    const id = await b.sheet();
    const live = await b.live(id);
    const w = await live.next("welcome");
    live.op(set(w.state!, "keep me"));
    await live.next("ops");
    const named = await b.post(`/api/sheets/${id}/versions`, { name: "Before cleanup" });
    expect(named.status).toBe(200);
    live.op(set(w.state!, "oops"));
    await live.next("ops");
    const versions = (await b.get(`/api/sheets/${id}/versions`)).body.versions;
    const target = versions.find((v: { name: string | null }) => v.name === "Before cleanup");
    expect((await b.get(`/api/sheets/${id}/versions/${target.id}`)).body.state.tabs[0].cells[0][2]).toBe("keep me");
    expect((await b.post(`/api/sheets/${id}/versions/${target.id}/restore`)).status).toBe(200);
    const reset = await live.next("reset");
    expect(reset.state.tabs[0].cells[0][2]).toBe("keep me");
    live.op(set(w.state!, "after"));
    const after = await live.next("ops");
    expect(after.ops[0].seq).toBe(reset.seq + 1);
    live.close();
  });

  it("refuses connections from other sites", async () => {
    const b = new Browser(server.base);
    await b.guest();
    const id = await b.sheet();
    await expect(b.live(id, -1, randomId(10), "https://evil.example")).rejects.toThrow("403");
  });

  it("closes clients that flood the server", async () => {
    const small = await start("memory://", (c) => {
      c.rooms.messages_per_second = 20;
      c.rooms.message_burst = 30;
    });
    try {
      const b = new Browser(small.base);
      await b.guest();
      const id = await b.sheet();
      const live = await b.live(id);
      await live.next("welcome");
      for (let i = 0; i < 50; i++) live.send({ type: "presence", tab: null, sel: null, editing: false });
      expect((await live.closedWith()).code).toBe(1008);
    } finally {
      await stop(small);
    }
  });

  it("saves a version and unloads a room after everyone leaves", async () => {
    const b = new Browser(server.base);
    await b.guest();
    const id = await b.sheet();
    const live = await b.live(id);
    const w = await live.next("welcome");
    live.op(set(w.state!, "bye"));
    await live.next("ops");
    live.close();
    const deadline = Date.now() + 5000;
    while (server.rooms.loaded(id) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
    expect(server.rooms.loaded(id)).toBeUndefined();
    const versions = (await b.get(`/api/sheets/${id}/versions`)).body.versions;
    expect(versions[0]).toMatchObject({ kind: "auto", seq: 1 });
  });

  it("keeps edits across a server restart", async () => {
    const dir = DB_URL ? "memory://" : mkdtempSync(join(tmpdir(), "spreadsheet-"));
    let s = await start(dir);
    const b = new Browser(s.base);
    await b.guest();
    const id = await b.sheet();
    const live = await b.live(id);
    const w = await live.next("welcome");
    for (let i = 0; i < 10; i++) live.op(set(w.state!, `v${i}`, i));
    let seen = 0;
    while (seen < 10) seen += (await live.next("ops")).ops.length;
    live.close();
    await stop(s);
    s = await start(dir);
    try {
      b.base = s.base;
      const back = await b.live(id);
      const w2 = await back.next("welcome");
      expect(w2.seq).toBe(10);
      expect(w2.state!.tabs[0].cells.map((c) => c[2])).toEqual(Array.from({ length: 10 }, (_, i) => `v${i}`));
      back.close();
    } finally {
      await stop(s);
      if (!DB_URL) rmSync(dir, { recursive: true, force: true });
    }
  });
});
