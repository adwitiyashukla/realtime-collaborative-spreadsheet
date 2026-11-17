import { Calc } from "../shared/calc/engine.ts";
import { History, describe } from "../shared/history.ts";
import { randomId } from "../shared/ids.ts";
import { type Change, type Doc, type DocJSON, NO_LIMITS, type Op } from "../shared/model.ts";
import type { Peer, Role, ServerMessage, SheetLimits } from "../shared/protocol.ts";
import { Replica } from "../shared/sync.ts";

export type Status = "connecting" | "online" | "offline" | "closed";

const NOTICE_MS = 4000;
const RETRY_MS = 500;
const RETRY_MAX_MS = 10000;

export class LiveSheet {
  readonly id: string;
  replica: Replica | null = null;
  calc: Calc | null = null;
  history = new History();
  role: Role = "viewer";
  me: Peer | null = null;
  peers = new Map<string, Peer>();
  status: Status = "connecting";
  closedReason: string | null = null;
  notice: { text: string; at: number } | null = null;
  limits: SheetLimits = { ...NO_LIMITS, defaultRows: 1, defaultCols: 1 };
  version = 0;
  structure = 0;
  private listeners = new Set<() => void>();
  private ws: WebSocket | null = null;
  private client = randomId(12);
  private attempts = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private presenceTimer: ReturnType<typeof setTimeout> | null = null;
  private presenceState: { tab: string | null; sel: Peer["sel"]; editing: boolean } | null = null;
  private noticeTimer: ReturnType<typeof setTimeout> | null = null;
  private stopped = true;
  private local = false;

  constructor(id: string, local?: { state: DocJSON; limits: SheetLimits }) {
    this.id = id;
    if (local) {
      this.local = true;
      this.limits = local.limits;
      this.replica = new Replica(local.state, 0, this.client);
      this.calc = new Calc(this.replica.doc);
      this.calc.recalc();
      this.role = "editor";
      this.status = "online";
    }
  }

  start(): void {
    if (this.local || !this.stopped) return;
    this.stopped = false;
    window.addEventListener("online", this.wake);
    window.addEventListener("offline", this.drop);
    this.connect();
  }

  simulate(peer: Peer | null, client: string): void {
    if (peer) this.peers.set(client, peer);
    else this.peers.delete(client);
    this.emit();
  }

  get doc(): Doc | null {
    return this.replica?.doc ?? null;
  }

  get pending(): number {
    return this.replica?.pending.length ?? 0;
  }

  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };

  private emit(): void {
    this.version++;
    for (const fn of this.listeners) fn();
  }

  private wake = () => {
    if (this.status !== "offline" || this.stopped) return;
    if (this.timer) clearTimeout(this.timer);
    this.connect();
  };

  private drop = () => {
    const ws = this.ws;
    if (!ws) return;
    this.ws = null;
    ws.close();
    this.lost();
  };

  private connect(): void {
    if (this.stopped) return;
    this.timer = null;
    this.ws?.close();
    const scheme = location.protocol === "https:" ? "wss" : "ws";
    const ws = new WebSocket(`${scheme}://${location.host}/api/live/${this.id}`);
    this.ws = ws;
    ws.onopen = () => {
      if (this.ws === ws) ws.send(JSON.stringify({ type: "hello", client: this.client, seq: this.replica?.seq ?? -1 }));
    };
    ws.onmessage = (e) => {
      if (this.ws === ws) this.handle(JSON.parse(e.data as string) as ServerMessage);
    };
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.lost();
    };
  }

  private lost(): void {
    this.peers.clear();
    if (this.status === "closed" || this.stopped) return;
    this.status = "offline";
    const delay = Math.min(RETRY_MAX_MS, RETRY_MS * 2 ** this.attempts) * (0.75 + Math.random() * 0.5);
    this.attempts++;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => this.connect(), delay);
    this.emit();
  }

  private send(msg: unknown): void {
    if (this.ws?.readyState === WebSocket.OPEN && this.status === "online") this.ws.send(JSON.stringify(msg));
  }

  private changed(changes: Change[]): void {
    if (!this.calc || !this.replica) return;
    if (changes.some((c) => c.k === "axis" || c.k === "size" || c.k === "tabs")) this.structure++;
    this.calc.apply(changes);
    this.calc.seed = this.replica.seq;
    this.calc.recalc();
  }

  private handle(msg: ServerMessage): void {
    try {
      this.apply(msg);
    } catch {
      this.ws?.close();
    }
    this.emit();
  }

  private apply(msg: ServerMessage): void {
    switch (msg.type) {
      case "welcome": {
        this.role = msg.role;
        this.limits = msg.limits;
        this.me = msg.you;
        this.peers = new Map(msg.peers.filter((p) => p.client !== this.client).map((p) => [p.client, p]));
        if (msg.state) {
          if (!this.replica) {
            this.replica = new Replica(msg.state, msg.seq, this.client);
            this.calc = new Calc(this.replica.doc);
          } else {
            this.replica.reset(msg.state, msg.seq, msg.acked);
            this.calc!.setDoc(this.replica.doc);
          }
          this.calc!.seed = msg.seq;
          this.calc!.recalc();
          this.structure++;
        } else if (this.replica) {
          this.changed(this.replica.catchUp(msg.ops ?? [], msg.acked));
        }
        this.status = "online";
        this.attempts = 0;
        for (const p of this.replica!.pending) this.send({ type: "op", cseq: p.cseq, op: p.op });
        if (this.presenceState) this.send({ type: "presence", ...this.presenceState });
        break;
      }
      case "ops":
        if (this.replica) this.changed(this.replica.receive(msg.ops));
        break;
      case "reject":
        if (this.replica) {
          this.changed(this.replica.reject(msg.cseq));
          this.say(`A change could not be saved: ${msg.reason}`);
        }
        break;
      case "presence":
        if (msg.peer.client !== this.client) this.peers.set(msg.peer.client, msg.peer);
        break;
      case "leave":
        this.peers.delete(msg.client);
        break;
      case "reset":
        if (this.replica && this.calc) {
          this.replica.reset(msg.state, msg.seq, null);
          this.calc.setDoc(this.replica.doc);
          this.calc.seed = msg.seq;
          this.calc.recalc();
          this.history.clear();
          this.structure++;
          this.say(`${msg.by} restored an earlier version`);
        }
        break;
      case "role":
        this.role = msg.role;
        this.say(msg.role === "viewer" ? "You can now only view this sheet" : "You can now edit this sheet");
        break;
      case "closed":
        this.status = "closed";
        this.closedReason = msg.reason;
        break;
    }
  }

  say(text: string): void {
    this.notice = { text, at: Date.now() };
    if (this.noticeTimer) clearTimeout(this.noticeTimer);
    this.noticeTimer = setTimeout(() => {
      this.noticeTimer = null;
      this.notice = null;
      this.emit();
    }, NOTICE_MS);
    this.emit();
  }

  edit(ops: Op[], record = true): boolean {
    if (!this.replica || !this.calc || this.role === "viewer" || this.status === "closed") return false;
    const items = [];
    const changes: Change[] = [];
    for (const op of ops) {
      const item = record ? describe(this.replica.doc, op) : null;
      const res = this.replica.local(op);
      if (!res) continue;
      changes.push(...res.changes);
      if (item) items.push(item);
      if (this.local) {
        this.replica.pending = [];
        this.replica.seq++;
      } else this.send({ type: "op", cseq: res.cseq, op });
    }
    if (record) this.history.push(items);
    this.changed(changes);
    this.emit();
    return changes.length > 0;
  }

  undo(): boolean {
    if (!this.replica || this.role === "viewer") return false;
    const did = this.history.undo(this.replica.doc, (op) => this.edit([op], false));
    if (did) this.emit();
    return did;
  }

  redo(): boolean {
    if (!this.replica || this.role === "viewer") return false;
    const did = this.history.redo(this.replica.doc, (op) => this.edit([op], false));
    if (did) this.emit();
    return did;
  }

  presence(tab: string | null, sel: Peer["sel"], editing: boolean): void {
    this.presenceState = { tab, sel, editing };
    if (this.presenceTimer) return;
    this.presenceTimer = setTimeout(() => {
      this.presenceTimer = null;
      if (this.presenceState) this.send({ type: "presence", ...this.presenceState });
    }, 60);
  }

  close(): void {
    this.stopped = true;
    window.removeEventListener("online", this.wake);
    window.removeEventListener("offline", this.drop);
    if (this.timer) clearTimeout(this.timer);
    if (this.presenceTimer) clearTimeout(this.presenceTimer);
    if (this.noticeTimer) clearTimeout(this.noticeTimer);
    this.ws?.close();
    this.ws = null;
  }
}
