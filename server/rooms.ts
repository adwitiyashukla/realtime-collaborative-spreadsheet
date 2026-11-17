import type { RawData, WebSocket } from "ws";
import { Doc, type DocJSON, type Op, checkOp } from "../shared/model.ts";
import { type ClientMessage, type Peer, type Role, type ServerMessage, type SheetLimits, type User, clientMessages, colorFor } from "../shared/protocol.ts";
import type { Entry } from "../shared/sync.ts";
import type { Config } from "./config.ts";
import type { Store } from "./store.ts";

type Conn = {
  socket: WebSocket;
  user: User;
  role: Role;
  peer: Peer | null;
  joined: boolean;
  chain: Promise<void>;
  alive: boolean;
  tokens: number;
  refilled: number;
};

const OPEN = 1;
const MAX_BUFFERED = 16 * 1024 * 1024;

export class Room {
  readonly id: string;
  doc: Doc;
  seq: number;
  committed: number;
  log: Entry[];
  logStart: number;
  readonly conns = new Set<Conn>();
  readonly stats = { batches: 0, ops: 0 };
  idleTimer: NodeJS.Timeout | null = null;
  lastSnapshotAt = Date.now();
  sinceSnapshot: number;
  private rooms: Rooms;
  private queue: Entry[] = [];
  private flushing = false;
  private scheduled = false;
  private broken = false;
  private exclusive: Promise<void> | null = null;
  private waiters: (() => void)[] = [];
  private lastCseq = new Map<string, number>();
  private editors = new Set<string>();

  constructor(rooms: Rooms, id: string, doc: Doc, seq: number, logStart: number, log: Entry[]) {
    this.rooms = rooms;
    this.id = id;
    this.doc = doc;
    this.seq = seq;
    this.committed = seq;
    this.logStart = logStart;
    this.log = log;
    this.sinceSnapshot = log.length;
    this.trimLog();
  }

  static async load(rooms: Rooms, id: string): Promise<Room> {
    const base = await rooms.store.latestVersion(id);
    if (!base) throw new Error(`sheet ${id} not found`);
    const log = await rooms.store.opsAfter(id, base.seq);
    const doc = Doc.fromJSON(base.state);
    for (const e of log) doc.apply(e.op);
    const seq = log.length ? log[log.length - 1].seq : base.seq;
    return new Room(rooms, id, doc, seq, base.seq + 1, log);
  }

  isIdle(): boolean {
    return this.queue.length === 0 && !this.flushing && !this.scheduled;
  }

  idle(): Promise<void> {
    if (this.isIdle()) return Promise.resolve();
    return new Promise((resolve) => this.waiters.push(resolve));
  }

  private async settle(): Promise<void> {
    for (;;) {
      if (this.exclusive) await this.exclusive;
      else if (!this.isIdle()) await this.idle();
      else return;
    }
  }

  private async lock(fn: () => Promise<void>): Promise<void> {
    while (this.exclusive) await this.exclusive;
    let release = () => {};
    this.exclusive = new Promise((r) => (release = r));
    try {
      await fn();
    } finally {
      this.exclusive = null;
      release();
    }
  }

  attach(socket: WebSocket, user: User, role: Role, early: [RawData, boolean][] = []): void {
    const { messages_per_second: rate, message_burst: burst } = this.rooms.config.rooms;
    const conn: Conn = { socket, user, role, peer: null, joined: false, chain: Promise.resolve(), alive: true, tokens: burst, refilled: Date.now() };
    this.conns.add(conn);
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
    const onMessage = (data: RawData, binary: boolean) => {
      const now = Date.now();
      conn.tokens = Math.min(burst, conn.tokens + ((now - conn.refilled) / 1000) * rate);
      conn.refilled = now;
      if (binary || conn.tokens < 1) {
        socket.close(1008, binary ? "Binary messages are not supported" : "Too many messages");
        return;
      }
      conn.tokens -= 1;
      let msg: ClientMessage;
      try {
        msg = this.rooms.messages.parse(JSON.parse(data.toString()));
      } catch {
        socket.close(1007, "Bad message");
        return;
      }
      conn.chain = conn.chain.then(() => this.handle(conn, msg)).catch((e) => this.rooms.log(e));
    };
    socket.on("message", onMessage);
    for (const [data, binary] of early) onMessage(data, binary);
    socket.on("pong", () => {
      conn.alive = true;
    });
    socket.on("close", () => this.detach(conn));
    socket.on("error", () => socket.terminate());
    if (this.broken) socket.close(1011, "Please reconnect");
    if (socket.readyState !== OPEN) this.detach(conn);
  }

  private detach(conn: Conn): void {
    if (!this.conns.delete(conn)) return;
    if (conn.joined && conn.peer) this.broadcast({ type: "leave", client: conn.peer.client });
    if (this.conns.size === 0 && !this.idleTimer) {
      this.idleTimer = setTimeout(() => void this.rooms.unload(this), this.rooms.config.rooms.idle_unload_seconds * 1000);
      this.idleTimer.unref();
    }
  }

  private async handle(conn: Conn, msg: ClientMessage): Promise<void> {
    if (this.exclusive) await this.exclusive;
    if (this.broken) return;
    if (msg.type === "hello") await this.hello(conn, msg.client, msg.seq);
    else if (msg.type === "op") this.op(conn, msg.cseq, msg.op as Op);
    else this.presence(conn, msg.tab, msg.sel, msg.editing);
  }

  private async hello(conn: Conn, client: string, seq: number): Promise<void> {
    if (conn.joined || conn.peer) return;
    conn.peer = { client, user: conn.user.id, name: conn.user.name, color: colorFor(conn.user.id), tab: null, sel: null, editing: false };
    if (!this.lastCseq.has(client)) this.lastCseq.set(client, await this.rooms.store.maxCseq(this.id, client));
    await this.settle();
    if (this.broken || !this.conns.has(conn)) return;
    const peers = [...this.conns].filter((c) => c.joined && c.peer).map((c) => c.peer!);
    const welcome: Extract<ServerMessage, { type: "welcome" }> = {
      type: "welcome",
      seq: this.committed,
      acked: this.lastCseq.get(client) ?? 0,
      role: conn.role,
      you: conn.peer,
      peers,
      limits: this.rooms.limits,
    };
    if (seq >= 0 && seq + 1 >= this.logStart && seq <= this.committed) welcome.ops = this.log.slice(seq + 1 - this.logStart);
    else welcome.state = this.doc.toJSON();
    this.send(conn, welcome);
    conn.joined = true;
    this.broadcast({ type: "presence", peer: conn.peer }, conn);
    this.rooms.store.touchOpen(this.id, conn.user.id).catch((e) => this.rooms.log(e));
  }

  private op(conn: Conn, cseq: number, op: Op): void {
    if (!conn.joined || !conn.peer) return;
    const client = conn.peer.client;
    if (cseq <= (this.lastCseq.get(client) ?? 0)) return;
    this.lastCseq.set(client, cseq);
    if (conn.role === "viewer") {
      this.send(conn, { type: "reject", cseq, reason: "You can only view this sheet" });
      return;
    }
    const reason = checkOp(this.doc, op, this.rooms.limits);
    if (reason) {
      this.send(conn, { type: "reject", cseq, reason });
      return;
    }
    try {
      this.doc.apply(op);
    } catch (e) {
      this.rooms.log(e);
      this.send(conn, { type: "reject", cseq, reason: "This change could not be applied" });
      return;
    }
    this.queue.push({ seq: ++this.seq, client, cseq, user: conn.user.id, op });
    this.editors.add(conn.user.id);
    this.schedule();
  }

  private presence(conn: Conn, tab: string | null, sel: Peer["sel"], editing: boolean): void {
    if (!conn.joined || !conn.peer) return;
    conn.peer.tab = tab;
    conn.peer.sel = sel;
    conn.peer.editing = editing;
    this.broadcast({ type: "presence", peer: conn.peer }, conn);
  }

  private schedule(): void {
    if (this.scheduled || this.flushing) return;
    this.scheduled = true;
    setImmediate(() => {
      this.scheduled = false;
      void this.flush();
    });
  }

  private trimLog(): void {
    const extra = this.log.length - this.rooms.config.rooms.catchup_ops;
    if (extra > 0) {
      this.log.splice(0, extra);
      this.logStart += extra;
    }
  }

  private async flush(): Promise<void> {
    if (this.flushing || this.broken) return;
    this.flushing = true;
    try {
      while (this.queue.length) {
        const batch = this.queue.splice(0, this.rooms.config.rooms.max_batch);
        let title: string | null = null;
        for (const e of batch) if (e.op.t === "title") title = e.op.title;
        await this.rooms.store.appendOps(this.id, batch, title);
        this.committed = batch[batch.length - 1].seq;
        for (const e of batch) this.log.push(e);
        this.trimLog();
        this.sinceSnapshot += batch.length;
        this.stats.batches++;
        this.stats.ops += batch.length;
        this.broadcast({ type: "ops", ops: batch });
      }
    } catch (e) {
      this.fail(e);
    } finally {
      this.flushing = false;
      if (this.isIdle()) {
        const waiters = this.waiters;
        this.waiters = [];
        for (const w of waiters) w();
      }
    }
    if (!this.broken && this.sinceSnapshot >= this.rooms.config.rooms.snapshot_every_ops) {
      this.snapshot("auto").catch((e) => this.rooms.log(e));
    }
  }

  private fail(e: unknown): void {
    this.rooms.log(e);
    this.broken = true;
    for (const c of this.conns) c.socket.close(1011, "Please reconnect");
    this.rooms.forget(this);
    const waiters = this.waiters;
    this.waiters = [];
    for (const w of waiters) w();
  }

  async snapshot(kind: string, name: string | null = null, by: string | null = null): Promise<number | null> {
    await this.settle();
    if (this.broken) return null;
    const state = this.doc.toJSON();
    const seq = this.committed;
    const editors = [...this.editors];
    if (by && !editors.includes(by)) editors.push(by);
    this.editors.clear();
    this.sinceSnapshot = 0;
    this.lastSnapshotAt = Date.now();
    return await this.rooms.store.insertVersion({ sheetId: this.id, seq, kind, name, state, editors, createdBy: by });
  }

  async restore(state: DocJSON, user: User): Promise<void> {
    await this.lock(async () => {
      while (!this.isIdle()) await this.idle();
      if (this.broken) throw new Error("room is closed");
      const seq = this.committed + 1;
      await this.rooms.store.insertVersion({ sheetId: this.id, seq, kind: "restore", name: null, state, editors: [user.id], createdBy: user.id }, true);
      this.doc = Doc.fromJSON(state);
      this.seq = seq;
      this.committed = seq;
      this.log = [];
      this.logStart = seq + 1;
      this.sinceSnapshot = 0;
      this.editors.clear();
      this.lastSnapshotAt = Date.now();
      this.broadcast({ type: "reset", seq, state, by: user.name });
    });
  }

  async copyState(): Promise<{ state: DocJSON; seq: number }> {
    await this.settle();
    return { state: this.doc.toJSON(), seq: this.committed };
  }

  setRole(conn: Conn, role: Role | null): void {
    if (!role) {
      this.send(conn, { type: "closed", reason: "Your access to this sheet was removed" });
      conn.socket.close(4003, "Access removed");
      return;
    }
    if (role === conn.role) return;
    conn.role = role;
    if (conn.peer) this.send(conn, { type: "role", role });
  }

  shutdown(reason: string, code: number): void {
    this.broken = true;
    for (const c of this.conns) {
      this.send(c, { type: "closed", reason });
      c.socket.close(code, reason.slice(0, 120));
    }
    if (this.idleTimer) clearTimeout(this.idleTimer);
  }

  heartbeat(): void {
    for (const c of this.conns) {
      if (!c.alive) {
        c.socket.terminate();
        continue;
      }
      c.alive = false;
      try {
        c.socket.ping();
      } catch {
        c.socket.terminate();
      }
    }
  }

  private send(conn: Conn, msg: ServerMessage): void {
    this.sendRaw(conn, JSON.stringify(msg));
  }

  private sendRaw(conn: Conn, data: string): void {
    if (conn.socket.readyState !== OPEN) return;
    if (conn.socket.bufferedAmount > MAX_BUFFERED) {
      conn.socket.terminate();
      return;
    }
    conn.socket.send(data);
  }

  private broadcast(msg: ServerMessage, except?: Conn): void {
    const data = JSON.stringify(msg);
    for (const c of this.conns) if (c.joined && c !== except) this.sendRaw(c, data);
  }
}

export class Rooms {
  readonly store: Store;
  readonly config: Config;
  readonly limits: SheetLimits;
  readonly messages: ReturnType<typeof clientMessages>;
  readonly log: (e: unknown) => void;
  private rooms = new Map<string, Promise<Room>>();
  private ready = new Map<string, Room>();
  private timer: NodeJS.Timeout;

  constructor(store: Store, config: Config, log: (e: unknown) => void) {
    this.store = store;
    this.config = config;
    this.log = log;
    this.limits = {
      maxRows: config.limits.max_rows,
      maxCols: config.limits.max_cols,
      maxTabs: config.limits.max_tabs,
      maxCellChars: config.limits.max_cell_chars,
      maxCellsPerOp: config.limits.max_cells_per_op,
      defaultRows: config.limits.default_rows,
      defaultCols: config.limits.default_cols,
    };
    this.messages = clientMessages(this.limits);
    this.timer = setInterval(() => this.tick(), config.rooms.heartbeat_seconds * 1000);
    this.timer.unref();
  }

  get(id: string): Promise<Room> {
    let p = this.rooms.get(id);
    if (!p) {
      p = Room.load(this, id).then((room) => {
        this.ready.set(id, room);
        return room;
      });
      this.rooms.set(id, p);
      p.catch(() => {
        if (this.rooms.get(id) === p) this.rooms.delete(id);
      });
    }
    return p;
  }

  loaded(id: string): Room | undefined {
    return this.ready.get(id);
  }

  connect(id: string, socket: WebSocket, user: User, role: Role): void {
    const early: [RawData, boolean][] = [];
    const hold = (data: RawData, binary: boolean) => early.push([data, binary]);
    socket.on("message", hold);
    this.get(id).then(
      (room) => {
        socket.off("message", hold);
        room.attach(socket, user, role, early);
      },
      (e) => {
        this.log(e);
        socket.close(1011, "Could not open this sheet");
      },
    );
  }

  async snapshot(id: string, kind: string, name: string | null, by: string): Promise<number | null> {
    const room = this.ready.get(id);
    if (room) return room.snapshot(kind, name, by);
    const current = await this.state(id);
    if (!current) return null;
    return this.store.insertVersion({ sheetId: id, seq: current.seq, kind, name, state: current.state, editors: [by], createdBy: by });
  }

  async restore(id: string, state: DocJSON, user: User): Promise<void> {
    const room = await this.get(id);
    await room.restore(state, user);
    if (room.conns.size === 0) await this.unload(room);
  }

  forget(room: Room): void {
    if (this.ready.get(room.id) === room) {
      this.ready.delete(room.id);
      this.rooms.delete(room.id);
    }
  }

  async unload(room: Room): Promise<void> {
    if (room.conns.size > 0 || this.ready.get(room.id) !== room) return;
    this.forget(room);
    if (room.sinceSnapshot > 0) await room.snapshot("auto");
  }

  async state(id: string): Promise<{ state: DocJSON; seq: number } | null> {
    const room = this.ready.get(id);
    if (room) return room.copyState();
    const base = await this.store.latestVersion(id);
    if (!base) return null;
    const log = await this.store.opsAfter(id, base.seq);
    const doc = Doc.fromJSON(base.state);
    for (const e of log) doc.apply(e.op);
    return { state: doc.toJSON(), seq: log.length ? log[log.length - 1].seq : base.seq };
  }

  async refreshRoles(id: string, userId?: string): Promise<void> {
    const room = this.ready.get(id);
    if (!room) return;
    for (const conn of [...room.conns]) {
      if (userId && conn.user.id !== userId) continue;
      room.setRole(conn, await this.store.roleOf(id, conn.user.id));
    }
  }

  close(id: string, reason: string): void {
    const room = this.ready.get(id);
    if (!room) return;
    this.forget(room);
    room.shutdown(reason, 4004);
  }

  private tick(): void {
    const due = Date.now() - this.config.rooms.snapshot_every_seconds * 1000;
    for (const room of this.ready.values()) {
      room.heartbeat();
      if (room.sinceSnapshot > 0 && room.lastSnapshotAt < due) room.snapshot("auto").catch((e) => this.log(e));
    }
  }

  async closeAll(): Promise<void> {
    clearInterval(this.timer);
    for (const room of [...this.ready.values()]) {
      this.forget(room);
      try {
        if (room.sinceSnapshot > 0) await room.snapshot("auto");
      } catch (e) {
        this.log(e);
      }
      room.shutdown("The server is restarting", 1012);
    }
  }
}
