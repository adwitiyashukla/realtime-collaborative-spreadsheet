import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { idMaker } from "./ids.ts";
import { Doc, type DocJSON, type Op, checkOp, newDoc } from "./model.ts";
import { type Entry, Replica } from "./sync.ts";
import { LIMITS, randomOp, rng } from "./testkit.ts";

type Down = { type: "ops"; ops: Entry[] } | { type: "reject"; cseq: number } | { type: "reset"; state: DocJSON; seq: number };

class FakeServer {
  doc: Doc;
  seq = 0;
  log: Entry[] = [];
  logStart = 1;
  last = new Map<string, number>();

  rnd: () => number;

  constructor(doc: Doc, rnd: () => number) {
    this.doc = doc;
    this.rnd = rnd;
  }

  submit(client: string, cseq: number, op: Op): Entry | string | null {
    if (cseq <= (this.last.get(client) ?? 0)) return null;
    this.last.set(client, cseq);
    const reason = this.rnd() < 0.08 ? "rate limited" : checkOp(this.doc, op, LIMITS);
    if (reason) return reason;
    this.doc.apply(op);
    const entry: Entry = { seq: ++this.seq, client, cseq, user: client, op };
    this.log.push(entry);
    return entry;
  }

  restore(state: DocJSON): void {
    this.doc = Doc.fromJSON(state);
    this.seq += 1;
    this.log = [];
    this.logStart = this.seq + 1;
  }
}

class Client {
  replica: Replica;
  up: { cseq: number; op: Op }[] = [];
  down: Down[] = [];
  online = true;
  next: () => string;

  constructor(state: DocJSON, name: string) {
    this.replica = new Replica(state, 0, name);
    this.next = idMaker(name);
  }
}

type Action = { kind: "edit" | "up" | "down" | "drop" | "join" | "restore"; who: number };

const action: fc.Arbitrary<Action> = fc.record({
  kind: fc.constantFrom<Action["kind"]>("edit", "edit", "edit", "up", "up", "up", "down", "down", "down", "drop", "join", "restore"),
  who: fc.integer({ min: 0, max: 2 }),
});

function run(seed: number, actions: Action[]): { server: FakeServer; clients: Client[] } {
  const start = newDoc(4, 4, idMaker("base"));
  const rnd = rng(seed);
  const server = new FakeServer(Doc.fromJSON(start.toJSON()), rnd);
  const clients = ["alice1", "bobby2", "carol3"].map((n) => new Client(start.toJSON(), n));
  const snapshots: DocJSON[] = [start.toJSON()];

  const upload = (c: Client) => {
    const msg = c.up.shift();
    if (!msg || !c.online) return;
    const result = server.submit(c.replica.client, msg.cseq, msg.op);
    if (result === null) return;
    if (typeof result === "string") {
      c.down.push({ type: "reject", cseq: msg.cseq });
      return;
    }
    for (const other of clients) if (other.online) other.down.push({ type: "ops", ops: [result] });
    if (rnd() < 0.1) snapshots.push(server.doc.toJSON());
  };

  const deliver = (c: Client) => {
    const msg = c.down.shift();
    if (!msg) return;
    if (msg.type === "ops") c.replica.receive(msg.ops);
    else if (msg.type === "reject") c.replica.reject(msg.cseq);
    else c.replica.reset(msg.state, msg.seq, null);
  };

  const join = (c: Client) => {
    c.online = true;
    c.up = [];
    c.down = [];
    const acked = server.last.get(c.replica.client) ?? 0;
    if (c.replica.seq + 1 >= server.logStart) {
      c.replica.catchUp(server.log.filter((e) => e.seq > c.replica.seq), acked);
    } else {
      c.replica.reset(server.doc.toJSON(), server.seq, acked);
    }
    for (const p of c.replica.pending) c.up.push({ cseq: p.cseq, op: p.op });
  };

  for (const a of actions) {
    const c = clients[a.who];
    switch (a.kind) {
      case "edit": {
        const op = randomOp(c.replica.doc, rnd, c.next);
        if (checkOp(c.replica.doc, op, LIMITS)) break;
        const { cseq } = c.replica.local(op)!;
        if (c.online) c.up.push({ cseq, op });
        break;
      }
      case "up":
        upload(c);
        break;
      case "down":
        deliver(c);
        break;
      case "drop":
        c.online = false;
        c.up = [];
        c.down = [];
        break;
      case "join":
        if (!c.online) join(c);
        break;
      case "restore": {
        if (rnd() > 0.15) break;
        const state = snapshots[Math.floor(rnd() * snapshots.length)];
        server.restore(state);
        for (const other of clients) if (other.online) other.down.push({ type: "reset", state, seq: server.seq });
        break;
      }
    }
  }

  for (const c of clients) if (!c.online) join(c);
  for (let guard = 0; guard < 10000; guard++) {
    const busy = clients.filter((c) => c.up.length || c.down.length);
    if (!busy.length) break;
    for (const c of busy) {
      if (c.up.length) upload(c);
      if (c.down.length) deliver(c);
    }
  }
  return { server, clients };
}

describe("replicas", () => {
  it("converge to the server state under any delivery order", () => {
    fc.assert(
      fc.property(fc.integer(), fc.array(action, { minLength: 1, maxLength: 150 }), (seed, actions) => {
        const { server, clients } = run(seed, actions);
        const want = JSON.stringify(server.doc.toJSON());
        for (const c of clients) {
          expect(c.replica.pending).toEqual([]);
          expect(c.replica.seq).toBe(server.seq);
          expect(JSON.stringify(c.replica.doc.toJSON())).toBe(want);
        }
      }),
      { numRuns: 400 },
    );
  });

  it("keeps a local edit visible until the server confirms it", () => {
    const start = newDoc(2, 2, idMaker("x")).toJSON();
    const r = new Replica(start, 0, "me1234");
    const tab = r.doc.liveTabs()[0];
    const [row] = tab.rows.live;
    const [col] = tab.cols.live;
    const { cseq } = r.local({ t: "set", tab: tab.id, cells: [[row, col, "mine"]] })!;
    r.receive([{ seq: 1, client: "other1", cseq: 1, user: "u", op: { t: "set", tab: tab.id, cells: [[row, col, "theirs"]] } }]);
    expect(tab.input(row, col)).toBe("mine");
    r.receive([{ seq: 2, client: "me1234", cseq, user: "u", op: { t: "set", tab: tab.id, cells: [[row, col, "mine"]] } }]);
    expect(r.pending).toEqual([]);
    expect(r.doc.liveTabs()[0].input(row, col)).toBe("mine");
  });

  it("drops an edit the server rejects", () => {
    const start = newDoc(2, 2, idMaker("y")).toJSON();
    const r = new Replica(start, 0, "me1234");
    const tab = r.doc.liveTabs()[0];
    const [row] = tab.rows.live;
    const [col] = tab.cols.live;
    const { cseq } = r.local({ t: "set", tab: tab.id, cells: [[row, col, "x"]] })!;
    r.reject(cseq);
    expect(r.doc.liveTabs()[0].input(row, col)).toBeNull();
  });

  it("refuses to skip over missing ops", () => {
    const r = new Replica(newDoc(1, 1, idMaker("z")).toJSON(), 0, "me1234");
    expect(() => r.receive([{ seq: 2, client: "a", cseq: 1, user: "u", op: { t: "title", title: "x" } }])).toThrow();
  });
});
